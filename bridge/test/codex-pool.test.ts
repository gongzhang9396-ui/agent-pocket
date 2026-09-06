import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServer } from "../src/codex.ts";
import { CodexThreadPool } from "../src/codex-pool.ts";

class FakeWorker extends CodexAppServer {
  name: string;
  loaded = new Set<string>();
  states = new Map<string, any>();
  goals = new Map<string, any>();
  terminals: any[] = [];
  queue: any[] = [];
  calls: any[] = [];
  replies: any[] = [];
  closes = 0;
  kills = 0;
  closeError?: Error;
  hook?: (method: string, params: any) => Promise<any> | undefined;
  constructor(name: string) {
    super({ command: "fake", codexHome: ".", minVersion: "1" });
    this.name = name;
    this.readOnly = false;
  }
  override async start() { return { version: "fake", readOnly: false, error: undefined }; }
  override async request(method: string, params: any = {}) {
    this.calls.push({ method, params });
    const override = this.hook?.(method, params);
    if (override) return override;
    if (method === "thread/start" || method === "thread/resume") {
      const id = params.threadId || this.name;
      this.loaded.add(id);
      return { thread: { id }, model: "custom-model", modelProvider: "custom-api", reasoningEffort: "high" };
    }
    if (method === "thread/loaded/list") return { data: [...this.loaded], nextCursor: null };
    if (method === "thread/read") return { thread: {
      id: params.threadId, status: { type: "idle" }, turns: [{ id: "done", status: "completed", items: [] }],
      ...this.states.get(params.threadId),
    } };
    if (method === "thread/goal/get") return { goal: this.goals.get(params.threadId) ?? null };
    if (method === "thread/backgroundTerminals/list") return { data: this.terminals, nextCursor: null };
    if (method === "thread/queue/list") return { data: this.queue, nextCursor: null };
    if (method === "turn/start") return { turn: { id: `turn-${this.name}` } };
    return {};
  }
  override respond(id: string | number, result?: unknown, error?: unknown) { this.replies.push({ id, result, error }); }
  override async closeGracefully() {
    this.closing = true;
    if (this.closeError) throw this.closeError;
    this.closes++;
    this.emit("exit", new Error("closed"));
  }
  override stop() { this.kills++; }
}

function fixture(maxWorkers = 8) {
  const workers: FakeWorker[] = [];
  const pool = new CodexThreadPool({ command: "fake", codexHome: ".", minVersion: "1" }, () => {
    const worker = new FakeWorker(`thread-${workers.length + 1}`);
    workers.push(worker);
    return worker;
  }, maxWorkers);
  return { pool, workers };
}

test("release closes only the idle task worker and preserves another active task", async () => {
  const { pool, workers } = fixture();
  await pool.request("thread/start");
  await pool.request("thread/start");
  pool.markTurn("thread-2", "running");
  assert.deepEqual(await pool.releaseThread("thread-1"), { released: true, alreadyReleased: false });
  assert.equal(workers[0].closes, 1);
  assert.equal(workers[1].closes, 0);
  assert.equal(pool.activeTurns.get("thread-2"), "running");
  await pool.request("turn/steer", { threadId: "thread-2" });
  assert.equal(workers[1].calls.at(-1).method, "turn/steer");
  assert.deepEqual(await pool.releaseThread("thread-1"), { released: true, alreadyReleased: true });
});

test("release rejects active turns, pins between RPCs, and unresolved confirmation requests", async () => {
  const { pool, workers } = fixture();
  await pool.request("thread/start");
  pool.markTurn("thread-1", "running");
  await assert.rejects(pool.releaseThread("thread-1"), /仍在运行/);
  pool.clearTurn("thread-1");
  const unpin = pool.pinThread("thread-1");
  await assert.rejects(pool.releaseThread("thread-1"), /仍在运行/);
  unpin();
  workers[0].emit("serverRequest", { id: 1, method: "item/tool/requestUserInput", params: { threadId: "thread-1" } });
  await assert.rejects(pool.releaseThread("thread-1"), /待处理/);
  assert.equal(workers[0].closes, 0);
});

test("native confirmation IDs are scoped by worker and preserve number/string types", async () => {
  const { pool, workers } = fixture();
  const requests: any[] = [];
  pool.on("serverRequest", (request) => requests.push(request));
  await pool.request("thread/start");
  await pool.request("thread/start");
  workers[0].emit("serverRequest", { id: 1, method: "item/tool/requestUserInput", params: { threadId: "thread-1" } });
  workers[1].emit("serverRequest", { id: "1", method: "item/tool/requestUserInput", params: { threadId: "thread-2" } });
  assert.notEqual(requests[0].id, requests[1].id);
  pool.respond(requests[1].id, { answers: "two" });
  pool.respond(requests[0].id, { answers: "one" });
  assert.deepEqual(workers.map((worker) => worker.replies[0]), [
    { id: 1, result: { answers: "one" }, error: undefined },
    { id: "1", result: { answers: "two" }, error: undefined },
  ]);
  assert.throws(() => pool.respond(requests[0].id, {}), /已经退出/);
});

for (const status of ["active", "paused", "blocked", "usageLimited", "budgetLimited"]) {
  test(`release preserves a ${status} goal`, async () => {
    const { pool, workers } = fixture();
    await pool.request("thread/start");
    workers[0].goals.set("thread-1", { status });
    await assert.rejects(pool.releaseThread("thread-1"), /持续目标/);
    assert.equal(workers[0].closes, 0);
  });
}

test("release preserves background commands, queued submissions, and active children", async () => {
  const { pool, workers } = fixture();
  await pool.request("thread/start");
  workers[0].terminals = [{ processId: "background" }];
  await assert.rejects(pool.releaseThread("thread-1"), /后台命令/);
  workers[0].terminals = [];
  workers[0].queue = [{ id: "queued" }];
  await assert.rejects(pool.releaseThread("thread-1"), /排队指令/);
  workers[0].queue = [];
  workers[0].loaded.add("child");
  workers[0].states.set("child", { status: { type: "active" } });
  await assert.rejects(pool.releaseThread("thread-1"), /子任务尚未空闲/);
  assert.equal(workers[0].closes, 0);
});

test("unknown protocol state and activity during inspection leave the writer alive", async () => {
  const { pool, workers } = fixture();
  await pool.request("thread/start");
  workers[0].hook = (method) => method === "thread/queue/list" ? Promise.reject(new Error("Unknown method")) : undefined;
  await assert.rejects(pool.releaseThread("thread-1"), /尚不能确认/);
  workers[0].hook = (method) => {
    if (method === "thread/goal/get") {
      workers[0].emit("notification", { method: "turn/started", params: { threadId: "thread-1", turn: { id: "late" } } });
      return Promise.resolve({ goal: null });
    }
  };
  await assert.rejects(pool.releaseThread("thread-1"), /状态发生变化/);
  assert.equal(workers[0].closes, 0);
});

test("writes cannot enter while release is checking upstream state", async () => {
  const { pool, workers } = fixture();
  await pool.request("thread/start");
  let inspected!: () => void;
  const entered = new Promise<void>((resolve) => { inspected = resolve; });
  let finish!: (value: any) => void;
  const gate = new Promise((resolve) => { finish = resolve; });
  workers[0].hook = (method) => {
    if (method === "thread/goal/get") { inspected(); return gate; }
  };
  const release = pool.releaseThread("thread-1");
  await entered;
  await assert.rejects(pool.request("turn/start", { threadId: "thread-1" }), /正在交接/);
  finish({ goal: null });
  await release;
  assert.equal(workers[0].calls.filter((call) => call.method === "turn/start").length, 0);
});

test("close timeout never force-kills or reuses the closing writer", async () => {
  const { pool, workers } = fixture();
  await pool.request("thread/start");
  workers[0].closeError = new Error("timeout");
  await assert.rejects(pool.releaseThread("thread-1"), /尚不能确认/);
  await assert.rejects(pool.request("thread/resume", { threadId: "thread-1" }), /正在交接/);
  assert.equal(workers[0].kills, 0);
  assert.equal(workers.length, 1);
});

test("uncertain mutation timeout prevents release", async () => {
  const { pool, workers } = fixture();
  await pool.request("thread/start");
  workers[0].hook = (method) => method === "turn/start" ? Promise.reject(new Error("Codex RPC timeout: turn/start")) : undefined;
  await assert.rejects(pool.request("turn/start", { threadId: "thread-1" }), /timeout/);
  await assert.rejects(pool.releaseThread("thread-1"), /尚不确定/);
  assert.equal(workers[0].closes, 0);
});

test("capacity reclamation releases idle workers and preserves active ones", async () => {
  const { pool, workers } = fixture(1);
  await pool.request("thread/start");
  pool.markTurn("thread-1", "active");
  await assert.rejects(pool.request("thread/start"), /执行器已满/);
  assert.equal(workers.length, 1);
  pool.clearTurn("thread-1");
  await pool.request("thread/start");
  assert.equal(workers.length, 2);
  assert.equal(workers[0].closes, 1);
});

test("startup failure before spawn frees the task mapping and worker capacity", async () => {
  let attempts = 0;
  const pool = new CodexThreadPool({ command: "fake", codexHome: ".", minVersion: "1" }, () => {
    const worker = new FakeWorker("new-task");
    if (++attempts === 1) worker.start = async () => { throw new Error("version check failed"); };
    return worker;
  }, 1);
  await assert.rejects(pool.request("thread/resume", { threadId: "existing" }), /version check failed/);
  const result = await pool.request("thread/resume", { threadId: "existing" });
  assert.equal(attempts, 2);
  assert.equal(result.thread.id, "existing");
});

test("resolved requests clear only the matching worker and native ID", async () => {
  const { pool, workers } = fixture();
  const requests: any[] = [];
  pool.on("serverRequest", (request) => requests.push(request));
  await pool.request("thread/start");
  await pool.request("thread/start");
  for (const worker of workers) worker.emit("serverRequest", { id: 1, method: "item/tool/requestUserInput", params: { threadId: worker.name } });
  workers[0].emit("notification", { method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 1 } });
  await pool.releaseThread("thread-1");
  await assert.rejects(pool.releaseThread("thread-2"), /待处理/);
  pool.respond(requests[1].id, { answers: [] });
  await pool.releaseThread("thread-2");
});
