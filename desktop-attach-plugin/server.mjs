import net from "node:net";
import process from "node:process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_CHARS = 512 * 1024;
const MAX_IPC_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 1024 * 1024;
const DESKTOP_THREAD_CONFIRM_TTL_MS = 15 * 60 * 1000;
const MAX_WAIT_CURSOR_CHARS = 2048;
const MAX_WAIT_TIMEOUT_MS = 8_000;
const MAX_BRIDGE_CONNECTIONS = 4;
const MAX_BRIDGE_QUEUED_REQUESTS = 8;
const MAX_NATIVE_PENDING_REQUESTS = 16;
const PIPE_ENV = "CODEX_APP_TOOLS_PIPE_PATH";
const IPC_PROTOCOL_VERSION = 1;
const BRIDGE_CAPABILITIES = ["attach/probe", "thread/list", "thread/read", "thread/send", "thread/wait"];

let host;
let bridgeIpcServer;
let bridgeRegistration;
let desktopHostThreadId;
let bridgeConnectionCount = 0;
let stdinBuffer = "";
const confirmedDesktopThreads = new Map();

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
            version: "0.1.0",
          },
          instructions: "Local Agent Pocket adapter. Its user-facing MCP tools are read-only; authenticated local Bridge IPC may append a prompt to a recently confirmed Desktop task.",
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
        turnLimit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(message) {
  const name = message.params?.name;
  const args = message.params?.arguments || {};
  const context = requestContext(message);
  if (context.threadId && !desktopHostThreadId) desktopHostThreadId = context.threadId;

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
    const turnLimit = boundedInteger(args.turnLimit, 10, 1, 50);
    const result = await readDesktopTask(args.threadId.trim(), turnLimit, context);
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
    ipcAvailable: Boolean(bridgeRegistration),
    bridgeWritable: bridgeRegistration?.readOnly === false,
    available,
  };
}

async function listDesktopTasks(limit, context) {
  const contentItems = await callDesktopTool("list_threads", { limit }, context);
  rememberDesktopThreads(contentItems);
  return contentItems;
}

function readDesktopTask(threadId, turnLimit, context) {
  return callDesktopTool(
    "read_thread",
    { threadId, turnLimit, includeOutputs: false, maxOutputCharsPerItem: 32 * 1024 },
    context,
  );
}

function sendDesktopMessage(threadId, text, context) {
  if (!isConfirmedDesktopThread(threadId)) {
    throw new Error("threadId was not recently confirmed by Desktop thread/list; refresh the task list first");
  }
  return callDesktopTool("send_message_to_thread", { threadId, prompt: text }, context);
}

async function waitDesktopThread(threadId, afterCursor, timeoutMs, context) {
  if (!isConfirmedDesktopThread(threadId)) {
    throw new Error("threadId was not recently confirmed by Desktop thread/list; refresh the task list first");
  }
  const target = { threadId };
  if (afterCursor) target.afterCursor = afterCursor;
  const contentItems = await callDesktopTool("wait_threads", {
    targets: [target],
    timeoutMs,
  }, context);
  const payload = desktopToolJson(contentItems, "wait_threads");
  const poll = Array.isArray(payload?.polls)
    ? payload.polls.find((item) => item?.threadId === threadId) || payload.polls[0]
    : null;
  const wake = payload?.wake && typeof payload.wake === "object" ? payload.wake : null;
  const threadStatus = firstString(poll?.thread?.status?.type, poll?.thread?.status);
  const turnStatus = firstString(poll?.latestTurn?.status?.type, poll?.latestTurn?.status);
  return {
    cursor: firstString(poll?.cursor),
    changed: poll?.changed === true,
    threadStatus,
    turnId: firstString(wake?.turnId, poll?.latestTurn?.id),
    turnStatus,
    wakeReason: firstString(wake?.reason),
    timedOut: payload?.timedOut === true,
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

function rememberDesktopThreads(contentItems) {
  const text = Array.isArray(contentItems)
    ? contentItems.find((item) => item?.type === "inputText" && typeof item.text === "string")?.text
    : null;
  if (!text) return;
  let payload;
  try { payload = JSON.parse(text); } catch { return; }
  const now = Date.now();
  const rows = [
    ...(Array.isArray(payload?.pinnedThreads) ? payload.pinnedThreads : []),
    ...(Array.isArray(payload?.threads) ? payload.threads : []),
  ];
  for (const thread of rows) {
    if (thread?.kind === "codex" && typeof thread.id === "string" && thread.id.trim()) {
      confirmedDesktopThreads.set(thread.id.trim(), now);
    }
  }
  for (const [threadId, confirmedAt] of confirmedDesktopThreads) {
    if (now - confirmedAt > DESKTOP_THREAD_CONFIRM_TTL_MS) confirmedDesktopThreads.delete(threadId);
  }
}

function isConfirmedDesktopThread(threadId) {
  const confirmedAt = confirmedDesktopThreads.get(threadId);
  if (!confirmedAt) return false;
  if (Date.now() - confirmedAt > DESKTOP_THREAD_CONFIRM_TTL_MS) {
    confirmedDesktopThreads.delete(threadId);
    return false;
  }
  return true;
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
    throw new Error(details || `Desktop tool failed: ${name}`);
  }
  return response.contentItems || [];
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

function shutdown() {
  stopBridgeIpc();
  host?.close();
  process.exit(0);
}

function startBridgeIpc() {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const stateDir = join(localAppData, "AgentPocket");
  const registrationFile = join(stateDir, "desktop-attach.json");
  const instanceId = randomUUID();
  const pipeName = `\\\\.\\pipe\\agent-pocket-desktop-attach-${instanceId}`;
  const token = randomBytes(32).toString("base64url");
  const server = net.createServer((socket) => handleBridgeConnection(socket, token));

  server.on("error", () => {
    if (bridgeIpcServer === server) {
      bridgeIpcServer = undefined;
      bridgeRegistration = undefined;
    }
  });
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
        readOnly: false,
        capabilities: BRIDGE_CAPABILITIES,
      };
      const tempFile = `${registrationFile}.${instanceId}.tmp`;
      writeFileSync(tempFile, JSON.stringify(registration), { encoding: "utf8", mode: 0o600 });
      renameSync(tempFile, registrationFile);
      bridgeIpcServer = server;
      bridgeRegistration = { ...registration, registrationFile };
    } catch {
      server.close();
    }
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
      if (!isConfirmedDesktopThread(threadId.trim())) {
        throw new Error("threadId was not recently confirmed by Desktop thread/list; refresh the task list first");
      }
      const turnLimit = boundedInteger(message.params?.turnLimit, 10, 1, 50);
      return writeBridgeResult(socket, message.id, {
        contentItems: await readDesktopTask(threadId.trim(), turnLimit, context),
      });
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
      `desktop-attach-background-${process.pid}`,
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
  constructor(pipePath) {
    this.pipePath = pipePath;
    this.socket = null;
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
      const fail = (error) => {
        socket.destroy();
        reject(new Error(`Could not attach to Codex Desktop: ${error.message}`));
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        this.socket = socket;
        this.connecting = null;
        socket.on("data", (chunk) => this.onData(socket, chunk));
        socket.on("error", (error) => this.onDisconnect(socket, error));
        socket.on("close", () => this.onDisconnect(socket, new Error("Codex Desktop task channel closed")));
        resolve();
      });
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
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
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

host = new NativePipeClient(() => process.env[PIPE_ENV]?.trim() || "");
if (process.env[PIPE_ENV]?.trim()) startBridgeIpc();
