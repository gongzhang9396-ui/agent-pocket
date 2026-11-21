import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeServer } from "../src/server.ts";
import { BridgeStore } from "../src/store.ts";
import { desktopQuestionReplyText } from "../src/desktop-questions.ts";
import { EVENT_MAX_AGE_MS } from "../src/protocol.ts";

function fixture(approval = false) {
  const base = mkdtempSync(join(tmpdir(), "ap-question-integration-"));
  const dir = join(base, "sessions"); mkdirSync(dir);
  const record = (type: string, payload: any) => JSON.stringify({ type, payload }) + "\n";
  writeFileSync(join(dir, "rollout-thread.jsonl"), record("session_meta", { id: "thread", session_id: "thread" }) +
    record("response_item", { type: "function_call", name: "request_user_input_async", call_id: "call_1",
      arguments: JSON.stringify({ questions: [{ title: "选择？", options: ["甲", "乙"] }] }),
      internal_chat_message_metadata_passthrough: { turn_id: "old" } }) +
    record("response_item", { type: "function_call_output", call_id: "call_1", output: '{"accepted":true}',
      internal_chat_message_metadata_passthrough: { turn_id: "old" } }));
  const store = new BridgeStore(join(base, "test.db"));
  const turns: any[] = [{ id: "old", status: "completed", items: [{ id: "call_1", type: "agentMessage", text: "选择？" }] },
    { id: "new", status: "completed", items: [] }];
  const codex: any = new EventEmitter();
  Object.assign(codex, { activeTurns: new Map(), readOnly: false, assertWritable() {}, clearTurn() {},
    async request(method: string) {
      if (method === "thread/read") return { thread: { id: "thread", cwd: base, status: { type: "active" } } };
      if (method === "thread/turns/list") return { data: [...turns].reverse(), nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    } });
  const desktop: any = { limits: [], sent: [], supportsWritableCapability: () => approval,
    async readThreadNormalized(_id: string, limit: number) { this.limits.push(limit); return { thread: { id: "thread", cwd: base,
      status: { type: "active" }, turns: turns.slice(-limit) } }; },
    async readApprovals() { return { available: true, threadId: "thread", cwd: base, ownerClientId: "owner", requests: [] }; },
    async sendMessage(threadId: string, text: string) { this.sent.push({ threadId, text }); },
    async waitThread() { return { changed: false, threadStatus: "idle", turnStatus: "completed", timedOut: false }; } };
  const server = new BridgeServer({ bindHost: "127.0.0.1", port: 0, dbPath: join(base, "test.db"), codexHome: base,
    codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "test" }, store, codex,
    { send: async () => {} } as any, desktop);
  return { server, store, turns, desktop, async close() { await server.stop(); store.close(); } };
}

test("native catalog enriches raw Desktop history, sends exact wrapper, and never revives an answer", async () => {
  const f = fixture();
  try {
    const result = await f.server.readThread({ threadId: "thread" });
    const card = result.thread.interactionItems[0];
    assert.deepEqual(card.options, ["甲", "乙"]);
    assert.equal(result.thread.turns.find((t: any) => t.id === "old").items[0].type, "pocketQuestion");
    const params = { threadId: "thread", requestId: card.requestId, answers: { [card.questionId]: { answers: ["乙"] } } };
    await assert.rejects(f.server.respondQuestion({ ...params, threadId: "other" }));
    assert.equal(f.desktop.sent.length, 0);
    await f.server.respondQuestion(params);
    const duplicate = await f.server.respondQuestion({ ...params, answers: { [card.questionId]: { answers: ["甲"] } } });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.answer, "乙");
    assert.equal(f.desktop.sent.length, 1);
    assert.equal(f.desktop.sent[0].text, desktopQuestionReplyText({ questionId: card.questionId, question: "选择？" }, "乙"));
    assert.equal((await f.server.threadInteractions("thread")).items[0].selectedOption, "乙");
    assert.equal(f.store.threadOwner("thread"), undefined);
  } finally { await f.close(); }
});

test("direct Desktop read without overlay recovers a raw history item", async () => {
  const f = fixture(true);
  try {
    const detail = await f.server.readDesktopThread("thread", 10, undefined, false);
    assert.deepEqual(detail.thread.interactionItems[0].options, ["甲", "乙"]);
    assert.equal(detail.thread.turns[0].items[0].type, "pocketQuestion");
  } finally { await f.close(); }
});

test("approval-capable polling independently finds and resolves a question in an older turn", async () => {
  const f = fixture(true);
  try {
    const card = (await f.server.threadInteractions("thread")).items[0];
    assert.deepEqual(card.options, ["甲", "乙"]);
    assert.equal(f.desktop.limits.at(-1), 1);
    f.turns[1].items.push({ id: "reply", type: "userMessage", content: [{ type: "text",
      text: desktopQuestionReplyText({ questionId: card.questionId, question: "选择？" }, "甲") }] });
    assert.equal((await f.server.threadInteractions("thread")).items[0].selectedOption, "甲");
    assert.equal((await f.server.threadInteractions("thread")).items[0].selectedOption, "甲");
  } finally { await f.close(); }
});

test("answered rollout questions survive retention cleanup without flooding snapshots or being sent twice", async () => {
  const f = fixture();
  try {
    let now = 1_000_000;
    f.store.now = () => now;
    const initial = await f.server.readThread({ threadId: "thread" });
    const card = initial.thread.interactionItems[0];
    const params = { threadId: "thread", requestId: card.requestId, answers: { [card.questionId]: { answers: ["乙"] } } };
    await f.server.respondQuestion(params);
    now += EVENT_MAX_AGE_MS + 1;
    f.store.addPending("other", "item/tool/requestUserInput", { threadId: "other" });
    const reread = await f.server.readThread({ threadId: "thread" });
    const restored = reread.thread.turns.find((t: any) => t.id === "old").items[0];
    assert.equal(restored.selectedOption, "乙");
    assert.equal(reread.thread.interactionItems.find((item: any) => item.requestId === card.requestId).selectedOption, "乙");
    assert.deepEqual((await f.server.threadInteractions("thread")).items, []);
    const duplicate = await f.server.respondQuestion(params);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.answer, "乙");
    assert.equal(f.desktop.sent.length, 1);
  } finally { await f.close(); }
});
