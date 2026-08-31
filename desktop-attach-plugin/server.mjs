import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAssistantTextFromRollout } from "./rollout-reader.mjs";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_CHARS = 512 * 1024;
const MAX_IPC_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 1024 * 1024;
const MAX_WAIT_CURSOR_CHARS = 2048;
const MAX_THREAD_CURSOR_CHARS = 4096;
const MAX_WAIT_TIMEOUT_MS = 8_000;
const NEW_THREAD_VERIFY_TIMEOUT_MS = 8_000;
const MAX_DESKTOP_ITEM_CHARS = 20_000;
const MAX_BRIDGE_CONNECTIONS = 4;
const MAX_BRIDGE_QUEUED_REQUESTS = 8;
const MAX_NATIVE_PENDING_REQUESTS = 16;
const PIPE_ENV = "CODEX_APP_TOOLS_PIPE_PATH";
const BRIDGE_HOST_PIPE_ENV = "AGENT_POCKET_DESKTOP_HOST_PIPE";
const DEFAULT_BRIDGE_HOST_PIPE = "\\\\.\\pipe\\agent-pocket-desktop-attach-host";
const BRIDGE_HOST_START_TIMEOUT_MS = 5_000;
const BRIDGE_HOST_RPC_TIMEOUT_MS = 2_000;
const IPC_PROTOCOL_VERSION = 1;
const BRIDGE_HOST_MODE = process.argv.includes("--bridge-host");
const SERVER_PATH = fileURLToPath(import.meta.url);
const BRIDGE_CAPABILITIES = ["attach/probe", "project/list", "thread/list", "thread/read", "thread/create", "thread/send", "thread/wait"];
const DESKTOP_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

let host;
let bridgeIpcServer;
let bridgeRegistration;
let bridgeIpcStarting;
let bridgeHostStarting;
let externalBridgeHostReady = false;
let desktopHostThreadId = firstString(process.env.CODEX_THREAD_ID, process.env.CODEX_SESSION_ID);
let bridgeConnectionCount = 0;
let stdinBuffer = "";
let shuttingDown = false;

if (!BRIDGE_HOST_MODE) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdinBuffer += chunk;
    while (true) {
      const newline = stdinBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdinBuffer.slice(0, newline).replace(/\r$/, "");
      stdinBuffer = stdinBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      void handleLine(line);
    }
  });
  process.stdin.once("end", shutdown);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return writeError(null, -32700, "Invalid JSON");
  }

  if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return writeError(message?.id ?? null, -32600, "Invalid JSON-RPC request");
  }

  if (message.method.startsWith("notifications/")) return;
  if (message.id === undefined) return;

  try {
    switch (message.method) {
      case "initialize":
        return writeResult(message.id, {
          protocolVersion: message.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: {
            name: "agent-pocket-desktop-attach",
            title: "Agent Pocket Desktop Attach",
            version: "0.1.5",
          },
          instructions: "Local Agent Pocket adapter. Its user-facing MCP tools are read-only; authenticated local Bridge IPC may list projects and create, read, or continue Codex Desktop tasks.",
        });
      case "ping":
        return writeResult(message.id, {});
      case "tools/list":
        return writeResult(message.id, { tools: toolDefinitions });
      case "tools/call":
        return writeResult(message.id, await callTool(message));
      default:
        return writeError(message.id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return writeResult(message.id, {
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: text }) }],
      isError: true,
    });
  }
}

const toolDefinitions = [
  {
    name: "desktop_attach_probe",
    title: "Probe Codex Desktop attachment",
    description: "Read-only: verify access to the running Codex Desktop task channel and report its available task capabilities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "desktop_attach_list_tasks",
    title: "List Codex Desktop tasks",
    description: "Read-only: list recent tasks from the running Codex Desktop host.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "desktop_attach_read_task",
    title: "Read a Codex Desktop task",
    description: "Read-only: read recent turns from one task owned by the running Codex Desktop host.",
    inputSchema: {
      type: "object",
      required: ["threadId"],
      properties: {
        threadId: { type: "string", minLength: 1, maxLength: 128 },
        turnLimit: { type: "integer", minimum: 1, maximum: 10, default: 10 },
        cursor: { type: "string", minLength: 1, maxLength: MAX_THREAD_CURSOR_CHARS },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(message) {
  const name = message.params?.name;
  const args = message.params?.arguments || {};
  const context = requestContext(message);
  if (context.threadId) {
    if (!desktopHostThreadId) desktopHostThreadId = context.threadId;
    await ensureBridgeHost();
  }

  if (name === "desktop_attach_probe") {
    return textResult(await probeDesktop(context));
  }

  if (name === "desktop_attach_list_tasks") {
    const limit = boundedInteger(args.limit, 10, 1, 50);
    const result = await listDesktopTasks(limit, context);
    return textResult({ ok: true, result });
  }

  if (name === "desktop_attach_read_task") {
    if (typeof args.threadId !== "string" || !args.threadId.trim() || args.threadId.length > 128) {
      throw new Error("threadId is required");
    }
    const turnLimit = boundedInteger(args.turnLimit, 10, 1, 10);
    const cursor = optionalTrimmedString(args.cursor, "cursor", MAX_THREAD_CURSOR_CHARS);
    const result = await readDesktopTask(args.threadId.trim(), turnLimit, cursor, context);
    return textResult({ ok: true, result });
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function probeDesktop(context) {
  const desktopPipeAvailable = Boolean(process.env[PIPE_ENV]?.trim());
  if (!desktopPipeAvailable) {
    return {
      ok: true,
      mode: "not-desktop-host",
      desktopPipeAvailable: false,
      callerContextAvailable: Boolean(context.threadId),
      ipcAvailable: false,
      bridgeWritable: false,
      available: [],
      error: "This plugin instance was not started by Codex Desktop; open a new task in the Windows Codex Desktop app.",
    };
  }
  const catalog = await host.request("tools/list", { threadStartKind: "all" });
  const interesting = new Set([
    "list_threads",
    "read_thread",
    "send_message_to_thread",
    "wait_threads",
    "list_projects",
    "create_thread",
    "navigate_to_codex_page",
    "automation_update",
  ]);
  const available = (catalog?.tools || [])
    .filter((tool) => interesting.has(tool.name))
    .map((tool) => ({ name: tool.name, namespace: tool.namespace }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: true,
    mode: "desktop-attach",
    desktopPipeAvailable,
    callerContextAvailable: Boolean(context.threadId),
    ipcAvailable: Boolean(bridgeRegistration || externalBridgeHostReady),
    bridgeWritable: bridgeRegistration?.readOnly === false || externalBridgeHostReady,
    available,
  };
}

async function listDesktopTasks(limit, context) {
  return callDesktopTool("list_threads", { limit }, context);
}

function listDesktopProjects(context) {
  return callDesktopTool("list_projects", {}, context);
}

function readDesktopTask(threadId, turnLimit, cursor, context) {
  const args = { threadId, turnLimit, includeOutputs: false, maxOutputCharsPerItem: MAX_DESKTOP_ITEM_CHARS };
  if (cursor) args.cursor = cursor;
  return callDesktopTool(
    "read_thread",
    args,
    context,
  );
}

function sendDesktopMessage(threadId, text, context) {
  return callDesktopTool("send_message_to_thread", { threadId, prompt: text }, context);
}

async function createDesktopThread(cwd, text, model, effort, workspaceMode, context) {
  if (workspaceMode !== "local") {
    throw new Error("workspaceMode must be local for Codex Desktop task creation");
  }
  const requestedPath = canonicalDesktopPath(cwd, "cwd");
  const projectItems = await callDesktopTool("list_projects", {}, subcallContext(context, "projects"));
  const projectPayload = desktopToolJson(projectItems, "list_projects");
  const projects = Array.isArray(projectPayload?.projects) ? projectPayload.projects : [];
  const project = projects.find((item) => {
    if (item?.projectKind !== "local" || typeof item.projectId !== "string" || !item.projectId.trim()) return false;
    try {
      return canonicalDesktopPath(item.path, "Desktop project path").key === requestedPath.key;
    } catch {
      return false;
    }
  });
  if (!project) {
    throw new Error("cwd is not saved as a local Codex Desktop project");
  }

  const args = {
    prompt: text,
    target: {
      type: "project",
      projectId: project.projectId.trim(),
      environment: { type: "local" },
    },
  };
  if (model) args.model = model;
  if (effort) args.thinking = effort;
  const createdItems = await callDesktopTool("create_thread", args, subcallContext(context, "create"));
  const created = desktopToolJson(createdItems, "create_thread");
  const threadId = firstString(created?.threadId);
  if (!threadId && firstString(created?.clientThreadId)) {
    throw new Error("Codex Desktop is still preparing the new task; retry after it appears in Desktop");
  }
  if (!threadId) throw new Error("Codex Desktop create_thread returned no threadId");

  const verification = await waitDesktopThread(
    threadId,
    undefined,
    NEW_THREAD_VERIFY_TIMEOUT_MS,
    subcallContext(context, "create-verify"),
  );
  if (verification.threadStatus === "systemError" || verification.turnStatus === "failed") {
    const detail = verification.turnError ? `: ${verification.turnError}` : "";
    throw new Error(`Codex Desktop created the task but failed to initialize it${detail}`);
  }

  return {
    source: "desktop",
    hostId: firstString(created?.hostId),
    thread: {
      id: threadId,
      name: text.trim().split(/\r?\n/, 1)[0]?.slice(0, 80) || "新任务",
      cwd: requestedPath.actual,
      source: "desktop",
      status: { type: "active", desktopState: "running" },
      capabilities: { send: true, interrupt: false, approval: false, question: false },
    },
  };
}

async function waitDesktopThread(threadId, afterCursor, timeoutMs, context) {
  const waitContext = await desktopWaitContext(threadId, context);
  const target = { threadId };
  if (afterCursor) target.afterCursor = afterCursor;
  const contentItems = await callDesktopTool("wait_threads", {
    targets: [target],
    timeoutMs,
  }, waitContext);
  const payload = desktopToolJson(contentItems, "wait_threads");
  const poll = Array.isArray(payload?.polls)
    ? payload.polls.find((item) => item?.threadId === threadId) || payload.polls[0]
    : null;
  const wake = payload?.wake && typeof payload.wake === "object" ? payload.wake : null;
  const threadStatus = firstString(poll?.thread?.status?.type, poll?.thread?.status);
  const turnStatus = firstString(poll?.latestTurn?.status?.type, poll?.latestTurn?.status);
  const latestAssistantMessage = poll?.latestAssistantMessage && typeof poll.latestAssistantMessage === "object"
    ? poll.latestAssistantMessage
    : poll?.latestTurn?.latestAssistantMessage;
  let fullAssistantText = typeof latestAssistantMessage?.text === "string"
    ? latestAssistantMessage.text
    : undefined;
  const turnId = firstString(wake?.turnId, poll?.latestTurn?.id);
  if (!fullAssistantText && turnId && ["completed", "failed", "cancelled", "interrupted"].includes(turnStatus)) {
    for (let attempt = 0; attempt < 4 && !fullAssistantText; attempt += 1) {
      if (attempt > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      fullAssistantText = readAssistantTextFromRollout({
        threadId,
        turnId,
        maxChars: MAX_DESKTOP_ITEM_CHARS,
      });
    }
  }
  return {
    cursor: firstString(poll?.cursor),
    changed: poll?.changed === true,
    threadStatus,
    turnId,
    turnStatus,
    wakeReason: firstString(wake?.reason),
    timedOut: payload?.timedOut === true,
    assistantText: fullAssistantText?.slice(0, MAX_DESKTOP_ITEM_CHARS),
    assistantTextTruncated: fullAssistantText !== undefined && fullAssistantText.length > MAX_DESKTOP_ITEM_CHARS,
    turnError: firstString(poll?.latestTurn?.error?.message, poll?.latestTurn?.error),
  };
}

async function desktopWaitContext(threadId, context) {
  if (context.threadId !== threadId) return context;
  const contentItems = await callDesktopTool(
    "list_threads",
    { limit: 50 },
    subcallContext(context, "wait-caller-list"),
  );
  const payload = desktopToolJson(contentItems, "list_threads");
  const candidates = [
    ...(Array.isArray(payload?.pinnedThreads) ? payload.pinnedThreads : []),
    ...(Array.isArray(payload?.threads) ? payload.threads : []),
  ].filter((item) => item?.kind === "codex" && typeof item.id === "string" && item.id.trim() && item.id.trim() !== threadId);
  const candidate = candidates.find((item) => {
    const status = firstString(item?.status?.type, item?.status);
    return status !== "active" && status !== "running";
  }) || candidates[0];
  if (!candidate) throw new Error("Desktop wait requires another Codex task as its caller context");
  return {
    ...context,
    threadId: candidate.id.trim(),
    callId: `desktop-attach-wait-caller-${randomUUID()}`,
  };
}

function desktopToolJson(contentItems, context) {
  const text = Array.isArray(contentItems)
    ? contentItems.find((item) => item?.type === "inputText" && typeof item.text === "string")?.text
    : null;
  if (!text) throw new Error(`Desktop ${context} returned no JSON summary`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Desktop ${context} returned an incompatible summary`);
  }
}

async function callDesktopTool(name, args, context) {
  if (!context.threadId) {
    throw new Error("Codex Desktop did not provide a caller thread id");
  }
  const catalog = await host.request("tools/list", { threadStartKind: "all" });
  const tool = (catalog?.tools || []).find((item) => item.name === name);
  if (!tool) throw new Error(`Desktop tool is unavailable: ${name}`);

  const response = await host.request("tools/call", {
    arguments: args,
    callId: context.callId,
    namespace: tool.namespace,
    threadId: context.threadId,
    tool: name,
    turnId: context.turnId,
  });
  if (!response?.success) {
    const details = (response?.contentItems || [])
      .filter((item) => item.type === "inputText")
      .map((item) => item.text)
      .join("\n");
    throw new Error(desktopToolFailure(name, details));
  }
  return response.contentItems || [];
}

function desktopToolFailure(name, details) {
  const text = typeof details === "string" ? details : "";
  if (/writer|lock|already active|another (?:application|app)|另一应用|正在运行|正在使用/i.test(text)) {
    return "Desktop task is already active in another writer";
  }
  if (/not found|does not exist|不存在|找不到/i.test(text)) {
    return "Desktop task was not found";
  }
  if (/permission|forbidden|not allowed|无权|拒绝访问/i.test(text)) {
    return "Desktop task cannot be accessed from this host";
  }
  if (/function_call_output requires call_id|previous_response_id.{0,80}WebSocket v2/i.test(text)) {
    return "function_call_output requires call_id on HTTP requests; continuation via previous_response_id is only supported on Responses WebSocket v2";
  }
  const compact = text
    .replace(/<codex_delegation>[\s\S]*<\/codex_delegation>/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return compact ? `Desktop tool failed: ${name}: ${compact}` : `Desktop tool failed: ${name}`;
}

function requestContext(message) {
  const metadata = message.params?._meta || {};
  const turnMetadata = parseTurnMetadata(metadata["x-codex-turn-metadata"]);
  return {
    threadId: firstString(
      metadata["openai/threadId"],
      metadata["openai/thread_id"],
      metadata.threadId,
      metadata.thread_id,
      turnMetadata?.thread_id,
      process.env.CODEX_THREAD_ID,
      process.env.CODEX_SESSION_ID,
    ),
    turnId: firstString(
      metadata["openai/turnId"],
      metadata["openai/turn_id"],
      metadata.turnId,
      metadata.turn_id,
      turnMetadata?.turn_id,
    ) || `desktop-attach-turn-${String(message.id)}`,
    callId: firstString(
      metadata["openai/toolCallId"],
      metadata["openai/tool_call_id"],
      metadata.callId,
      metadata.call_id,
    ) || `desktop-attach-call-${randomUUID()}`,
  };
}

function parseTurnMetadata(value) {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === "object" ? value : null;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function boundedInteger(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function optionalTrimmedString(value, name, maxLength) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string up to ${maxLength} characters`);
  }
  return value.trim();
}

function subcallContext(context, label) {
  return { ...context, callId: `desktop-attach-${label}-${randomUUID()}` };
}

function canonicalDesktopPath(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 32_768 || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  let actual;
  try {
    actual = realpathSync.native(resolve(value));
  } catch {
    throw new Error(`${name} does not exist or cannot be accessed`);
  }
  const normalized = normalize(actual).replace(/[\\/]+$/, "");
  return { actual, key: process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized };
}

function textResult(value) {
  let text = JSON.stringify(value);
  if (text.length > MAX_RESULT_CHARS) {
    text = JSON.stringify({ ok: false, truncated: true, error: "Desktop result exceeded the PoC limit" });
  }
  return { content: [{ type: "text", text }], isError: false };
}

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopBridgeIpc();
  host?.close();
  process.exit(exitCode);
}

function ensureBridgeHost() {
  if (BRIDGE_HOST_MODE || !process.env[PIPE_ENV]?.trim() || !desktopHostThreadId) return Promise.resolve();
  if (!bridgeHostStarting) {
    bridgeHostStarting = establishBridgeHost().finally(() => { bridgeHostStarting = undefined; });
  }
  return bridgeHostStarting;
}

async function establishBridgeHost() {
  externalBridgeHostReady = false;
  const existing = readExternalBridgeRegistration();
  if (existing && await probeExternalBridge(existing)) {
    externalBridgeHostReady = true;
    return;
  }
  if (existing) {
    try { unlinkSync(bridgeRegistrationFile()); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  let spawnError;
  const child = spawn(process.execPath, [SERVER_PATH, "--bridge-host"], {
    cwd: dirname(SERVER_PATH),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CODEX_THREAD_ID: desktopHostThreadId,
      CODEX_SESSION_ID: "",
      [BRIDGE_HOST_PIPE_ENV]: bridgeHostPipeName(),
    },
  });
  child.once("error", (error) => { spawnError = error; });
  child.unref();

  const deadline = Date.now() + BRIDGE_HOST_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const registration = readExternalBridgeRegistration();
    if (registration && await probeExternalBridge(registration)) {
      externalBridgeHostReady = true;
      return;
    }
    await delay(50);
  }
  const detail = spawnError instanceof Error ? `: ${spawnError.message}` : "";
  throw new Error(`Desktop Attach bridge host did not become ready${detail}`);
}

function bridgeRegistrationFile() {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(localAppData, "AgentPocket", "desktop-attach.json");
}

function bridgeHostPipeName() {
  const pipeName = process.env[BRIDGE_HOST_PIPE_ENV]?.trim() || DEFAULT_BRIDGE_HOST_PIPE;
  if (!pipeName.startsWith("\\\\.\\pipe\\agent-pocket-desktop-attach-")) {
    throw new Error(`${BRIDGE_HOST_PIPE_ENV} must use the Agent Pocket named-pipe prefix`);
  }
  return pipeName;
}

function readExternalBridgeRegistration() {
  let registration;
  try {
    registration = JSON.parse(readFileSync(bridgeRegistrationFile(), "utf8"));
  } catch {
    return null;
  }
  if (
    registration?.protocolVersion !== IPC_PROTOCOL_VERSION
    || registration?.hostMode !== true
    || registration?.pipeName !== bridgeHostPipeName()
    || typeof registration?.token !== "string"
    || !/^[A-Za-z0-9_-]{40,128}$/.test(registration.token)
    || !Number.isSafeInteger(registration?.pid)
    || registration.pid <= 0
    || registration?.readOnly !== false
    || !Array.isArray(registration?.capabilities)
    || !registration.capabilities.includes("attach/probe")
  ) {
    return null;
  }
  return registration;
}

async function probeExternalBridge(registration) {
  try {
    const probe = await requestExternalBridge(registration, "attach/probe", {});
    return probe?.ok === true && probe?.ipcAvailable === true && probe?.bridgeWritable === true;
  } catch {
    return false;
  }
}

function requestExternalBridge(registration, method, params) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection(registration.pipeName);
    let buffer = "";
    let authenticated = false;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error instanceof Error ? error : new Error(String(error)));
      else resolvePromise(value);
    };
    const send = (id, requestMethod, requestParams) => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: requestMethod, params: requestParams })}\n`);
    };
    const timer = setTimeout(
      () => finish(new Error("Desktop Attach bridge host probe timed out")),
      BRIDGE_HOST_RPC_TIMEOUT_MS,
    );

    socket.setEncoding("utf8");
    socket.once("connect", () => send(1, "attach/hello", { token: registration.token }));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_IPC_MESSAGE_BYTES) {
        finish(new Error("Desktop Attach bridge host response exceeded 2 MiB"));
        return;
      }
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch {
          finish(new Error("Desktop Attach bridge host returned invalid JSON"));
          return;
        }
        if (message.id === 1) {
          if (message.error || message.result?.protocolVersion !== IPC_PROTOCOL_VERSION) {
            finish(new Error(message.error?.message || "Desktop Attach bridge host handshake failed"));
            return;
          }
          authenticated = true;
          send(2, method, params);
        } else if (message.id === 2 && authenticated) {
          if (message.error) finish(new Error(message.error.message || "Desktop Attach bridge host probe failed"));
          else finish(undefined, message.result);
          return;
        }
      }
    });
    socket.once("error", (error) => finish(new Error(`Could not connect to Desktop Attach bridge host: ${error.message}`)));
    socket.once("close", () => {
      if (!settled) finish(new Error("Desktop Attach bridge host closed the connection"));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function ensureBridgeIpc() {
  if (!BRIDGE_HOST_MODE || !process.env[PIPE_ENV]?.trim() || !desktopHostThreadId || bridgeRegistration) return Promise.resolve();
  if (!bridgeIpcStarting) {
    bridgeIpcStarting = startBridgeIpc().finally(() => { bridgeIpcStarting = undefined; });
  }
  return bridgeIpcStarting;
}

function startBridgeIpc() {
  const registrationFile = bridgeRegistrationFile();
  const stateDir = dirname(registrationFile);
  const instanceId = randomUUID();
  const pipeName = bridgeHostPipeName();
  const token = randomBytes(32).toString("base64url");
  const server = net.createServer((socket) => handleBridgeConnection(socket, token));
  bridgeIpcServer = server;

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const fail = (error) => {
      if (bridgeIpcServer === server) {
        bridgeIpcServer = undefined;
        bridgeRegistration = undefined;
      }
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    };
    server.on("error", fail);
    server.listen(pipeName, () => {
      try {
        mkdirSync(stateDir, { recursive: true });
        const registration = {
          protocolVersion: IPC_PROTOCOL_VERSION,
          instanceId,
          pipeName,
          token,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostMode: BRIDGE_HOST_MODE,
          readOnly: false,
          capabilities: BRIDGE_CAPABILITIES,
        };
        const tempFile = `${registrationFile}.${instanceId}.tmp`;
        writeFileSync(tempFile, JSON.stringify(registration), { encoding: "utf8", mode: 0o600 });
        renameSync(tempFile, registrationFile);
        bridgeRegistration = { ...registration, registrationFile };
        settled = true;
        resolvePromise();
      } catch (error) {
        server.close();
        fail(error);
      }
    });
  });
}

function stopBridgeIpc() {
  bridgeIpcServer?.close();
  bridgeIpcServer = undefined;
  if (!bridgeRegistration) return;
  try {
    const current = JSON.parse(readFileSync(bridgeRegistration.registrationFile, "utf8"));
    if (current.instanceId === bridgeRegistration.instanceId) {
      unlinkSync(bridgeRegistration.registrationFile);
    }
  } catch {
    // Another plugin instance may already own the registration file.
  }
  bridgeRegistration = undefined;
}

function handleBridgeConnection(socket, token) {
  if (bridgeConnectionCount >= MAX_BRIDGE_CONNECTIONS) {
    socket.destroy();
    return;
  }
  bridgeConnectionCount += 1;
  socket.setEncoding("utf8");
  let buffer = "";
  let authenticated = false;
  let queue = Promise.resolve();
  let queuedRequests = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    bridgeConnectionCount = Math.max(0, bridgeConnectionCount - 1);
  };

  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_IPC_MESSAGE_BYTES) {
      socket.destroy();
      return;
    }
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (queuedRequests >= MAX_BRIDGE_QUEUED_REQUESTS) {
        socket.destroy();
        return;
      }
      queuedRequests += 1;
      queue = queue
        .then(() => handleBridgeMessage(socket, line, token, () => authenticated, () => { authenticated = true; }))
        .catch(() => socket.destroy())
        .finally(() => { queuedRequests = Math.max(0, queuedRequests - 1); });
    }
  });
  socket.on("error", () => {});
  socket.once("close", release);
}

async function handleBridgeMessage(socket, line, token, isAuthenticated, markAuthenticated) {
  let message;
  try { message = JSON.parse(line); } catch {
    return writeBridgeError(socket, null, -32700, "Invalid JSON");
  }
  if (message?.jsonrpc !== "2.0" || message.id === undefined || typeof message.method !== "string") {
    return writeBridgeError(socket, message?.id ?? null, -32600, "Invalid JSON-RPC request");
  }

  try {
    if (!isAuthenticated()) {
      if (message.method !== "attach/hello" || !safeToken(message.params?.token, token)) {
        writeBridgeError(socket, message.id, -32001, "AUTH_FAILED");
        socket.end();
        return;
      }
      markAuthenticated();
      return writeBridgeResult(socket, message.id, {
        protocolVersion: IPC_PROTOCOL_VERSION,
        readOnly: false,
        capabilities: BRIDGE_CAPABILITIES,
      });
    }

    const context = backgroundContext(message);
    if (message.method === "attach/probe") {
      return writeBridgeResult(socket, message.id, await probeDesktop(context));
    }
    if (message.method === "project/list") {
      return writeBridgeResult(socket, message.id, {
        contentItems: await listDesktopProjects(context),
      });
    }
    if (message.method === "thread/list") {
      const limit = boundedInteger(message.params?.limit, 10, 1, 50);
      return writeBridgeResult(socket, message.id, {
        contentItems: await listDesktopTasks(limit, context),
      });
    }
    if (message.method === "thread/read") {
      const threadId = message.params?.threadId;
      if (typeof threadId !== "string" || !threadId.trim() || threadId.length > 128) {
        throw new Error("threadId is required");
      }
      const turnLimit = boundedInteger(message.params?.turnLimit, 10, 1, 10);
      const cursor = optionalTrimmedString(message.params?.cursor, "cursor", MAX_THREAD_CURSOR_CHARS);
      return writeBridgeResult(socket, message.id, {
        contentItems: await readDesktopTask(threadId.trim(), turnLimit, cursor, context),
      });
    }
    if (message.method === "thread/create") {
      const cwd = message.params?.cwd;
      const text = message.params?.text;
      const workspaceMode = optionalTrimmedString(message.params?.workspaceMode, "workspaceMode", 32) || "local";
      const model = optionalTrimmedString(message.params?.model, "model", 200);
      const effort = optionalTrimmedString(message.params?.effort, "effort", 32);
      if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 32_768) {
        throw new Error("cwd is required and must be an absolute path");
      }
      if (typeof text !== "string" || !text.trim() || text.length > MAX_PROMPT_CHARS) {
        throw new Error("text is required and must not exceed 1 MiB");
      }
      if (effort && !DESKTOP_REASONING_EFFORTS.has(effort)) {
        throw new Error("effort is not supported by Codex Desktop");
      }
      return writeBridgeResult(socket, message.id, await createDesktopThread(
        cwd.trim(),
        text,
        model,
        effort,
        workspaceMode,
        context,
      ));
    }
    if (message.method === "thread/send") {
      const threadId = message.params?.threadId;
      const text = message.params?.text;
      if (typeof threadId !== "string" || !threadId.trim() || threadId.length > 128) {
        throw new Error("threadId is required");
      }
      if (typeof text !== "string" || !text.trim() || text.length > MAX_PROMPT_CHARS) {
        throw new Error("text is required and must not exceed 1 MiB");
      }
      return writeBridgeResult(socket, message.id, {
        contentItems: await sendDesktopMessage(threadId.trim(), text.trim(), context),
      });
    }
    if (message.method === "thread/wait") {
      const threadId = message.params?.threadId;
      const afterCursor = message.params?.afterCursor;
      if (typeof threadId !== "string" || !threadId.trim() || threadId.length > 128) {
        throw new Error("threadId is required");
      }
      if (afterCursor !== undefined && (typeof afterCursor !== "string" || !afterCursor.trim() || afterCursor.length > MAX_WAIT_CURSOR_CHARS)) {
        throw new Error(`afterCursor must be a non-empty string up to ${MAX_WAIT_CURSOR_CHARS} characters`);
      }
      const timeoutMs = strictBoundedInteger(message.params?.timeoutMs, MAX_WAIT_TIMEOUT_MS, 0, MAX_WAIT_TIMEOUT_MS, "timeoutMs");
      return writeBridgeResult(socket, message.id, await waitDesktopThread(
        threadId.trim(),
        afterCursor?.trim(),
        timeoutMs,
        context,
      ));
    }
    return writeBridgeError(socket, message.id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    return writeBridgeError(socket, message.id, -32000, error instanceof Error ? error.message : String(error));
  }
}

function backgroundContext(message) {
  return {
    threadId: firstString(
      desktopHostThreadId,
      process.env.CODEX_THREAD_ID,
      process.env.CODEX_SESSION_ID,
    ),
    turnId: `desktop-attach-ipc-turn-${String(message.id)}`,
    callId: `desktop-attach-ipc-call-${randomUUID()}`,
  };
}

function safeToken(actual, expected) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function strictBoundedInteger(value, fallback, min, max, name) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function writeBridgeResult(socket, id, result) {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeBridgeError(socket, id, code, message) {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

class NativePipeClient {
  constructor(pipePath, disconnectHandler) {
    this.pipePath = pipePath;
    this.disconnectHandler = disconnectHandler;
    this.socket = null;
    this.connectingSocket = null;
    this.connecting = null;
    this.pendingData = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
  }

  async request(method, params) {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Codex Desktop task channel is closed");
    if (this.pending.size >= MAX_NATIVE_PENDING_REQUESTS) {
      throw new Error("Codex Desktop task channel is busy; retry shortly");
    }
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex Desktop task channel timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    socket.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    return response;
  }

  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const pipePath = this.pipePath();
    if (!pipePath) return Promise.reject(new Error(`${PIPE_ENV} was not provided by Codex Desktop`));

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath);
      this.connectingSocket = socket;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        socket.off("connect", connected);
        socket.off("close", closedBeforeConnect);
        if (this.connectingSocket === socket) this.connectingSocket = null;
        socket.destroy();
        const wrapped = new Error(`Could not attach to Codex Desktop: ${error.message}`);
        this.disconnectHandler?.(wrapped);
        reject(wrapped);
      };
      const closedBeforeConnect = () => fail(new Error("task channel closed before connecting"));
      const connected = () => {
        if (settled) return;
        settled = true;
        socket.off("error", fail);
        socket.off("close", closedBeforeConnect);
        if (this.connectingSocket === socket) this.connectingSocket = null;
        this.socket = socket;
        this.connecting = null;
        socket.on("data", (chunk) => this.onData(socket, chunk));
        socket.on("error", (error) => this.onDisconnect(socket, error));
        socket.on("close", () => this.onDisconnect(socket, new Error("Codex Desktop task channel closed")));
        resolve();
      };
      socket.once("error", fail);
      socket.once("close", closedBeforeConnect);
      socket.once("connect", connected);
    }).catch((error) => {
      this.connecting = null;
      throw error;
    });
    return this.connecting;
  }

  onData(socket, chunk) {
    if (this.socket !== socket) return;
    this.pendingData = Buffer.concat([this.pendingData, chunk]);
    while (this.pendingData.length >= 4) {
      const length = this.pendingData.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        this.onDisconnect(socket, new Error("Codex Desktop response exceeded 8 MiB"));
        socket.destroy();
        return;
      }
      if (this.pendingData.length < length + 4) return;
      const payload = this.pendingData.subarray(4, length + 4);
      this.pendingData = this.pendingData.subarray(length + 4);
      let message;
      try { message = JSON.parse(payload.toString("utf8")); } catch {
        this.onDisconnect(socket, new Error("Codex Desktop returned invalid JSON"));
        socket.destroy();
        return;
      }
      const pending = this.pending.get(Number(message.id));
      if (!pending) continue;
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message || "Codex Desktop task call failed"));
      else pending.resolve(message.result);
    }
  }

  onDisconnect(socket, error) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.pendingData = Buffer.alloc(0);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.disconnectHandler?.(error);
  }

  close() {
    const error = new Error("Codex Desktop task channel closed");
    const socket = this.socket;
    this.socket = null;
    this.pendingData = Buffer.alloc(0);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    socket?.destroy();
    this.connectingSocket?.destroy();
    this.connectingSocket = null;
  }
}

function encodeFrame(message) {
  const payload = Buffer.from(message, "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("Desktop request exceeded 8 MiB");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

host = new NativePipeClient(
  () => process.env[PIPE_ENV]?.trim() || "",
  () => {
    if (BRIDGE_HOST_MODE && !shuttingDown) shutdown(1);
  },
);
if (BRIDGE_HOST_MODE) {
  void (async () => {
    if (!process.env[PIPE_ENV]?.trim() || !desktopHostThreadId) throw new Error("Desktop host context is unavailable");
    await host.request("tools/list", { threadStartKind: "all" });
    await ensureBridgeIpc();
  })().catch(() => shutdown(1));
}
