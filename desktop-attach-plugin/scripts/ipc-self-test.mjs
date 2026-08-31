import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stateRoot = mkdtempSync(join(tmpdir(), "agent-pocket-plugin-test-"));
const desktopPipe = `\\\\.\\pipe\\agent-pocket-fake-desktop-${randomUUID()}`;
const bridgeHostPipe = `\\\\.\\pipe\\agent-pocket-desktop-attach-host-${randomUUID()}`;
const registrationPath = join(stateRoot, "AgentPocket", "desktop-attach.json");
const desktopProjectPath = join(stateRoot, "Projects", "example");
mkdirSync(desktopProjectPath, { recursive: true });
const desktopSockets = new Set();
let desktopSendCount = 0;
const desktopSendCallerThreadIds = [];
let desktopWaitCount = 0;
const desktopWaitCallerThreadIds = [];
let desktopReadCount = 0;
let desktopCreateCount = 0;
let desktopCreateArgs;

const desktop = net.createServer((socket) => {
  desktopSockets.add(socket);
  socket.once("close", () => desktopSockets.delete(socket));
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
      buffer = buffer.subarray(length + 4);
      let result;
      if (message.method === "tools/list") {
        result = {
          tools: ["list_threads", "read_thread", "send_message_to_thread", "wait_threads", "list_projects", "create_thread"].map((name) => ({ name, namespace: "codex" })),
        };
      } else if (message.method === "tools/call" && message.params?.tool === "list_threads") {
        result = {
          success: true,
          contentItems: [{
            type: "inputText",
            text: JSON.stringify({
              pinnedThreads: [{ id: "cold-thread", kind: "codex", title: "Cold", summary: "", cwd: desktopProjectPath, status: "notLoaded" }],
              threads: [{ id: "example-thread", kind: "codex", title: "Example", summary: "", cwd: desktopProjectPath, status: "idle" }],
            }),
          }],
        };
      } else if (message.method === "tools/call" && message.params?.tool === "list_projects") {
        assert.deepEqual(message.params.arguments, {});
        result = {
          success: true,
          contentItems: [{
            type: "inputText",
            text: JSON.stringify({
              schemaVersion: 2,
              projects: [{
                projectId: "local-example-project",
                projectKind: "local",
                label: "example",
                path: desktopProjectPath,
                hostId: "local",
                isGitRepository: true,
              }],
            }),
          }],
        };
      } else if (message.method === "tools/call" && message.params?.tool === "create_thread") {
        desktopCreateArgs = message.params.arguments;
        desktopCreateCount += 1;
        result = {
          success: true,
          contentItems: [{
            type: "inputText",
            text: JSON.stringify(
              message.params.arguments?.prompt === "preparing Desktop task"
                ? { clientThreadId: "client-created" }
                : {
                    threadId: message.params.arguments?.prompt === "failing Desktop task"
                      ? "failed-created-thread"
                      : "created-thread",
                    hostId: "local",
                  },
            ),
          }],
        };
      } else if (message.method === "tools/call" && message.params?.tool === "read_thread") {
        assert.equal(message.params.arguments?.turnLimit, 10);
        assert.equal(message.params.arguments?.maxOutputCharsPerItem, 20_000);
        const cursor = message.params.arguments?.cursor;
        assert.ok(cursor === undefined || cursor === "older:1");
        desktopReadCount += 1;
        result = {
          success: true,
          contentItems: [{
            type: "inputText",
            text: JSON.stringify({
              thread: {
                id: message.params.arguments?.threadId,
                kind: "codex",
                title: "Example",
                cwd: desktopProjectPath,
                status: { type: "idle" },
              },
              page: cursor
                ? { order: "newest_first", limit: 10, hasMore: false }
                : { order: "newest_first", limit: 10, nextCursor: "older:1", hasMore: true },
              turns: [{ id: cursor ? "older-turn" : "newest-turn", status: "completed", items: [] }],
            }),
          }],
        };
      } else if (message.method === "tools/call" && message.params?.tool === "send_message_to_thread") {
        desktopSendCallerThreadIds.push(message.params.threadId);
        desktopSendCount += 1;
        result = message.params.arguments?.prompt === "http websocket regression"
          ? {
            success: false,
            contentItems: [{
              type: "inputText",
              text: "function_call_output requires call_id on HTTP requests; continuation via previous_response_id is only supported on Responses WebSocket v2",
            }],
          }
          : { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true }) }] };
      } else if (message.method === "tools/call" && message.params?.tool === "wait_threads") {
        desktopWaitCallerThreadIds.push(message.params.threadId);
        const args = message.params.arguments;
        const threadId = args.targets[0].threadId;
        assert.ok(args.timeoutMs >= 0 && args.timeoutMs <= 8_000);
        desktopWaitCount += 1;
        const failedCreate = threadId === "failed-created-thread";
        const changed = threadId === "example-thread" && args.targets[0].afterCursor === "baseline:1";
        result = {
          success: true,
          contentItems: [{
            type: "inputText",
            text: JSON.stringify({
              timedOut: !changed && !failedCreate,
              wake: changed
                ? { reason: "turnCompleted", threadId, turnId: "turn-1" }
                : failedCreate
                  ? { reason: "inactiveStatus", threadId }
                  : null,
              polls: [{
                threadId,
                cursor: changed ? "completed:2" : threadId === "example-thread" ? "baseline:1" : `${threadId}:baseline`,
                changed: changed || failedCreate,
                thread: { status: { type: failedCreate ? "systemError" : "idle" } },
                latestTurn: changed
                  ? { id: "turn-1", status: "completed" }
                  : failedCreate
                    ? { id: "failed-turn", status: "failed", error: { message: "synthetic Desktop startup failure" } }
                    : null,
                latestAssistantMessage: changed ? { id: "assistant-1", turnId: "turn-1", text: "assistant reply from fake Desktop" } : null,
              }],
            }),
          }],
        };
      } else {
        result = { success: false, contentItems: [{ type: "inputText", text: "unexpected fake Desktop call" }] };
      }
      socket.write(frame({ jsonrpc: "2.0", id: message.id, result }));
    }
  });
});

await new Promise((resolve, reject) => {
  desktop.once("error", reject);
  desktop.listen(desktopPipe, resolve);
});

const child = spawn(process.execPath, [join(pluginRoot, "server.mjs")], {
  cwd: pluginRoot,
  env: {
    ...process.env,
    LOCALAPPDATA: stateRoot,
    CODEX_APP_TOOLS_PIPE_PATH: desktopPipe,
    AGENT_POCKET_DESKTOP_HOST_PIPE: bridgeHostPipe,
    AGENT_POCKET_CODEX_QUEUE_DISABLED: "1",
    CODEX_THREAD_ID: "",
    CODEX_SESSION_ID: "",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let mcpBuffer = "";
let nextMcpId = 1;
const mcpPending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  mcpBuffer += chunk;
  while (true) {
    const newline = mcpBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = mcpBuffer.slice(0, newline);
    mcpBuffer = mcpBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const pending = mcpPending.get(message.id);
    if (pending) {
      mcpPending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    }
  }
});
child.stderr.on("data", () => {});

function mcpRequest(method, params = {}) {
  const id = nextMcpId++;
  return new Promise((resolve, reject) => {
    mcpPending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

let bridge;
let registration;
let ordinaryChildStopped = false;
try {
  await mcpRequest("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "self-test", version: "1" } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(existsSync(registrationPath), false);
  const callerMeta = { "openai/threadId": "caller-thread" };
  const probe = await mcpRequest("tools/call", { name: "desktop_attach_probe", arguments: {}, _meta: callerMeta });
  const probeText = probe.content?.find((item) => item.type === "text")?.text;
  assert.equal(JSON.parse(probeText).ipcAvailable, true);
  await mcpRequest("tools/call", { name: "desktop_attach_list_tasks", arguments: { limit: 10 }, _meta: callerMeta });
  registration = await waitForRegistration();
  assert.equal(registration.hostMode, true);
  assert.equal(registration.pipeName, bridgeHostPipe);
  assert.notEqual(registration.pid, child.pid);

  const firstBridge = await connectBridge(registration.pipeName);
  const firstBridgeRequest = bridgeRpc(firstBridge);
  const firstHello = await firstBridgeRequest("attach/hello", { token: registration.token });
  assert.equal(firstHello.readOnly, false);
  firstBridge.destroy();

  await stopMcpChild(child);
  ordinaryChildStopped = true;
  const registrationAfterMcpExit = JSON.parse(readFileSync(registrationPath, "utf8"));
  assert.equal(registrationAfterMcpExit.instanceId, registration.instanceId);
  assert.equal(registrationAfterMcpExit.pid, registration.pid);

  bridge = await connectBridge(registration.pipeName);
  const bridgeRequest = bridgeRpc(bridge);
  const hello = await bridgeRequest("attach/hello", { token: registration.token });
  assert.equal(hello.readOnly, false);
  assert.ok(hello.capabilities.includes("project/list"));
  assert.ok(hello.capabilities.includes("thread/create"));
  assert.ok(hello.capabilities.includes("thread/send"));
  assert.ok(hello.capabilities.includes("thread/wait"));
  const projects = await bridgeRequest("project/list", {});
  assert.equal(projects.contentItems.length, 1);
  const baseline = await bridgeRequest("thread/wait", { threadId: "example-thread", timeoutMs: 0 });
  assert.equal(baseline.cursor, "baseline:1");
  assert.equal(baseline.changed, false);
  const created = await bridgeRequest("thread/create", {
    cwd: desktopProjectPath,
    text: "new Desktop task",
    model: "gpt-test",
    effort: "high",
    workspaceMode: "local",
  });
  assert.equal(created.source, "desktop");
  assert.equal(created.thread.id, "created-thread");
  assert.deepEqual(desktopCreateArgs, {
    prompt: "new Desktop task",
    model: "gpt-test",
    thinking: "high",
    target: {
      type: "project",
      projectId: "local-example-project",
      environment: { type: "local" },
    },
  });
  await assert.rejects(bridgeRequest("thread/create", {
    cwd: desktopProjectPath,
    text: "preparing Desktop task",
    workspaceMode: "local",
  }), /still preparing/);
  await assert.rejects(bridgeRequest("thread/create", {
    cwd: desktopProjectPath,
    text: "failing Desktop task",
    workspaceMode: "local",
  }), /created the task but failed to initialize it: synthetic Desktop startup failure/);
  await assert.rejects(bridgeRequest("thread/send", {
    threadId: "example-thread",
    text: "http websocket regression",
  }), /function_call_output requires call_id/);
  const sent = await bridgeRequest("thread/send", { threadId: "example-thread", text: "example prompt" });
  assert.equal(sent.contentItems.length, 1);
  const selfSent = await bridgeRequest("thread/send", { threadId: "caller-thread", text: "self prompt" });
  assert.equal(selfSent.contentItems.length, 1);
  assert.equal(desktopSendCallerThreadIds.at(-1), "example-thread");
  const changed = await bridgeRequest("thread/wait", { threadId: "example-thread", afterCursor: baseline.cursor, timeoutMs: 8_000 });
  assert.deepEqual(changed, {
    cursor: "completed:2",
    changed: true,
    threadStatus: "idle",
    turnId: "turn-1",
    turnStatus: "completed",
    wakeReason: "turnCompleted",
    timedOut: false,
    assistantText: "assistant reply from fake Desktop",
    assistantTextTruncated: false,
    turnError: null,
  });
  const selfWait = await bridgeRequest("thread/wait", { threadId: "caller-thread", timeoutMs: 0 });
  assert.equal(selfWait.cursor, "caller-thread:baseline");
  assert.equal(desktopWaitCallerThreadIds.at(-1), "example-thread");
  await assert.rejects(bridgeRequest("thread/wait", { threadId: "example-thread", timeoutMs: 8_001 }), /timeoutMs/);
  const read = await bridgeRequest("thread/read", { threadId: "example-thread", turnLimit: 10 });
  assert.equal(read.contentItems.length, 1);
  const firstPage = JSON.parse(read.contentItems[0].text);
  assert.equal(firstPage.page.nextCursor, "older:1");
  const older = await bridgeRequest("thread/read", { threadId: "example-thread", turnLimit: 10, cursor: firstPage.page.nextCursor });
  assert.equal(JSON.parse(older.contentItems[0].text).turns[0].id, "older-turn");
  await assert.rejects(bridgeRequest("thread/create", { cwd: join(stateRoot, "missing"), text: "blocked", workspaceMode: "local" }), /does not exist/);
  assert.equal(desktopCreateCount, 3);
  assert.equal(desktopReadCount, 2);
  assert.equal(desktopSendCount, 3);
  assert.equal(desktopWaitCount, 5);
  bridge.destroy();
  bridge = undefined;
  console.log(JSON.stringify({
    ok: true,
    detachedHostPid: registration.pid,
    ordinaryMcpPid: child.pid,
    persistedAfterMcpExit: true,
    desktopCreateCount,
    desktopReadCount,
    desktopSendCount,
    desktopWaitCount,
    assistantPayloadForwarded: true,
    selfSendUsedAlternateCaller: true,
    selfWaitUsedAlternateCaller: true,
  }));
} finally {
  bridge?.destroy();
  if (!ordinaryChildStopped) await stopMcpChild(child);
  for (const socket of desktopSockets) socket.destroy();
  await new Promise((resolve) => desktop.close(resolve));
  if (registration) {
    const removed = await waitForRegistrationRemoval();
    const exited = removed && await waitForProcessExit(registration.pid);
    if (!removed || !exited) {
      try { process.kill(registration.pid, "SIGTERM"); } catch {}
      await waitForProcessExit(registration.pid);
      rmSync(stateRoot, { recursive: true, force: true });
      throw new Error("detached bridge host did not fully exit after the Desktop pipe closed");
    }
  }
  rmSync(stateRoot, { recursive: true, force: true });
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const result = Buffer.alloc(payload.length + 4);
  result.writeUInt32LE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

async function waitForRegistration() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return JSON.parse(readFileSync(registrationPath, "utf8")); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("registration was not created");
}

async function waitForRegistrationRemoval() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!existsSync(registrationPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function connectBridge(pipeName) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    socket.setEncoding("utf8");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function stopMcpChild(target) {
  if (target.exitCode !== null || target.signalCode !== null) return;
  target.stdin.end();
  if (await waitForExit(target, 2_000)) return;
  target.kill();
  if (!await waitForExit(target, 2_000)) {
    throw new Error("ordinary MCP child did not exit");
  }
}

function waitForExit(target, timeoutMs) {
  if (target.exitCode !== null || target.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      target.off("exit", exited);
      resolve(false);
    }, timeoutMs);
    const exited = () => {
      clearTimeout(timer);
      resolve(true);
    };
    target.once("exit", exited);
  });
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function bridgeRpc(socket) {
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    }
  });
  return (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
}
