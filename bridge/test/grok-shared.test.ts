import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeStore } from "../src/store.ts";
import { GrokAgent } from "../src/grok.ts";
import { GrokNativeCatalog } from "../src/grok-native-catalog.ts";
import { AgentTaskStore } from "../src/agent-store.ts";
import type { AcpClient } from "../src/acp-client.ts";

const items = (page: any) => page.thread.turns.flatMap((turn: any) => turn.items);
const text = (item: any) => item.text ?? item.content?.map((part: any) => part.text).join("") ?? "";
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("condition timed out"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function setup(messages: any[] = [{ type: "user", content: "desktop question" }, { type: "assistant", content: "desktop answer" }]) {
  const root = mkdtempSync(join(tmpdir(), "ap-grok-shared-test-"));
  const project = join(root, "project"), sessions = join(root, "sessions"), nativeId = "desktop-existing";
  const directory = join(sessions, encodeURIComponent(project), nativeId);
  mkdirSync(project); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "summary.json"), JSON.stringify({ info: { id: nativeId, cwd: project }, generated_title: "Desktop title", current_model_id: "grok-fixture" }));
  const history = join(directory, "chat_history.jsonl");
  writeFileSync(history, messages.map(row => JSON.stringify(row) + "\n").join(""));
  const db = join(root, "bridge.db"), store = new BridgeStore(db);
  const catalog = new GrokNativeCatalog([project], sessions);
  const clients: SharedClient[] = [], calls: any[] = [];
  let version = "1.0.13";
  class SharedClient extends EventEmitter {
    closed = false; environment?: NodeJS.ProcessEnv; prompt: any; resolvePrompt?: (value: any) => void;
    start() {}
    async request(method: string, params: any) {
      calls.push({ method, params });
      if (method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: { agentVersion: version } };
      if (method === "session/load") {
        this.emit("notification", { method: "session/update", params: { sessionId: nativeId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAY" } } } });
        return {};
      }
      if (method === "session/prompt") {
        this.prompt = params;
        appendFileSync(history, JSON.stringify({ type: "user", content: params.prompt[0].text }) + "\n");
        return new Promise(resolve => { this.resolvePrompt = resolve; this.queue(params._meta.promptId); });
      }
      return {};
    }
    queue(running?: string, entries: any[] = []) {
      this.emit("notification", { method: "_x.ai/queue/changed", params: { sessionId: nativeId, runningPromptId: running, entries } });
    }
    chunk(value: string, promptId = this.prompt._meta.promptId) {
      this.emit("notification", { method: "session/update", params: { sessionId: nativeId, _meta: { promptId }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } } });
    }
    finish(value = "mobile answer", reason = "end_turn") {
      if (!this.resolvePrompt) return;
      if (value) appendFileSync(history, JSON.stringify({ type: "assistant", content: value }) + "\n");
      const resolve = this.resolvePrompt; this.resolvePrompt = undefined;
      resolve({ stopReason: reason, _meta: { promptId: this.prompt._meta.promptId } });
    }
    notify(method: string, params: any) { calls.push({ method, params, notification: true }); }
    respond(id: any, result: any) { calls.push({ reply: id, result }); }
    reject(id: any) { calls.push({ rejected: id }); }
    async stop() { this.closed = true; this.finish("", "cancelled"); }
  }
  const factory = (args: string[]) => {
    calls.push({ args }); const client = new SharedClient(); clients.push(client); return client as unknown as AcpClient;
  };
  const grok = new GrokAgent(store, [project], "fixture", factory, catalog);
  return { root, project, sessions, directory, history, id: `grok:${nativeId}`, nativeId, store, catalog, grok, clients, calls, db, factory, setVersion: (value: string) => { version = value; } };
}

test("desktop continuation keeps one native ID and canonical history, including later terminal edits and restart", async () => {
  const c = setup();
  try {
    const before = await c.grok.read(c.id);
    assert.equal(before.thread.execution.capabilities.send, true);
    assert.equal(c.clients.length, 0);
    const [one, duplicate] = await Promise.all([c.grok.start(c.id, "mobile question", "phone-one"), c.grok.start(c.id, "mobile question", "phone-one")]);
    assert.equal(one.turn.id, duplicate.turn.id); assert.equal(duplicate.duplicate, true);
    await until(() => Boolean(c.clients[0]?.prompt)); const client = c.clients[0];
    assert.ok(c.calls.find(call => call.args)?.args.includes("--leader"));
    assert.ok(!c.calls.find(call => call.args)?.args.includes("--no-leader"));
    assert.equal(client.environment?.GROK_DISABLE_AUTOUPDATER, "1");
    assert.equal(client.prompt.sessionId, c.nativeId);
    client.chunk("FOREIGN SHOULD NOT APPEAR", "terminal-other");
    client.chunk("mobile answer"); c.grok.flush(c.grok.active.get(c.id)!);
    const live = await c.grok.read(c.id);
    assert.deepEqual(items(live).map(text), ["desktop question", "desktop answer", "mobile question", "mobile answer"]);
    assert.notEqual(live.page.revision, before.page.revision);
    client.finish(); await until(() => !c.grok.active.size);
    const saved = await c.grok.read(c.id);
    assert.deepEqual(items(saved).map(text), ["desktop question", "desktop answer", "mobile question", "mobile answer"]);
    assert.ok(items(saved).every((item: any) => item.id.startsWith("grok-native-")));
    assert.notEqual(saved.page.revision, live.page.revision);
    appendFileSync(c.history, JSON.stringify({ type: "assistant", content: "later terminal message" }) + "\n");
    await c.catalog.refresh(true);
    assert.equal(text(items(await c.grok.read(c.id)).at(-1)), "later terminal message");
    await c.grok.stop(); c.store.close();
    const store = new BridgeStore(c.db), catalog = new GrokNativeCatalog([c.project], c.sessions);
    const restarted = new GrokAgent(store, [c.project], "fixture", c.factory, catalog);
    try {
      assert.equal((await restarted.start(c.id, "do not resend", "phone-one")).duplicate, true);
      assert.deepEqual(items(await restarted.read(c.id)).map(text), ["desktop question", "desktop answer", "mobile question", "mobile answer", "later terminal message"]);
      assert.equal(c.calls.filter(call => call.method === "session/prompt").length, 1);
    } finally { await restarted.stop(); store.close(); }
  } finally { await c.grok.stop(); try { c.store.close(); } catch {} }
});

test("active shared history paginates both old native content and live output without duplicates", async () => {
  const old = "历史中文🙂".repeat(90_000), current = "续聊回复🙂".repeat(90_000);
  const c = setup([{ type: "user", content: old }, { type: "assistant", content: "old end" }]);
  try {
    await c.grok.start(c.id, "continue", "page-request"); await until(() => Boolean(c.clients[0]?.prompt));
    c.clients[0].chunk(current); c.grok.flush(c.grok.active.get(c.id)!);
    let cursor: string | undefined, pages = 0; const collected: any[] = [];
    do {
      const page = await c.grok.read(c.id, cursor);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 540 * 1024);
      collected.unshift(...items(page)); cursor = page.page.nextCursor;
      assert.ok(++pages < 30);
    } while (cursor);
    assert.ok(pages > 2);
    assert.equal(new Set(collected.map(item => item.id)).size, collected.length);
    assert.equal(collected.filter(item => item.type === "userMessage").map(text).join(""), old + "continue");
    assert.equal(collected.filter(item => item.type === "agentMessage").map(text).join(""), "old end" + current);
    const oldLiveCursor = (await c.grok.read(c.id)).page.nextCursor;
    c.clients[0].finish(current); await until(() => !c.grok.active.size);
    await assert.rejects(c.grok.read(c.id, oldLiveCursor), /刷新/);
  } finally { await c.grok.stop(); c.store.close(); }
});

test("shared cancellation and permission responses are scoped to the owned prompt", async () => {
  const c = setup();
  try {
    const started = await c.grok.start(c.id, "queued", "queue-request"); await until(() => Boolean(c.clients[0]?.prompt));
    const client = c.clients[0], turnId = started.turn.id;
    client.queue("terminal-running", [{ id: turnId, version: 3, owner: "agent-pocket" }]);
    client.emit("request", { id: 99, method: "session/request_permission", params: { sessionId: c.nativeId, toolCall: { toolCallId: "foreign-tool" } } });
    assert.equal(c.grok.permissions.size, 0); assert.equal(c.calls.filter(call => call.rejected).length, 0);
    assert.match((await c.grok.read(c.id)).thread.execution.statusMessage, /排队/);
    c.grok.interrupt(c.id, turnId);
    const remove = c.calls.find(call => call.method === "_x.ai/queue/remove");
    const cancel = c.calls.find(call => call.method === "session/cancel");
    assert.deepEqual(remove.params, { sessionId: c.nativeId, id: turnId, expectedVersion: 3, owner: "agent-pocket" });
    assert.equal(cancel.params._meta.promptId, turnId); assert.equal(cancel.params._meta.rewindIfNoOutput, true);
    assert.equal(cancel.params._meta.cancelSubagents, false);
    client.finish("", "cancelled"); await until(() => !c.grok.active.size);
    assert.throws(() => c.grok.interrupt(c.id, "terminal-running"), /不属于/);
  } finally { await c.grok.stop(); c.store.close(); }
});

test("old Grok cannot silently fall back to an independent writer and failed continuation remains visible", async () => {
  const c = setup(); c.setVersion("1.0.12");
  try {
    await c.grok.start(c.id, "never send", "old-version"); await until(() => !c.grok.active.size);
    assert.equal(c.calls.filter(call => call.method === "session/prompt").length, 0);
    assert.ok(items(await c.grok.read(c.id)).some((item: any) => text(item).includes("1.0.13")));
  } finally { await c.grok.stop(); c.store.close(); }
});

test("native history metadata preserves old tasks and old Host inserts after rollback", () => {
  const root = mkdtempSync(join(tmpdir(), "ap-agent-migration-")); const store = new BridgeStore(join(root, "bridge.db"));
  try {
    store.db.exec(`CREATE TABLE agent_tasks(id TEXT PRIMARY KEY,native_id TEXT NOT NULL UNIQUE,creation_key TEXT UNIQUE,cwd TEXT NOT NULL,model TEXT,effort TEXT,title TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
    store.db.prepare("INSERT INTO agent_tasks VALUES(?,?,?,?,?,?,?,?,?)").run("grok:old", "old", "creation", root, null, null, "Old task", 1, 2);
    const first = new AgentTaskStore(store.db), second = new AgentTaskStore(store.db);
    assert.equal(first.get("grok:old")?.historySource, "managed");
    assert.equal(second.get("grok:old")?.title, "Old task");
    assert.equal(second.created("creation")?.id, "grok:old");
    assert.equal(second.list().length, 1);
    store.db.prepare("INSERT INTO agent_tasks VALUES(?,?,?,?,?,?,?,?,?)").run("grok:rollback", "rollback", null, root, null, null, "After rollback", 3, 4);
    assert.equal(second.get("grok:rollback")?.historySource, "managed");
    const adopted = second.adopt({ id: "grok:old", nativeId: "old", cwd: root, model: "updated-model", title: "Desktop title", createdAt: 1, updatedAt: 5 });
    assert.equal(adopted.historySource, "native"); assert.equal(adopted.title, "Desktop title"); assert.equal(adopted.model, "updated-model");
    assert.equal(second.created("creation")?.id, "grok:old");
    assert.throws(() => second.adopt({ ...adopted, id: "different-id" }), /标识.*冲突/);
    assert.equal(second.list().length, 2);
  } finally { store.close(); }
});

test("an early cancel retries the exact queue version when its first notification arrives", async () => {
  const c = setup();
  try {
    const started = await c.grok.start(c.id, "cancel early", "early-cancel"); await until(() => Boolean(c.clients[0]?.prompt));
    const run = c.grok.active.get(c.id)!, client = c.clients[0];
    run.currentPromptId = undefined; run.queueVersion = undefined;
    c.grok.interrupt(c.id, started.turn.id);
    client.queue("terminal-running", [{ id: started.turn.id, version: 3, owner: "agent-pocket" }]);
    const removes = c.calls.filter(call => call.method === "_x.ai/queue/remove");
    assert.deepEqual(removes.map(call => call.params.expectedVersion), [0, 3]);
    assert.ok(removes.every(call => call.params.id === started.turn.id && call.params.owner === "agent-pocket"));
    client.finish("", "cancelled"); await until(() => !c.grok.active.size);
  } finally { await c.grok.stop(); c.store.close(); }
});

test("shared permissions accept only the mobile turn and only a one-time grant", async () => {
  const c = setup();
  try {
    const started = await c.grok.start(c.id, "use a tool", "own-permission"); await until(() => Boolean(c.clients[0]?.prompt));
    const client = c.clients[0]; client.queue(started.turn.id);
    client.emit("request", { id: 42, method: "session/request_permission", params: { sessionId: c.nativeId,
      toolCall: { toolCallId: "own-tool", title: "Read fixture" }, options: [{ kind: "allow_once", optionId: "once" }, { kind: "allow_always", optionId: "forever" }] } });
    const requestId = [...c.grok.permissions.keys()][0]; assert.ok(requestId);
    c.grok.respond(requestId, "allowOnce");
    assert.deepEqual(c.calls.find(call => call.reply === 42)?.result, { outcome: { outcome: "selected", optionId: "once" } });
    assert.equal(c.grok.permissions.size, 0);
    client.finish(); await until(() => !c.grok.active.size);
  } finally { await c.grok.stop(); c.store.close(); }
});

test("restart recovery notice stays visible alongside canonical native history", async () => {
  const c = setup();
  try {
    c.grok.tasks.adopt(await c.catalog.metadata(c.id));
    const turnId = c.grok.tasks.beginTurn(c.id, "lost-host-connection");
    c.grok.tasks.recover();
    assert.ok(items(await c.grok.read(c.id)).some((item: any) => item.id === `grok-notice-${turnId}` && text(item).includes("不会自动重发")));
    assert.equal((await c.grok.start(c.id, "do not resend", "lost-host-connection")).duplicate, true);
    assert.equal(c.clients.length, 0);
  } finally { await c.grok.stop(); c.store.close(); }
});

test("metadata survives a temporarily missing native history without sending a prompt", async () => {
  const c = setup();
  try {
    unlinkSync(c.history);
    assert.ok((await c.grok.list()).some(row => row.id === c.id));
    await assert.rejects(c.grok.start(c.id, "not ready", "pending-history"), /暂未就绪/);
    assert.equal(c.clients.length, 0); assert.equal(c.grok.active.size, 0);
    writeFileSync(c.history, JSON.stringify({ type: "user", content: "history ready" }) + "\n");
    await c.catalog.refresh(true);
    assert.equal(text(items(await c.grok.read(c.id))[0]), "history ready");
  } finally { await c.grok.stop(); c.store.close(); }
});
