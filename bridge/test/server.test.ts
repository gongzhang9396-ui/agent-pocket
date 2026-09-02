import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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
  goalError?: Error;
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "thread/goal/set" && this.goalError) throw this.goalError;
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
  failProjects = false;
  failCreate = false;
  createError?: Error;
  failSend = false;
  sendError?: Error;
  failRead = false;
  projects: any[] = [];
  createCalls: any[] = [];
  readCalls: any[] = [];
  sent: any[] = [];
  waitCalls: any[] = [];
  waitResults: any[] = [];
  activeWaits = 0;
  maxActiveWaits = 0;
  threadIds = ["desktop-thread"];
  threadCwd = "";
  async listThreadsNormalized(limit: number, search?: string) {
    this.calls.push({ limit, search });
    if (this.fail) throw new Error("plugin unavailable");
    return { data: this.threadIds.map((id) => ({ id, source: "desktop" })), source: "desktop", readOnly: false };
  }
  async listProjectsNormalized() {
    if (this.failProjects) throw new Error("desktop project list failed");
    return { data: this.projects, source: "desktop" };
  }
  async createThread(cwd: string, text: string, model?: string, effort?: string, workspaceMode = "local") {
    this.createCalls.push({ cwd, text, model, effort, workspaceMode });
    if (this.createError) throw this.createError;
    if (this.failCreate) throw new Error("desktop create failed");
    return {
      source: "desktop",
      hostId: "local",
      thread: { id: "desktop-created", name: "Created", cwd, source: "desktop" },
    };
  }
  async readThreadNormalized(threadId: string, turnLimit = 10, cursor?: string) {
    this.readCalls.push(cursor ? { threadId, turnLimit, cursor } : { threadId, turnLimit });
    if (this.failRead) throw new Error("desktop read failed with private details");
    if (!this.threadIds.includes(threadId)) throw new Error("Desktop task was not found");
    return {
      source: "desktop",
      thread: {
        id: threadId,
        kind: "codex",
        name: "Desktop task",
        cwd: this.threadCwd,
        status: { type: "idle" },
        turns: [{ id: "desktop-turn", status: "completed", items: [] }],
        source: "desktop",
      },
    };
  }
  async sendMessage(threadId: string, text: string) {
    if (this.sendError) throw this.sendError;
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
  await new Promise((resolve) => setTimeout(resolve, 400));
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
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
  const desktop = new FakeDesktopAttach();
  desktop.projects = [
    { id: "desktop-demo", name: "demo", cwd: join(root, "demo"), source: "desktop" },
  ];
  const server = new BridgeServer({
    bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base,
    codexCommand: "fake", minCodexVersion: "1", projectRoots: [root], hostName: "test-host",
  }, store, codex as any, { send: async () => {} } as any, desktop as any);
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

test("writes a fail-closed runtime status across app-server and Desktop activity", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-runtime-"));
  const statusPath = join(base, "host-runtime.json");
  const maintenancePath = join(base, "host-maintenance.json");
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  const desktop = new FakeDesktopAttach();
  const waiting = deferred<any>();
  desktop.waitResults.push(waiting.promise);
  const server = new BridgeServer({
    bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base,
    codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h",
    runtimeStatusPath: statusPath, maintenancePath,
  }, store, codex as any, { send: async () => {} } as any, desktop as any);

  await server.start();
  assert.deepEqual(
    (({ running, activeTaskCount, maintenance }) => ({ running, activeTaskCount, maintenance }))(readJson(statusPath)),
    { running: true, activeTaskCount: 0, maintenance: false },
  );

  server.onCodexNotification({ method: "turn/started", params: { threadId: "app-thread", turn: { id: "app-turn" } } });
  assert.equal(readJson(statusPath).activeTaskCount, 1);
  server.onCodexNotification({ method: "turn/completed", params: { threadId: "app-thread", turn: { id: "app-turn" } } });
  assert.equal(readJson(statusPath).activeTaskCount, 0);

  server.startDesktopWatcher("desktop-thread");
  assert.equal(readJson(statusPath).activeTaskCount, 1);
  waiting.resolve({ cursor: "done:1", changed: true, threadStatus: "idle", turnStatus: "completed", timedOut: false });
  await server.desktopWatchers.get("desktop-thread")?.task;
  assert.equal(readJson(statusPath).activeTaskCount, 0);

  await server.stop();
  const stopped = readJson(statusPath);
  assert.equal(stopped.running, false);
  assert.equal(stopped.activeTaskCount, 0);
  assert.equal(stopped.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(stopped.updatedAt)));
  store.close();
});

test("maintenance lock blocks new writes until it expires while interrupt remains available", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-maintenance-"));
  const maintenancePath = join(base, "host-maintenance.json");
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  codex.markTurn("bridge-thread", "turn-1");
  store.setThreadOwner("bridge-thread", "bridge");
  const server = new BridgeServer({
    bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base,
    codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h",
    runtimeStatusPath: join(base, "host-runtime.json"), maintenancePath,
  }, store, codex as any, { send: async () => {} } as any);

  writeFileSync(maintenancePath, JSON.stringify({ version: 1, requestId: "update-1", expiresAt: Date.now() + 60_000 }));
  await assert.rejects(
    server.dispatch({} as any, "turn/start", { threadId: "bridge-thread", text: "blocked" }),
    (error: any) => error?.nameCode === "HOST_MAINTENANCE",
  );
  await server.dispatch({} as any, "turn/interrupt", { threadId: "bridge-thread", turnId: "turn-1" });
  assert.ok(codex.calls.some((call) => call.method === "turn/interrupt"));

  writeFileSync(maintenancePath, JSON.stringify({ version: 1, requestId: "update-2", expiresAt: Date.now() - 1 }));
  const result = await server.dispatch({} as any, "turn/start", { threadId: "bridge-thread", text: "allowed" });
  assert.equal(result.turn.id, "turn-1");
  store.close();
});

test("an in-flight mutation remains visible after maintenance is requested", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-maintenance-race-"));
  const maintenancePath = join(base, "host-maintenance.json");
  const runtimeStatusPath = join(base, "host-runtime.json");
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  const gate = deferred<any>();
  const originalRequest = codex.request.bind(codex);
  codex.request = async (method: string, params: any) => {
    if (method === "turn/start") return gate.promise;
    return originalRequest(method, params);
  };
  store.setThreadOwner("bridge-thread", "bridge");
  const server = new BridgeServer({
    bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base,
    codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h",
    runtimeStatusPath, maintenancePath,
  }, store, codex as any, { send: async () => {} } as any);

  const mutation = server.dispatch({} as any, "turn/start", { threadId: "bridge-thread", text: "delayed" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(server.inFlightMutations, 1);

  writeFileSync(maintenancePath, JSON.stringify({ version: 1, requestId: "update-race", expiresAt: Date.now() + 60_000 }));
  server.writeRuntimeStatus();
  const during = readJson(runtimeStatusPath);
  assert.equal(during.maintenance, true);
  assert.equal(during.maintenanceRequestId, "update-race");
  assert.equal(during.activeTaskCount, 1);
  await assert.rejects(
    server.dispatch({} as any, "turn/start", { threadId: "bridge-thread", text: "blocked" }),
    (error: any) => error?.nameCode === "HOST_MAINTENANCE",
  );

  gate.resolve({ turn: { id: "turn-delayed" } });
  await mutation;
  assert.equal(server.inFlightMutations, 0);
  assert.equal(readJson(runtimeStatusPath).activeTaskCount, 1);
  codex.clearTurn("bridge-thread");
  server.writeRuntimeStatus();
  assert.equal(readJson(runtimeStatusPath).activeTaskCount, 0);
  store.close();
});

test("project list uses saved Desktop projects and filters paths outside the whitelist", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-project-list-"));
  const allowedRoot = join(base, "allowed");
  const allowedProject = join(allowedRoot, "demo");
  const outsideProject = join(base, "outside");
  mkdirSync(allowedProject, { recursive: true });
  mkdirSync(outsideProject, { recursive: true });
  const store = new BridgeStore(join(base, "bridge.db"));
  const desktop = new FakeDesktopAttach();
  desktop.projects = [
    { id: "allowed", name: "Allowed", cwd: allowedProject, source: "desktop" },
    { id: "outside", name: "Outside", cwd: outsideProject, source: "desktop" },
  ];
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [allowedRoot], hostName: "h" },
    store,
    new FakeCodex() as any,
    { send: async () => {} } as any,
    desktop as any,
  );

  const result = await server.dispatch({} as any, "project/list", {});
  assert.deepEqual(result.data.map((project: any) => project.id), ["allowed"]);
  assert.equal(result.excluded, 1);
  assert.equal(result.warning, undefined);

  desktop.projects = [{ id: "outside", name: "Outside", cwd: outsideProject, source: "desktop" }];
  const empty = await server.dispatch({} as any, "project/list", {});
  assert.deepEqual(empty.data, []);
  assert.match(empty.warning, /白名单/);
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

test("uses Desktop Attach inbox and preserves attach failures", async () => {
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
  await assert.rejects(
    server.dispatch({} as any, "thread/list", { limit: 20 }),
    (error: any) => error?.nameCode === "INTERNAL" && !/plugin unavailable/.test(error.message),
  );
  assert.equal(codex.calls.length, 0);
  store.close();
});

test("routes confirmed Desktop task writes through Desktop Attach without app-server fallback", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-desktop-write-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  const desktop = new FakeDesktopAttach();
  desktop.threadCwd = base;
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    codex as any,
    { send: async () => {} } as any,
    desktop as any,
  );
  desktop.waitResults.push(
    { cursor: "baseline:1", changed: false, threadStatus: "idle", timedOut: true },
    { cursor: "done:2", changed: true, threadStatus: "idle", turnId: "desktop-turn", turnStatus: "completed", wakeReason: "turnCompleted", timedOut: false, assistantText: "first reply" },
    { cursor: "baseline:3", changed: false, threadStatus: "idle", timedOut: true },
    { cursor: "done:4", changed: true, threadStatus: "idle", turnId: "desktop-turn-2", turnStatus: "completed", wakeReason: "turnCompleted", timedOut: false, assistantText: "second reply" },
  );

  await server.dispatch({} as any, "thread/list", { limit: 20 });
  const started = await server.dispatch({} as any, "turn/start", { threadId: "desktop-thread", text: "first", clientMessageId: "mobile-first" });
  const steered = await server.dispatch({} as any, "turn/steer", { threadId: "desktop-thread", expectedTurnId: "desktop-turn", text: "second", clientMessageId: "mobile-second" });
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
  assert.ok(syncEvents.every((event) => event.threadId === "desktop-thread"));
  assert.ok(syncEvents.every((event) => (event.payload as any).reason === "desktop-wait"));
  assert.equal(server.desktopWatchers.size, 0);
  const desktopMessageEvents = store.eventsAfter(0).filter((event) =>
    event.type === "message.delta" && (event.payload as any).source === "desktop",
  );
  assert.deepEqual(
    desktopMessageEvents.filter((event) => (event.payload as any).role === "user").map((event) => (event.payload as any).itemId),
    ["mobile-first", "mobile-second"],
  );
  assert.ok(desktopMessageEvents.some((event) => (event.payload as any).role === "assistant"));
  const refreshed = await server.dispatch({} as any, "thread/read", { threadId: "desktop-thread" });
  const refreshedItems = refreshed.thread.turns.flatMap((turn: any) => turn.items || []);
  assert.ok(refreshedItems.some((item: any) => item.id === "mobile-first" && item.type === "userMessage"));
  assert.ok(refreshedItems.some((item: any) => item.id === "mobile-second" && item.type === "userMessage"));
  assert.ok(refreshedItems.some((item: any) => item.type === "agentMessage" && ["first reply", "second reply"].includes(item.text)));

  desktop.sendError = new Error(
    "function_call_output requires call_id on HTTP requests; continuation via previous_response_id is only supported on Responses WebSocket v2",
  );
  await assert.rejects(
    server.dispatch({} as any, "turn/start", { threadId: "desktop-thread", text: "continue over http" }),
    (error: any) => error?.nameCode === "VERSION_UNSUPPORTED" &&
      /HTTP Responses/.test(error.message) &&
      /新建和续写/.test(error.message) &&
      !/function_call_output|previous_response_id/.test(error.message),
  );
  desktop.sendError = undefined;
  desktop.failSend = true;
  await assert.rejects(
    server.dispatch({} as any, "turn/start", { threadId: "desktop-thread", text: "must not fall back" }),
    (error: any) => error?.nameCode === "INTERNAL" && !/desktop send failed/.test(error.message),
  );
  assert.equal(codex.calls.length, 0);
  store.close();
});

test("creates new tasks through Codex Desktop without app-server fallback", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-desktop-create-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  const desktop = new FakeDesktopAttach();
  desktop.waitResults.push({
    cursor: "created:1",
    changed: true,
    threadStatus: "idle",
    turnId: "desktop-turn",
    turnStatus: "completed",
    wakeReason: "turnCompleted",
    timedOut: false,
  });
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    codex as any,
    { send: async () => {} } as any,
    desktop as any,
  );

  const created = await server.dispatch({} as any, "thread/start", {
    target: "desktop",
    workspaceMode: "local",
    cwd: base,
    text: "create on Desktop",
    model: "gpt-test",
    effort: "high",
  });
  assert.equal(created.source, "desktop");
  assert.equal(created.thread.id, "desktop-created");
  assert.equal(created.thread.source, "desktop");
  assert.equal(store.threadOwner("desktop-created"), "desktop");
  assert.deepEqual(desktop.createCalls, [{
    cwd: base,
    text: "create on Desktop",
    model: "gpt-test",
    effort: "high",
    workspaceMode: "local",
  }]);
  assert.equal(codex.calls.filter((call) => ["thread/start", "turn/start"].includes(call.method)).length, 0);
  await settleWatcher();

  desktop.createError = new Error(
    "Codex Desktop created the task but failed to initialize it: function_call_output requires call_id on HTTP requests; continuation via previous_response_id is only supported on Responses WebSocket v2",
  );
  await assert.rejects(
    server.dispatch({} as any, "thread/start", {
      target: "desktop",
      workspaceMode: "local",
      cwd: base,
      text: "explain the Desktop regression",
      model: "gpt-test",
      effort: "medium",
    }),
    (error: any) => error?.nameCode === "VERSION_UNSUPPORTED" &&
      /HTTP Responses/.test(error.message) &&
      /WebSocket v2/.test(error.message) &&
      /新建和续写/.test(error.message) &&
      !/function_call_output|previous_response_id/.test(error.message),
  );
  desktop.createError = undefined;

  desktop.failCreate = true;
  await assert.rejects(
    server.dispatch({} as any, "thread/start", {
      target: "desktop",
      workspaceMode: "local",
      cwd: base,
      text: "must not fall back",
      model: "gpt-test",
      effort: "medium",
    }),
    (error: any) => error?.nameCode === "INTERNAL" && !/desktop create failed/.test(error.message),
  );
  assert.equal(codex.calls.filter((call) => ["thread/start", "turn/start"].includes(call.method)).length, 0);
  store.close();
});

test("Desktop watcher requests one correction and recovers after a transient wait failure", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-desktop-wait-fallback-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const desktop = new FakeDesktopAttach();
  desktop.threadCwd = base;
  desktop.waitResults.push(
    { cursor: "baseline:1", changed: false, threadStatus: "idle", timedOut: true },
    new Error("wait schema changed and included secret text"),
    { cursor: "done:2", changed: true, threadStatus: "idle", turnId: "turn-2", turnStatus: "completed", wakeReason: "turnCompleted", timedOut: false },
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
  assert.equal(events.length, 2);
  assert.equal(events.filter((event) => (event.payload as any).reason === "desktop-wait-fallback").length, 1);
  assert.equal(events.some((event) => (event.payload as any).reason === "desktop-wait"), true);
  assert.equal(JSON.stringify(events).includes("secret text"), false);
  assert.equal(server.desktopWatchers.size, 0);
  store.close();
});

test("keeps only one Desktop watcher while the same task receives another prompt", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-desktop-wait-singleton-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const desktop = new FakeDesktopAttach();
  desktop.threadCwd = base;
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

  await firstServer.dispatch({} as any, "thread/start", { target: "bridge", cwd: base, text: "create", model: "gpt-test", effort: "medium" });
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

test("unknown owners never fall through to app-server writes and report not found", async () => {
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
    (error: any) => error?.nameCode === "NOT_FOUND",
  );
  await assert.rejects(
    server.dispatch({} as any, "turn/steer", { threadId: "unknown-thread", expectedTurnId: "turn-1", text: "blocked" }),
    (error: any) => error?.nameCode === "NOT_FOUND",
  );
  await assert.rejects(
    server.dispatch({} as any, "turn/interrupt", { threadId: "unknown-thread", turnId: "turn-1" }),
    (error: any) => error?.nameCode === "NOT_FOUND",
  );
  assert.equal(codex.calls.filter((call) => ["turn/start", "turn/steer", "turn/interrupt"].includes(call.method)).length, 0);
  store.close();
});

test("annotates Desktop task reads and rejects unknown writes without a busy error", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-desktop-owner-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  const desktop = new FakeDesktopAttach();
  desktop.threadCwd = base;
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
  assert.equal(read.thread.turns.length, 1);
  assert.deepEqual(desktop.readCalls, [{ threadId: "desktop-thread", turnLimit: 10 }]);
  await server.dispatch({} as any, "thread/read", { threadId: "desktop-thread", cursor: "older:1" });
  assert.deepEqual(desktop.readCalls.at(-1), { threadId: "desktop-thread", turnLimit: 10, cursor: "older:1" });
  await assert.rejects(
    server.dispatch({} as any, "thread/read", { threadId: "desktop-thread", cursor: "" }),
    (error: any) => error?.nameCode === "INVALID_REQUEST",
  );
  assert.equal(codex.calls.filter((call) => call.method === "thread/read").length, 0);

  await assert.rejects(
    server.dispatch({} as any, "turn/start", { threadId: "unknown-thread", text: "blocked" }),
    (error: any) => error?.nameCode === "NOT_FOUND",
  );
  assert.equal(codex.calls.filter((call) => call.method === "turn/start").length, 0);
  store.close();
});

test("reads persisted Bridge tasks only through the independent app-server", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-bridge-read-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  const desktop = new FakeDesktopAttach();
  desktop.threadCwd = base;
  store.setThreadOwner("bridge-thread", "bridge");
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    codex as any,
    { send: async () => {} } as any,
    desktop as any,
  );

  const read = await server.dispatch({} as any, "thread/read", { threadId: "bridge-thread" });
  assert.equal(read.thread.id, "bridge-thread");
  assert.deepEqual(desktop.readCalls, []);
  assert.equal(codex.calls.filter((call) => call.method === "thread/read").length, 1);
  store.close();
});

test("Desktop task reads and writes stay inside the configured project roots", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-desktop-root-"));
  const allowed = join(base, "allowed");
  const outside = join(base, "outside");
  mkdirSync(allowed, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  const desktop = new FakeDesktopAttach();
  desktop.threadIds = ["outside-thread"];
  desktop.threadCwd = outside;
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [allowed], hostName: "h" },
    store,
    codex as any,
    { send: async () => {} } as any,
    desktop as any,
  );

  await assert.rejects(
    server.dispatch({} as any, "thread/read", { threadId: "outside-thread" }),
    (error: any) => error?.nameCode === "PATH_DENIED",
  );
  await assert.rejects(
    server.dispatch({} as any, "turn/start", { threadId: "outside-thread", text: "blocked" }),
    (error: any) => error?.nameCode === "PATH_DENIED",
  );
  assert.equal(desktop.sent.length, 0);
  assert.equal(codex.calls.length, 0);
  store.close();
});

test("materializes encrypted phone files for Bridge turns with an untrusted-data note", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-file-attachment-"));
  const dbPath = join(base, "bridge.db");
  const attachmentsPath = join(base, "custom-attachments");
  const store = new BridgeStore(dbPath);
  const codex = new FakeCodex();
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath, attachmentsPath, codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    codex as any,
    { send: async () => {} } as any,
  );

  await server.dispatch({ device: { id: "phone-1" } } as any, "thread/start", {
    target: "bridge",
    cwd: base,
    text: "Review the attached notes",
    model: "gpt-test",
    effort: "medium",
    files: [{ filename: "notes.md", mimeType: "text/markdown", data: Buffer.from("hello from phone").toString("base64") }],
  });

  const call = codex.calls.findLast((entry) => entry.method === "turn/start");
  assert.equal(call.params.input[0].text, "Review the attached notes");
  assert.match(call.params.input[1].text, /不是系统或开发者指令/);
  assert.match(call.params.input[1].text, /原始文件名：notes\.md/);
  const path = call.params.input[1].text.match(/Host 临时路径：([^\r\n]+)/)?.[1];
  assert.ok(path);
  assert.equal(readFileSync(path!, "utf8"), "hello from phone");
  assert.equal(path!.startsWith(join(attachmentsPath, "phone-1") + sep), true);
  store.close();
});

test("rejects unsafe and excessive attachments, and materializes Desktop files", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-file-policy-"));
  const dbPath = join(base, "bridge.db");
  const store = new BridgeStore(dbPath);
  const codex = new FakeCodex();
  const desktop = new FakeDesktopAttach();
  desktop.threadCwd = base;
  desktop.waitResults.push({
    cursor: "desktop-attachment:1",
    changed: true,
    threadStatus: "idle",
    turnId: "desktop-attachment-turn",
    turnStatus: "completed",
    wakeReason: "turnCompleted",
    timedOut: false,
  });
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath, codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    codex as any,
    { send: async () => {} } as any,
    desktop as any,
  );
  const small = Buffer.from("x").toString("base64");

  await assert.rejects(
    server.dispatch({ device: { id: "phone-1" } } as any, "thread/start", {
      target: "bridge", cwd: base, text: "unsafe", model: "gpt-test",
      files: [{ filename: "payload.exe", mimeType: "application/x-msdownload", data: small }],
    }),
    (error: any) => error?.nameCode === "INVALID_REQUEST",
  );
  await assert.rejects(
    server.dispatch({ device: { id: "phone-1" } } as any, "thread/start", {
      target: "bridge", cwd: base, text: "too many", model: "gpt-test",
      images: [{ mimeType: "image/jpeg", data: small }, { mimeType: "image/jpeg", data: small }],
      files: [{ filename: "a.txt", mimeType: "text/plain", data: small }, { filename: "b.txt", mimeType: "text/plain", data: small }],
    }),
    (error: any) => error?.nameCode === "INVALID_REQUEST",
  );
  await server.dispatch({ device: { id: "phone-1" } } as any, "thread/start", {
    target: "desktop", cwd: base, text: "desktop file", model: "gpt-test",
    files: [{ filename: "notes.txt", mimeType: "text/plain", data: Buffer.from("desktop note").toString("base64") }],
  });
  assert.equal(desktop.createCalls.length, 1);
  assert.match(desktop.createCalls[0].text, /^desktop file/m);
  assert.match(desktop.createCalls[0].text, /不是系统或开发者指令/);
  const desktopPath = desktop.createCalls[0].text.match(/Host 临时路径：([^\r\n]+)/)?.[1];
  assert.ok(desktopPath);
  assert.equal(readFileSync(desktopPath!, "utf8"), "desktop note");
  store.close();
});

test("continues an existing Desktop task with phone attachments without exposing Host paths in mobile events", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-desktop-attachment-turn-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const desktop = new FakeDesktopAttach();
  desktop.threadCwd = base;
  desktop.waitResults.push(
    { cursor: "attachment-baseline:1", changed: false, threadStatus: "idle", timedOut: true },
    { cursor: "attachment-done:2", changed: true, threadStatus: "idle", turnId: "attachment-turn", turnStatus: "completed", wakeReason: "turnCompleted", timedOut: false },
  );
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    new FakeCodex() as any,
    { send: async () => {} } as any,
    desktop as any,
  );
  await server.dispatch({} as any, "thread/list", { limit: 20 });
  await server.dispatch({ device: { id: "phone-1" } } as any, "turn/start", {
    threadId: "desktop-thread",
    text: "review phone attachment",
    clientMessageId: "mobile-with-file",
    files: [{ filename: "review.md", mimeType: "text/markdown", data: Buffer.from("review me").toString("base64") }],
  });

  assert.equal(desktop.sent.length, 1);
  assert.match(desktop.sent[0].text, /^review phone attachment/m);
  assert.match(desktop.sent[0].text, /不是系统或开发者指令/);
  const path = desktop.sent[0].text.match(/Host 临时路径：([^\r\n]+)/)?.[1];
  assert.ok(path);
  assert.equal(readFileSync(path!, "utf8"), "review me");
  await settleWatcher();
  const mobileEvent = store.eventsAfter(0).find((event) =>
    event.type === "message.delta" && (event.payload as any).itemId === "mobile-with-file",
  );
  assert.equal((mobileEvent?.payload as any)?.delta, "review phone attachment");
  assert.doesNotMatch((mobileEvent?.payload as any)?.delta || "", /Host 临时路径/);
  store.close();
});

test("advertises attachment capabilities so new phones fail closed against old Hosts", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-capabilities-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    new FakeCodex() as any,
    { send: async () => {} } as any,
  );

  const hello = await server.dispatchRelay("phone-1", "bridge/hello", { protocolVersion: 1, deviceId: "phone-1" });
  assert.ok(hello.capabilities.includes("attachments-v1"));
  assert.ok(hello.capabilities.includes("goal-v1"));
  assert.ok(hello.capabilities.includes("plan-v1"));
  store.close();
});

test("cleans expired plaintext attachments when the Host process starts", () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-attachment-cleanup-"));
  const dbPath = join(base, "bridge.db");
  const attachmentsPath = join(base, "custom-attachments");
  const deviceRoot = join(attachmentsPath, "phone-1");
  const stale = join(deviceRoot, "00000000-0000-4000-8000-000000000001.txt");
  mkdirSync(deviceRoot, { recursive: true });
  writeFileSync(stale, "sensitive");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  const store = new BridgeStore(dbPath);

  new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath, attachmentsPath, codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    new FakeCodex() as any,
    { send: async () => {} } as any,
  );

  assert.equal(existsSync(stale), false);
  store.close();
});

test("refuses shared or linked attachment directories without deleting user files", () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-attachment-boundary-"));
  const shared = join(base, "shared");
  const personalFile = join(shared, "keep.txt");
  mkdirSync(shared);
  writeFileSync(personalFile, "keep me");
  const sharedStore = new BridgeStore(join(base, "shared.db"));
  const sharedServer = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "shared.db"), attachmentsPath: shared, codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    sharedStore,
    new FakeCodex() as any,
    { send: async () => {} } as any,
  );
  assert.throws(
    () => sharedServer.materializeAttachments("phone-1", [{ mimeType: "image/jpeg", bytes: Buffer.from("image") }], []),
    (error: any) => error?.nameCode === "PATH_DENIED",
  );
  assert.equal(readFileSync(personalFile, "utf8"), "keep me");
  sharedStore.close();

  const outside = join(base, "outside");
  const linked = join(base, "linked");
  mkdirSync(outside);
  symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
  const linkedStore = new BridgeStore(join(base, "linked.db"));
  const linkedServer = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "linked.db"), attachmentsPath: linked, codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    linkedStore,
    new FakeCodex() as any,
    { send: async () => {} } as any,
  );
  assert.throws(
    () => linkedServer.materializeAttachments("phone-1", [{ mimeType: "image/jpeg", bytes: Buffer.from("image") }], []),
    (error: any) => error?.nameCode === "PATH_DENIED",
  );
  assert.deepEqual(readdirSync(outside), []);
  linkedStore.close();
});

test("starts the first turn once and reports a Goal warning instead of failing creation", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-goal-warning-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  codex.goalError = new Error("goal API unavailable");
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    codex as any,
    { send: async () => {} } as any,
  );

  const result = await server.dispatch({ device: { id: "phone-1" } } as any, "thread/start", {
    target: "bridge", cwd: base, text: "create once", model: "gpt-test", effort: "medium", goal: "ship safely",
  });
  assert.equal(result.thread.id, "thread-1");
  assert.match(result.warning, /Goal 保存失败/);
  assert.deepEqual(codex.calls.filter((call) => call.method === "thread/goal/set").map((call) => call.params.objective), ["ship safely"]);
  assert.equal(codex.calls.filter((call) => call.method === "turn/start").length, 1);
  assert.ok(codex.calls.findIndex((call) => call.method === "thread/goal/set") < codex.calls.findIndex((call) => call.method === "turn/start"));
  store.close();
});

test("uses the selected model and full collaboration mode for Plan tasks", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-plan-create-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    codex as any,
    { send: async () => {} } as any,
  );

  await server.dispatch({ device: { id: "phone-1" } } as any, "thread/start", {
    target: "bridge", cwd: base, text: "make a careful plan", model: "gpt-5.6-luna", effort: "high", mode: "plan",
  });

  assert.deepEqual(codex.calls.find((call) => call.method === "thread/start")?.params, {
    cwd: base,
    model: "gpt-5.6-luna",
    approvalPolicy: "on-request",
  });
  assert.deepEqual(codex.calls.find((call) => call.method === "turn/start")?.params, {
    threadId: "thread-1",
    input: [{ type: "text", text: "make a careful plan" }],
    model: "gpt-5.6-luna",
    effort: "high",
    collaborationMode: {
      mode: "plan",
      settings: {
        model: "gpt-5.6-luna",
        reasoning_effort: "high",
        developer_instructions: null,
      },
    },
  });
  store.close();
});

test("requests only unarchived app-server tasks", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-active-list-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const codex = new FakeCodex();
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    codex as any,
    { send: async () => {} } as any,
  );

  await server.dispatch({} as any, "thread/list", { limit: 25 });
  assert.equal(codex.calls.find((call) => call.method === "thread/list")?.params.archived, false);
  store.close();
});

test("requests a fresh Host snapshot when archive membership changes", () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-archive-event-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    new FakeCodex() as any,
    { send: async () => {} } as any,
  );

  server.onCodexNotification({ method: "thread/archived", params: { threadId: "thread-1" } });
  server.onCodexNotification({ method: "thread/unarchived", params: { threadId: "thread-2" } });
  const events = store.eventsAfter(0).filter((event) => event.type === "sync.required");
  assert.deepEqual(events.map((event) => event.payload), [
    { reason: "thread-list-changed", change: "archived" },
    { reason: "thread-list-changed", change: "unarchived" },
  ]);
  store.close();
});

test("rejects non-canonical attachment base64", async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-base64-"));
  const store = new BridgeStore(join(base, "bridge.db"));
  const server = new BridgeServer(
    { bindHost: "127.0.0.1", port: 0, dbPath: join(base, "bridge.db"), codexHome: base, codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "h" },
    store,
    new FakeCodex() as any,
    { send: async () => {} } as any,
  );
  await assert.rejects(
    server.dispatch({ device: { id: "phone-1" } } as any, "thread/start", {
      target: "bridge", cwd: base, text: "bad base64", model: "gpt-test",
      files: [{ filename: "notes.txt", mimeType: "text/plain", data: "AA=" }],
    }),
    (error: any) => error?.nameCode === "INVALID_REQUEST",
  );
  store.close();
});
