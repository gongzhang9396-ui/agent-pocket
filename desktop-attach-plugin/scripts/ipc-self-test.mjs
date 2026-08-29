import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stateRoot = mkdtempSync(join(tmpdir(), "agent-pocket-plugin-test-"));
const desktopPipe = `\\\\.\\pipe\\agent-pocket-fake-desktop-${randomUUID()}`;
const registrationPath = join(stateRoot, "AgentPocket", "desktop-attach.json");
let desktopSendCount = 0;
let desktopWaitCount = 0;

const desktop = net.createServer((socket) => {
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
          tools: ["list_threads", "read_thread", "send_message_to_thread", "wait_threads"].map((name) => ({ name, namespace: "codex" })),
        };
      } else if (message.method === "tools/call" && message.params?.tool === "list_threads") {
        result = {
          success: true,
          contentItems: [{
            type: "inputText",
            text: JSON.stringify({
              pinnedThreads: [],
              threads: [{ id: "example-thread", kind: "codex", title: "Example", summary: "", cwd: "C:\\Projects\\example", status: "idle" }],
            }),
          }],
        };
      } else if (message.method === "tools/call" && message.params?.tool === "send_message_to_thread") {
        assert.deepEqual(message.params.arguments, { threadId: "example-thread", prompt: "example prompt" });
        desktopSendCount += 1;
        result = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true }) }] };
      } else if (message.method === "tools/call" && message.params?.tool === "wait_threads") {
        const args = message.params.arguments;
        assert.equal(args.targets[0].threadId, "example-thread");
        assert.ok(args.timeoutMs >= 0 && args.timeoutMs <= 8_000);
        desktopWaitCount += 1;
        const changed = args.targets[0].afterCursor === "baseline:1";
        result = {
          success: true,
          contentItems: [{
            type: "inputText",
            text: JSON.stringify({
              timedOut: !changed,
              wake: changed ? { reason: "turnCompleted", threadId: "example-thread", turnId: "turn-1" } : null,
              polls: [{
                threadId: "example-thread",
                cursor: changed ? "completed:2" : "baseline:1",
                changed,
                thread: { status: { type: "idle" } },
                latestTurn: changed ? { id: "turn-1", status: "completed", latestAssistantMessage: { text: "example content must not cross the IPC boundary" } } : null,
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
    CODEX_THREAD_ID: "caller-thread",
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

try {
  await mcpRequest("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "self-test", version: "1" } });
  await mcpRequest("tools/call", { name: "desktop_attach_list_tasks", arguments: { limit: 10 } });
  const registration = await waitForRegistration();
  const bridge = net.createConnection(registration.pipeName);
  bridge.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    bridge.once("connect", resolve);
    bridge.once("error", reject);
  });
  const bridgeRequest = bridgeRpc(bridge);
  const hello = await bridgeRequest("attach/hello", { token: registration.token });
  assert.equal(hello.readOnly, false);
  assert.ok(hello.capabilities.includes("thread/send"));
  assert.ok(hello.capabilities.includes("thread/wait"));
  const baseline = await bridgeRequest("thread/wait", { threadId: "example-thread", timeoutMs: 0 });
  assert.equal(baseline.cursor, "baseline:1");
  assert.equal(baseline.changed, false);
  const sent = await bridgeRequest("thread/send", { threadId: "example-thread", text: "example prompt" });
  assert.equal(sent.contentItems.length, 1);
  const changed = await bridgeRequest("thread/wait", { threadId: "example-thread", afterCursor: baseline.cursor, timeoutMs: 8_000 });
  assert.deepEqual(changed, {
    cursor: "completed:2",
    changed: true,
    threadStatus: "idle",
    turnId: "turn-1",
    turnStatus: "completed",
    wakeReason: "turnCompleted",
    timedOut: false,
  });
  assert.equal(JSON.stringify(changed).includes("example content must not cross the IPC boundary"), false);
  await assert.rejects(bridgeRequest("thread/wait", { threadId: "example-thread", timeoutMs: 8_001 }), /timeoutMs/);
  await assert.rejects(bridgeRequest("thread/wait", { threadId: "unknown-thread", timeoutMs: 0 }), /not recently confirmed/);
  await assert.rejects(bridgeRequest("thread/read", { threadId: "unknown-thread", turnLimit: 10 }), /not recently confirmed/);
  await assert.rejects(bridgeRequest("thread/send", { threadId: "unknown-thread", text: "blocked" }), /not recently confirmed/);
  assert.equal(desktopSendCount, 1);
  assert.equal(desktopWaitCount, 2);
  bridge.destroy();
  console.log(JSON.stringify({ ok: true, desktopSendCount, desktopWaitCount, waitPayloadSanitized: true, unknownThreadRejected: true }));
} finally {
  child.stdin.end();
  child.kill();
  await new Promise((resolve) => desktop.close(resolve));
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
