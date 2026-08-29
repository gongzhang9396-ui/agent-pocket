import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { BridgeServer } from "../src/server.ts";
import { BridgeStore } from "../src/store.ts";
import { MAX_COMMAND_BYTES } from "../src/protocol.ts";

class FakeCodex extends EventEmitter {
  version = "fake-1";
  readOnly = false;
  compatibilityError = undefined;
  activeTurns = new Map<string, string>();
  calls: any[] = [];
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "model/list") return { data: [{ id: "gpt-test" }] };
    if (method === "thread/list") return { data: [] };
    if (method === "thread/read") return { thread: { id: params.threadId, status: { type: "idle" } } };
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    return { ok: true };
  }
  assertWritable() {}
  async assertThreadControllable(threadId: string) { return this.request("thread/read", { threadId }); }
  markTurn(threadId: string, turnId: string) { this.activeTurns.set(threadId, turnId); }
  clearTurn(threadId: string) { this.activeTurns.delete(threadId); }
  respond() {}
}

class FakeDesktopAttach {
  calls: any[] = [];
  fail = false;
  failSend = false;
  sent: any[] = [];
  waitCalls: any[] = [];
  waitResults: any[] = [];
  activeWaits = 0;
  maxActiveWaits = 0;
  threadIds = ["desktop-thread"];
  async listThreadsNormalized(limit: number, search?: string) {
    this.calls.push({ limit, search });
    if (this.fail) throw new Error("plugin unavailable");
    return { data: this.threadIds.map((id) => ({ id, source: "desktop" })), source: "desktop", readOnly: false };
  }
  async sendMessage(threadId: string, text: string) {
    if (this.failSend) throw new Error("desktop send failed");
    this.sent.push({ threadId, text });
    return { accepted: true };
  }
  async waitThread(threadId: string, afterCursor?: string, timeoutMs = 8_000) {
    this.waitCalls.push({ threadId, afterCursor, timeoutMs });
    this.activeWaits += 1;
    this.maxActiveWaits = Math.max(this.maxActiveWaits, this.activeWaits);
    try {
      const next = this.waitResults.shift();
      if (next instanceof Error) throw next;
      if (next && typeof next.then === "function") return await next;
      return next || { cursor: afterCursor || "baseline:1", changed: false, threadStatus: "idle", timedOut: true };
    } finally {
      this.activeWaits -= 1;
    }
  }
}

async function settleWatcher() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function rpc(socket: WebSocket, id: number, method: string, params: any = {}) {
  return new Promise<any>((resolve, reject) => {
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.id !== id) return;
      socket.off("message", onMessage);
      if (message.error) reject(message.error); else resolve(message.result);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

function opened(url: string, token?: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

test("pair, authenticate, hello, replay, and call bridge methods", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-server-"));
  const root = join(base, "projects");
  mkdirSync(join(root, "demo", ".git"), { recursive: true });
  const store = new BridgeStore(join(base, "bridge.db"));
  const pairing = store.createPairing();
  const codex = new FakeCodex();
  const server = new BridgeServer({
    bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base,
    codexCommand: "fake", minCodexVersion: "1", projectRoots: [root], hostName: "test-host",
  }, store, codex as any, { send: async () => {} } as any);
  await server.start();
  const address = server.wss!.address() as any;
  const url = `ws://127.0.0.1:${address.port}`;

  const pairSocket = await opened(url);
  const claimed = await rpc(pairSocket, 1, "pair/claim", { pairingId: pairing.id, secret: pairing.secret, deviceName: "test" });
  pairSocket.close();

  const socket = await opened(url, claimed.token);
  const hello = await rpc(socket, 2, "bridge/hello", { protocolVersion: 1, deviceId: claimed.deviceId, lastSeq: 0 });
  assert.equal(hello.deviceId, claimed.deviceId);
  const projects = await rpc(socket, 3, "project/list");
  assert.equal(projects.data[0].name, "demo");
  const models = await rpc(socket, 4, "model/list");
  assert.equal(models.data[0].id, "gpt-test");

  store.revokeDevice(claimed.deviceId);
  await assert.rejects(rpc(socket, 5, "project/list"), (error: any) => error?.data?.name === "AUTH_FAILED");

  socket.close();
  await server.stop();
  store.close();
});

test("rejects unauthenticated and pre-hello calls", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-auth-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const server = new BridgeServer({ bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" }, store, new FakeCodex() as any, { send: async () => {} } as any);
  await server.start();
  const port = (server.wss!.address() as any).port;
  const socket = await opened(`ws://127.0.0.1:${port}`);
  await assert.rejects(rpc(socket, 1, "thread/list"), (error: any) => error?.data?.name === "AUTH_FAILED");
  socket.close();
  await server.stop();
  store.close();
});

test("validates cursors and keeps approval and question response types separate", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-input-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const pairing = store.createPairing();
  const server = new BridgeServer({ bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" }, store, new FakeCodex() as any, { send: async () => {} } as any);
  await server.start();
  const url = `ws://127.0.0.1:${(server.wss!.address() as any).port}`;
  const pairSocket = await opened(url);
  const claimed = await rpc(pairSocket, 1, "pair/claim", { pairingId: pairing.id, secret: pairing.secret });
  pairSocket.close();
  const socket = await opened(url, claimed.token);
  await assert.rejects(rpc(socket, 2, "bridge/hello", { protocolVersion: 1, deviceId: claimed.deviceId, lastSeq: -1 }), (error: any) => error?.data?.name === "INVALID_REQUEST");
  await rpc(socket, 3, "bridge/hello", { protocolVersion: 1, deviceId: claimed.deviceId, lastSeq: 0 });
  const questionId = store.addPending(1, "item/tool/requestUserInput", { threadId: "t" });
  await assert.rejects(rpc(socket, 4, "approval/respond", { requestId: questionId, decision: "allowOnce" }), (error: any) => error?.data?.name === "INVALID_REQUEST");
  const approvalId = store.addPending(2, "item/commandExecution/requestApproval", { threadId: "t" });
  await assert.rejects(rpc(socket, 5, "question/respond", { requestId: approvalId, answers: { q: { answers: ["x"] } } }), (error: any) => error?.data?.name === "INVALID_REQUEST");
  socket.close();
  await server.stop();
  store.close();
});

test("caps cumulative command output per item", () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-command-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const server = new BridgeServer({ bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" }, store, new FakeCodex() as any, { send: async () => {} } as any);
  server.onCodexNotification({ method: "item/commandExecution/outputDelta", params: { threadId: "t", turnId: "u", itemId: "i", delta: "a".repeat(MAX_COMMAND_BYTES - 10) } });
  server.onCodexNotification({ method: "item/commandExecution/outputDelta", params: { threadId: "t", turnId: "u", itemId: "i", delta: "b".repeat(100) } });
  const events = store.eventsAfter(0);
  assert.ok(events.reduce((bytes, event) => bytes + Buffer.byteLength((event.payload as any).delta), 0) <= MAX_COMMAND_BYTES);
  assert.equal((events.at(-1)!.payload as any).truncated, true);
  store.close();
});

test("prefers Desktop Attach inbox and falls back to app-server", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-desktop-routing-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  const desktop = new FakeDesktopAttach();
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    codex as any,
    { send: async () => {} } as any,
    desktop as any,
  );

  const attached = await server.dispatch({} as any, "thread/list", { limit: 20, search: "demo" });
  assert.equal(attached.source, "desktop");
  assert.deepEqual(desktop.calls, [{ limit: 20, search: "demo" }]);
  assert.equal(codex.calls.length, 0);

  desktop.fail = true;
  const fallback = await server.dispatch({} as any, "thread/list", { limit: 20 });
  assert.deepEqual(fallback, { data: [] });
  assert.equal(codex.calls.at(-1)?.method, "thread/list");
  store.close();
});

test("routes confirmed Desktop task writes through Desktop Attach without app-server fallback", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-desktop-write-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  const desktop = new FakeDesktopAttach();
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    codex as any,
    { send: async () => {} } as any,
    desktop as any,
  );
  desktop.waitResults.push(
    { cursor: "baseline:1", changed: false, threadStatus: "idle", timedOut: true },
    { cursor: "done:2", changed: true, threadStatus: "idle", turnId: "desktop-turn", turnStatus: "completed", wakeReason: "turnCompleted", timedOut: false },
    { cursor: "baseline:3", changed: false, threadStatus: "idle", timedOut: true },
    { cursor: "done:4", changed: true, threadStatus: "idle", turnId: "desktop-turn-2", turnStatus: "completed", wakeReason: "turnCompleted", timedOut: false },
  );

  await server.dispatch({} as any, "thread/list", { limit: 20 });
  const started = await server.dispatch({} as any, "turn/start", { threadId: "desktop-thread", text: "first" });
  const steered = await server.dispatch({} as any, "turn/steer", { threadId: "desktop-thread", expectedTurnId: "desktop-turn", text: "second" });
  assert.equal(started.source, "desktop");
  assert.equal(steered.source, "desktop");
  assert.equal(started.liveSync, true);
  assert.equal(steered.liveSync, true);
  assert.deepEqual(desktop.sent, [
    { threadId: "desktop-thread", text: "first" },
    { threadId: "desktop-thread", text: "second" },
  ]);
  assert.equal(codex.calls.length, 0);
  await settleWatcher();
  const syncEvents = store.eventsAfter(0).filter((event) => event.type === "sync.required");
  assert.equal(syncEvents.length, 2);
  assert.equal(syncEvents[0].threadId, "desktop-thread");
  assert.equal((syncEvents[0].payload as any).reason, "desktop-wait");
  assert.equal(server.desktopWatchers.size, 0);

  desktop.failSend = true;
  await assert.rejects(
    server.dispatch({} as any, "turn/start", { threadId: "desktop-thread", text: "must not fall back" }),
    (error: any) => error?.nameCode === "THREAD_BUSY_EXTERNAL",
  );
  assert.equal(codex.calls.length, 0);
  store.close();
});

test("Desktop watcher falls back to one targeted sync event when wait fails", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-desktop-wait-fallback-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const desktop = new FakeDesktopAttach();
  desktop.waitResults.push(
    { cursor: "baseline:1", changed: false, threadStatus: "idle", timedOut: true },
    new Error("wait schema changed and included secret text"),
  );
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    new FakeCodex() as any,
    { send: async () => {} } as any,
    desktop as any,
  );

  await server.dispatch({} as any, "thread/list", { limit: 20 });
  const result = await server.dispatch({} as any, "turn/start", { threadId: "desktop-thread", text: "continue" });
  assert.equal(result.liveSync, true);
  await settleWatcher();
  const events = store.eventsAfter(0).filter((event) => event.type === "sync.required");
  assert.equal(events.length, 1);
  assert.equal((events[0].payload as any).reason, "desktop-wait-fallback");
  assert.equal(JSON.stringify(events[0]).includes("secret text"), false);
  assert.equal(server.desktopWatchers.size, 0);
  store.close();
});

test("keeps only one Desktop watcher while the same task receives another prompt", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-desktop-wait-singleton-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const desktop = new FakeDesktopAttach();
  const inProgress = deferred<any>();
  desktop.waitResults.push(
    { cursor: "baseline:1", changed: false, threadStatus: "idle", timedOut: true },
    inProgress.promise,
    { cursor: "done:3", changed: true, threadStatus: "idle", turnId: "turn-2", turnStatus: "completed", wakeReason: "turnCompleted", timedOut: false },
  );
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    new FakeCodex() as any,
    { send: async () => {} } as any,
    desktop as any,
  );

  await server.dispatch({} as any, "thread/list", { limit: 20 });
  await server.dispatch({} as any, "turn/start", { threadId: "desktop-thread", text: "first" });
  assert.equal(server.desktopWatchers.size, 1);
  await server.dispatch({} as any, "turn/start", { threadId: "desktop-thread", text: "second" });
  assert.equal(server.desktopWatchers.size, 1);
  assert.equal(desktop.maxActiveWaits, 1);

  inProgress.resolve({ cursor: "active:2", changed: true, threadStatus: "active", turnId: "turn-1", turnStatus: "inProgress", timedOut: false });
  await settleWatcher();
  assert.equal(desktop.maxActiveWaits, 1);
  assert.equal(server.desktopWatchers.size, 0);
  assert.equal(store.eventsAfter(0).filter((event) => event.type === "sync.required").length, 2);
  store.close();
});

test("a persisted Bridge owner cannot be reclassified by the Desktop inbox", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-owner-overlap-"));
  const dbPath = join(base, "bridge.db");
  const desktop = new FakeDesktopAttach();
  desktop.threadIds = ["thread-1"];
  const firstStore = new BridgeStore(dbPath);
  const firstCodex = new FakeCodex();
  const firstServer = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath, codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    firstStore,
    firstCodex as any,
    { send: async () => {} } as any,
    desktop as any,
  );

  await firstServer.dispatch({} as any, "thread/start", { cwd: base, text: "create", model: "gpt-test", effort: "medium" });
  assert.equal(firstStore.threadOwner("thread-1"), "bridge");
  const inbox = await firstServer.dispatch({} as any, "thread/list", { limit: 20 });
  assert.equal(inbox.data[0].source, "bridge");
  await firstServer.dispatch({} as any, "turn/start", { threadId: "thread-1", text: "continue" });
  assert.equal(desktop.sent.length, 0);
  assert.equal(firstCodex.calls.at(-1)?.method, "turn/start");
  firstStore.close();

  const reopenedStore = new BridgeStore(dbPath);
  const reopenedCodex = new FakeCodex();
  const reopenedServer = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath, codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    reopenedStore,
    reopenedCodex as any,
    { send: async () => {} } as any,
    desktop as any,
  );
  await reopenedServer.dispatch({} as any, "thread/list", { limit: 20 });
  await reopenedServer.dispatch({} as any, "turn/start", { threadId: "thread-1", text: "after restart" });
  assert.equal(reopenedStore.threadOwner("thread-1"), "bridge");
  assert.equal(desktop.sent.length, 0);
  assert.equal(reopenedCodex.calls.at(-1)?.method, "turn/start");
  reopenedStore.close();
});

test("unknown owners never fall through to app-server writes when Desktop Attach is offline", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-owner-unknown-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  codex.activeTurns.set("unknown-thread", "turn-1");
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    codex as any,
    { send: async () => {} } as any,
  );

  await assert.rejects(
    server.dispatch({} as any, "turn/start", { threadId: "unknown-thread", text: "blocked" }),
    (error: any) => error?.nameCode === "THREAD_BUSY_EXTERNAL",
  );
  await assert.rejects(
    server.dispatch({} as any, "turn/steer", { threadId: "unknown-thread", expectedTurnId: "turn-1", text: "blocked" }),
    (error: any) => error?.nameCode === "THREAD_BUSY_EXTERNAL",
  );
  await assert.rejects(
    server.dispatch({} as any, "turn/interrupt", { threadId: "unknown-thread", turnId: "turn-1" }),
    (error: any) => error?.nameCode === "THREAD_BUSY_EXTERNAL",
  );
  assert.equal(codex.calls.filter((call) => ["turn/start", "turn/steer", "turn/interrupt"].includes(call.method)).length, 0);
  store.close();
});

test("annotates Desktop task reads and rejects unconfirmed writes", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-desktop-owner-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  const desktop = new FakeDesktopAttach();
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    codex as any,
    { send: async () => {} } as any,
    desktop as any,
  );

  const read = await server.dispatch({} as any, "thread/read", { threadId: "desktop-thread" });
  assert.equal(read.thread.source, "desktop");
  assert.equal(read.thread.capabilities.interrupt, false);

  await assert.rejects(
    server.dispatch({} as any, "turn/start", { threadId: "unknown-thread", text: "blocked" }),
    (error: any) => error?.nameCode === "THREAD_BUSY_EXTERNAL",
  );
  assert.equal(codex.calls.filter((call) => call.method === "turn/start").length, 0);
  store.close();
});
