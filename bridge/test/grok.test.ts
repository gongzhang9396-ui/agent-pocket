import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BridgeStore } from "../src/store.ts";
import { GrokAgent } from "../src/grok.ts";
import { AcpClient } from "../src/acp-client.ts";
import { BridgeServer } from "../src/server.ts";

const fixture = fileURLToPath(new URL("fixtures/grok-acp.mjs", import.meta.url));
function setup() {
  const root = mkdtempSync(join(tmpdir(), "ap-grok-"));
  const db = join(root, "bridge.db");
  const store = new BridgeStore(db);
  const factory = (_args: string[], cwd: string) => new AcpClient(process.execPath, [fixture], cwd);
  const grok = new GrokAgent(store, [root], "fixture", factory);
  const codex = Object.assign(new EventEmitter(), { readOnly: false, activeTurns: new Map(), calls: [] as any[],
    request: async function(method: string) { this.calls.push(method); if (method === "model/list" || method === "thread/list") return { data: [] }; throw new Error("Codex must not execute Grok methods"); } });
  const server = new BridgeServer({ dbPath: db, bindHost: "127.0.0.1", port: 0, projectRoots: [root], codexHome: root, codexCommand: "unused", minCodexVersion: "1", hostName: "fixture" } as any,
    store, codex as any, { send: async () => {} } as any, undefined, grok);
  const rpc = (method: string, params: any = {}) => server.dispatchRelay("fixture-device", method, params);
  return { root, db, store, grok, server, codex, rpc, factory };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("condition timed out"); await new Promise(r => setTimeout(r, 10)); }
}
async function create(ctx: ReturnType<typeof setup>, text: string, id = text) {
  return ctx.rpc("thread/start", { agentId: "grok", cwd: ctx.root, text, clientMessageId: id });
}

test("Grok ACP streams through Server, persists history, resumes same native session after restart", async () => {
  const c = setup();
  try {
    const agents = await c.rpc("agent/list");
    assert.equal(agents.data.find((a: any) => a.id === "grok").models[0].agentId, "grok");
    assert.equal(agents.data.find((a: any) => a.id === "grok").models[0].id, "grok-fixture");
    assert.equal(agents.data.find((a: any) => a.id === "grok").models[0].supportedReasoningEfforts[0].reasoningEffort, "low");
    const { thread } = await create(c, "hello");
    await until(() => !c.grok.active.size);
    const page = await c.rpc("thread/read", { threadId: thread.id });
    assert.equal(page.thread.execution.backend, "grok");
    assert.equal(page.thread.turns[0].items[0].type, "userMessage");
    assert.equal(page.thread.turns[0].items[1].text, "hello 世界");
    assert.equal((await c.rpc("thread/list")).data[0].id, thread.id);
    await c.server.stop(); c.store.close();
    const store = new BridgeStore(c.db);
    const restarted = new GrokAgent(store, [c.root], "fixture", c.factory);
    await restarted.start(thread.id, "second", "second");
    await until(() => !restarted.active.size);
    const history = restarted.read(thread.id).thread.turns;
    assert.equal(history.length, 2);
    assert.ok(!JSON.stringify(history).includes("REPLAY MUST NOT"));
    const prompts = readFileSync(join(c.root, "prompts.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(prompts[0].sessionId, prompts[1].sessionId);
    await restarted.stop(); store.close();
  } finally { await c.server.stop(); try { c.store.close(); } catch {} }
});

test("permissions route by live Grok process, only allow once, survive history refresh, reject stale or cross-agent methods", async () => {
  const c = setup();
  try {
    const first = await create(c, "approve");
    const second = await create(c, "approve-always-only");
    await until(() => c.grok.permissions.size === 2);
    const ids = [...c.grok.permissions.keys()];
    const once = ids.find(id => c.grok.permissions.get(id)!.run.task.id === first.thread.id)!;
    const always = ids.find(id => id !== once)!;
    await assert.rejects(c.rpc("approval/respond", { requestId: always, decision: "allowOnce" }), /永久/);
    const history = await c.rpc("thread/read", { threadId: first.thread.id });
    assert.equal(history.thread.turns[0].items.at(-1).requestId, once);
    assert.deepEqual(history.thread.status.activeFlags, ["waitingOnApproval"]);
    await c.rpc("approval/respond", { requestId: once, decision: "allowOnce" });
    assert.equal((await c.rpc("approval/respond", { requestId: once, decision: "allowOnce" })).duplicate, true);
    await c.rpc("approval/respond", { requestId: always, decision: "deny" });
    await until(() => !c.grok.active.size);
    const text = JSON.stringify(c.grok.read(second.thread.id));
    assert.ok(text.includes('deny'));
    for (const method of ["turn/steer", "thread/handoff", "goal/get", "goal/set", "question/respond"]) {
      await assert.rejects(c.rpc(method, { threadId: first.thread.id, requestId: once }));
    }
    assert.equal(c.codex.calls.length, 0);
  } finally { await c.server.stop(); c.store.close(); }
});

test("Grok busy, idempotent send, cancellation and crash retain transcript without automatic replay", async () => {
  const c = setup();
  try {
    const result = await create(c, "hang");
    await assert.rejects(c.rpc("turn/start", { threadId: result.thread.id, text: "race" }), /正在执行/);
    assert.equal((await create(c, "hang")).duplicate, true);
    await c.rpc("turn/interrupt", { threadId: result.thread.id, turnId: result.turn.id });
    await until(() => !c.grok.active.size);
    assert.equal(c.grok.read(result.thread.id).thread.turns[0].status, "interrupted");
    await c.rpc("turn/start", { threadId: result.thread.id, text: "crash", clientMessageId: "crash" });
    await until(() => !c.grok.active.size);
    assert.equal(c.grok.read(result.thread.id).thread.turns.at(-1).status, "failed");
    assert.equal(c.grok.read(result.thread.id).thread.status.type, "systemError");
    assert.equal((await c.rpc("turn/start", { threadId: result.thread.id, text: "crash", clientMessageId: "crash" })).duplicate, true);
    const prompts = readFileSync(join(c.root, "prompts.ndjson"), "utf8").trim().split("\n");
    assert.equal(prompts.length, 2);
  } finally { await c.server.stop(); c.store.close(); }
});

test("large Unicode Grok output pages by bytes with stable cursors and complete text; tools retain partial update fields", async () => {
  const c = setup();
  try {
    const { thread } = await create(c, "large");
    await until(() => !c.grok.active.size);
    let cursor: string | undefined; const pages: any[] = [];
    do {
      const page = await c.rpc("thread/read", { threadId: thread.id, cursor });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 768 * 1024);
      pages.unshift(page.thread.turns.flatMap((t: any) => t.items)); cursor = page.page.nextCursor;
    } while (cursor);
    assert.equal(pages.flat().filter(i => i.type === "agentMessage").map(i => i.text).join(""), '中文🙂'.repeat(100000));
    const earlier = c.grok.read(thread.id).page.nextCursor;
    await assert.rejects(c.rpc("thread/read", { threadId: thread.id, cursor: "ap-grok-v1:invalid" }));
    const toolTask = await create(c, "tools");
    await until(() => !c.grok.active.size);
    assert.throws(() => c.grok.read(toolTask.thread.id, earlier!), /游标/);
    const tool = c.grok.read(toolTask.thread.id).thread.turns[0].items.find((i: any) => i.type === "commandExecution");
    assert.equal(tool.command, "Fixture command"); assert.equal(tool.aggregatedOutput, "output"); assert.equal(tool.status, "completed");
  } finally { await c.server.stop(); c.store.close(); }
});

test("concurrent creation deduplicates and reserves capacity before initialization", async () => {
  const c = setup();
  try {
    const same = await Promise.all([create(c, "hang", "same"), create(c, "hang", "same")]);
    assert.equal(same[0].thread.id, same[1].thread.id);
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => create(c, "hang", `parallel-${i}`)));
    assert.equal(results.filter(x => x.status === "fulfilled").length, 3);
    assert.equal(c.grok.active.size, 4);
    assert.equal((await create(c, "hang", "same")).duplicate, true);
  } finally { await c.server.stop(); c.store.close(); }
});

test("startup recovery clears interrupted approvals without resending a tool or prompt", async () => {
  const c = setup();
  try {
    const task = c.grok.tasks.create("recovery-session", { cwd: c.root, text: "unfinished" });
    const turn = c.grok.tasks.beginTurn(task.id);
    const requestId = c.store.addPending(99, "grok/session/request_permission", { threadId: task.id, turnId: turn });
    c.grok.tasks.put(task.id, turn, { id: "approval", type: "pocketApproval", requestId, summary: "pending" });
    const fresh = new GrokAgent(c.store, [c.root], "fixture", c.factory);
    assert.equal(fresh.read(task.id).thread.turns[0].status, "interrupted");
    assert.equal(fresh.read(task.id).thread.turns[0].items[0].decision, "cancel");
    assert.equal(fresh.respond(requestId, "allowOnce").duplicate, true);
    assert.equal(fresh.active.size, 0);
    await fresh.stop();
  } finally { await c.server.stop(); c.store.close(); }
});

test("cancel during resume prevents the pending prompt from ever starting", async () => {
  const c = setup();
  try {
    const { thread } = await create(c, "hello");
    await until(() => !c.grok.active.size);
    const result = await c.rpc("turn/start", { threadId: thread.id, text: "must not execute" });
    await c.rpc("turn/interrupt", { threadId: thread.id, turnId: result.turn.id });
    await until(() => !c.grok.active.size);
    assert.equal(c.grok.read(thread.id).thread.turns.at(-1).status, "interrupted");
    assert.equal(readFileSync(join(c.root, "prompts.ndjson"), "utf8").trim().split("\n").length, 1);
  } finally { await c.server.stop(); c.store.close(); }
});
