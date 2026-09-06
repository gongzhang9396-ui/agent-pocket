import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GrokNativeCatalog } from "../src/grok-native-catalog.ts";
import { GrokAgent } from "../src/grok.ts";
import { BridgeStore } from "../src/store.ts";
import { BridgeServer } from "../src/server.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ap-native-grok-"));
  const project = join(root, "项目"), sessions = join(root, "sessions");
  mkdirSync(project); mkdirSync(sessions);
  const catalog = new GrokNativeCatalog([project], sessions);
  function session(id = "native-a", messages: any[] = [], cwd = project, title = id) {
    const dir = join(sessions, encodeURIComponent(cwd), id); mkdirSync(dir, { recursive: true });
    const summary = { info: { id, cwd }, generated_title: title, current_model_id: "fixture-grok", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:01Z" };
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
    writeFileSync(join(dir, "chat_history.jsonl"), messages.map(row => JSON.stringify(row) + "\n").join(""));
    writeFileSync(join(dir, "chat_history.jsonl.lock"), "");
    return { id: `grok:${id}`, dir, summary, history: join(dir, "chat_history.jsonl") };
  }
  return { root, project, sessions, catalog, session };
}
const items = (result: any) => result.thread.turns.flatMap((turn: any) => turn.items);
const text = (item: any) => item.text ?? item.content?.map((x: any) => x.text).join("") ?? "";

test("native metadata is whitelisted, read-only, namespaced, and leaves native history and locks untouched", async () => {
  const c = setup();
  try {
    const good = c.session("native-a", [{ type: "user", content: [{ type: "text", text: "你好" }] }, { type: "assistant", content: "Hello" }]);
    c.session("denied", [], c.root);
    const bad = c.session("bad"); writeFileSync(join(bad.dir, "summary.json"), "{");
    const before = readFileSync(good.history);
    const list = await c.catalog.list();
    assert.deepEqual(list.map(x => x.id), [good.id]);
    assert.equal(list[0].execution.owner, "external");
    assert.equal(list[0].execution.backend, "grok");
    assert.ok(Object.values(list[0].execution.capabilities).every(value => value === false));
    assert.match(list[0].execution.readOnlyReason, /原终端/);
    assert.deepEqual(items(await c.catalog.read(good.id)).map(text), ["你好", "Hello"]);
    assert.deepEqual(readFileSync(good.history), before);
    assert.equal(readFileSync(join(good.dir, "chat_history.jsonl.lock")).length, 0);
    await assert.rejects(c.catalog.read("grok:denied"), /白名单/);
    await assert.rejects(c.catalog.read("grok:../../secret"), /找不到/);
  } finally { await c.catalog.stop(); }
});

test("native display excludes system/private reasoning and renders tool messages and attachment placeholders", async () => {
  const c = setup();
  try {
    const row = c.session("shape", [
      { type: "system", content: "PRIVATE_SYSTEM" },
      { type: "user", content: "PRIVATE_REMINDER", synthetic_reason: "system_reminder" },
      { type: "user", content: [{ type: "text", text: "<user_info>\nOS Version: windows\nPRIVATE_ENVIRONMENT\n</user_info>\n<rules>PRIVATE_RULES</rules>" }] },
      { type: "user", prompt_index: 0, content: [{ type: "text", text: "<user_query>\nactual question\n</user_query>" }] },
      { type: "user", prompt_index: 1, content: [{ type: "text", text: "<user_query>\n<user_info>\nOS Version: literal example\n</user_info>\n</user_query>" }] },
      { type: "user", content: [{ type: "text", text: "check" }, { type: "image", url: "data:image/png;base64,DO_NOT_SEND" }] },
      { type: "reasoning", encrypted_content: "PRIVATE_REASONING", summary: [{ text: "HIDDEN_SUMMARY" }] },
      { type: "assistant", content: "Reply", tool_calls: [{ id: "call1", name: "shell", arguments: "echo example" }] },
      { type: "tool_result", tool_call_id: "call1", content: "example" },
      { type: "backend_tool_call", kind: { tool_type: "web_search", action: { type: "search", query: "example" }, status: "completed" } },
    ]);
    const result = await c.catalog.read(row.id); const json = JSON.stringify(result);
    for (const secret of ["PRIVATE_SYSTEM", "PRIVATE_REMINDER", "PRIVATE_ENVIRONMENT", "PRIVATE_RULES", "DO_NOT_SEND", "PRIVATE_REASONING", "HIDDEN_SUMMARY"]) assert.ok(!json.includes(secret));
    assert.equal(text(items(result)[0]), "actual question");
    assert.equal(text(items(result)[1]), "<user_info>\nOS Version: literal example\n</user_info>");
    assert.ok(!json.includes("<user_query>"));
    assert.ok(json.includes("图片附件") && json.includes("echo example") && json.includes("工具结果") && json.includes("web_search"));
    assert.equal(result.page.hasMore, false);
  } finally { await c.catalog.stop(); }
});

test("large Chinese native messages paginate by bytes and chunks without gaps or duplicates, even after append", async () => {
  const c = setup();
  try {
    const body = "原生中文🦊\n".repeat(100_000);
    const row = c.session("long", [{ type: "user", content: [{ type: "text", text: body }] }, { type: "assistant", content: "end" }]);
    let page = await c.catalog.read(row.id); const revision = page.page.revision;
    const collected = items(page); let pages = 1;
    appendFileSync(row.history, JSON.stringify({ type: "assistant", content: "new appended message" }) + "\n");
    while (page.page.nextCursor) {
      page = await c.catalog.read(row.id, page.page.nextCursor);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 540 * 1024);
      collected.unshift(...items(page));
      assert.ok(++pages < 30);
    }
    assert.ok(pages > 1);
    assert.equal(new Set(collected.map(x => x.id)).size, collected.length);
    assert.equal(collected.filter(x => x.type === "userMessage").map(text).join(""), body);
    assert.deepEqual(collected.filter(x => x.type === "agentMessage").map(text), ["end"]);
    const fresh = await c.catalog.read(row.id);
    assert.equal(fresh.page.revision, revision);
    assert.equal(text(items(fresh).at(-1)), "new appended message");
  } finally { await c.catalog.stop(); }
});

test("partial last records retry on refresh; rewind invalidates history cursors and revision", async () => {
  const c = setup();
  try {
    const row = c.session("rewrite", Array.from({ length: 105 }, (_, i) => ({ type: "assistant", content: `message-${i}` })));
    appendFileSync(row.history, '{"type":"assistant","content":"partial');
    const first = await c.catalog.read(row.id);
    assert.equal(first.page.pending, true);
    assert.equal(items(first).length, 100);
    appendFileSync(row.history, ' completed"}\n');
    const second = await c.catalog.read(row.id);
    assert.equal(second.page.pending, false);
    assert.equal(text(items(second).at(-1)), "partial completed");
    assert.equal(second.page.revision, first.page.revision);
    writeFileSync(row.history, JSON.stringify({ type: "assistant", content: "rewound" }) + "\n");
    await assert.rejects(c.catalog.read(row.id, first.page.nextCursor!), /游标|回退|改写/);
    const fresh = await c.catalog.read(row.id);
    assert.notEqual(fresh.page.revision, first.page.revision);
    assert.deepEqual(items(fresh).map(text), ["rewound"]);
  } finally { await c.catalog.stop(); }
});

test("native history cursor is bound to its session and rejects malformed input", async () => {
  const c = setup();
  try {
    const a = c.session("a", Array.from({ length: 101 }, () => ({ type: "assistant", content: "one" })));
    const b = c.session("b", [{ type: "assistant", content: "two" }]);
    const page = await c.catalog.read(a.id);
    await assert.rejects(c.catalog.read(b.id, page.page.nextCursor!), /游标/);
    await assert.rejects(c.catalog.read(a.id, "ap-grok-v1:abc"), /游标/);
  } finally { await c.catalog.stop(); }
});

test("editing an earlier record plus appending cannot masquerade as append-only history", async () => {
  const c = setup();
  try {
    const messages = Array.from({ length: 110 }, (_, i) => ({ type: "assistant", content: `original message ${i}` }));
    const row = c.session("front-edit", messages);
    const [first, concurrent] = await Promise.all([c.catalog.read(row.id), c.catalog.read(row.id)]);
    assert.equal(first.page.revision, concurrent.page.revision);
    const saved = readFileSync(row.history, "utf8");
    writeFileSync(row.history, saved.replace("original message 0", "modified message 0") + JSON.stringify({ type: "assistant", content: "appended" }) + "\n");
    await assert.rejects(c.catalog.read(row.id, first.page.nextCursor!), /改写|回退/);
    const fresh = await c.catalog.read(row.id);
    assert.notEqual(fresh.page.revision, first.page.revision);
  } finally { await c.catalog.stop(); }
});

test("native session directory links cannot expose another path", async () => {
  const c = setup();
  try {
    const denied = c.session("linked", [{ type: "assistant", content: "outside" }], c.root);
    const allowedGroup = join(c.sessions, encodeURIComponent(c.project)); mkdirSync(allowedGroup, { recursive: true });
    symlinkSync(denied.dir, join(allowedGroup, "linked"), process.platform === "win32" ? "junction" : "dir");
    assert.deepEqual(await c.catalog.list(), []);
  } finally { await c.catalog.stop(); }
});

test("native changes produce one catalog event with stable unchanged scans", async () => {
  const c = setup();
  try {
    const events: string[][] = []; c.catalog.on("changed", value => events.push(value));
    const row = c.session(); await c.catalog.list();
    await c.catalog.refresh(true); assert.equal(events.length, 0);
    appendFileSync(row.history, JSON.stringify({ type: "assistant", content: "appended" }) + "\n");
    await c.catalog.refresh(true); assert.deepEqual(events, [[row.id]]);
    await c.catalog.refresh(true); assert.equal(events.length, 1);
  } finally { await c.catalog.stop(); }
});

test("Grok native list pages stay stable and IDs deduplicate; reads and rejected foreign writes never start an executor", async () => {
  const c = setup(); const store = new BridgeStore(join(c.root, "bridge.db"));
  let starts = 0;
  const grok = new GrokAgent(store, [c.project], "unused", () => { starts++; throw new Error("Must not start CLI"); }, c.catalog);
  const codex = Object.assign(new EventEmitter(), { readOnly: true, activeTurns: new Map(), request: async () => { throw new Error("Codex offline"); } });
  const server = new BridgeServer({ projectRoots: [c.project], dbPath: join(c.root, "bridge.db") } as any, store, codex as any, {} as any, undefined, grok);
  const rpc = (method: string, params: any = {}) => server.dispatchRelay("test-device", method, params);
  try {
    const original = c.session("a", [{ type: "assistant", content: "native history" }]);
    c.session("b"); c.session("c");
    const first = await rpc("thread/list", { agentId: "grok", limit: 1 });
    const initial = (await grok.list()).map(x => x.id);
    c.session("new"); await c.catalog.refresh(true);
    const second = await rpc("thread/list", { agentId: "grok", limit: 1, cursor: first.nextCursor });
    assert.deepEqual(await rpc("thread/list", { agentId: "grok", limit: 1, cursor: first.nextCursor }), second);
    const third = await rpc("thread/list", { agentId: "grok", limit: 1, cursor: second.nextCursor });
    assert.deepEqual([first.data[0].id, second.data[0].id, third.data[0].id], initial);
    assert.equal(third.nextCursor, null);
    await assert.rejects(rpc("thread/list", { agentId: "grok", cursor: first.nextCursor, search: "different" }), /搜索/);
    assert.equal((await rpc("thread/read", { threadId: original.id })).thread.execution.owner, "shared");
    for (const method of ["turn/interrupt", "turn/steer", "thread/handoff"]) {
      await assert.rejects(rpc(method, { threadId: original.id, turnId: "native", text: "do not execute" }));
    }
    await assert.rejects(rpc("turn/start", { threadId: "grok:unknown", text: "do not execute" }));
    assert.equal(starts, 0);
    grok.tasks.create("a", { cwd: c.project, text: "managed title" });
    const all = await grok.list();
    assert.equal(all.filter(x => x.id === original.id).length, 1);
    assert.equal(all.find(x => x.id === original.id)!.execution.owner, "shared");
    assert.ok(server.capabilities().includes("grok-native-v1"));
    assert.ok(server.capabilities().includes("grok-shared-v1"));
  } finally { await server.stop(); store.close(); }
});
