import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeServer } from "../src/server.ts";
import { BridgeStore } from "../src/store.ts";
import { desktopQuestions, desktopQuestionReplies, desktopQuestionReplyText } from "../src/desktop-questions.ts";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ap-interaction-"));
  const store = new BridgeStore(join(base, "test.db"));
  const codex: any = new EventEmitter();
  Object.assign(codex, { activeTurns: new Map(), readOnly: false, calls: [], responses: [],
    assertWritable() {}, clearTurn() {}, respond(id: string, result: any) { this.responses.push({ id, result }); } });
  const history: any[] = [{ id: "turn", status: "inProgress", items: [] }];
  codex.request = async (method: string, params: any) => {
    codex.calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: params.threadId, cwd: base, status: { type: "active" }, turns: [] } };
    if (method === "thread/turns/list") return { data: history, nextCursor: null };
    throw new Error(`Unexpected native call: ${method}`);
  };
  const desktop: any = { sent: [], fail: false,
    async sendMessage(threadId: string, text: string) { if (this.fail) throw new Error("disconnected"); this.sent.push({ threadId, text }); },
    async waitThread() { return { changed: false, threadStatus: "idle", turnStatus: "completed", timedOut: false }; } };
  const server = new BridgeServer({ bindHost: "127.0.0.1", port: 0, dbPath: join(base, "test.db"), codexHome: base,
    codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "test" }, store, codex, { send: async () => {} } as any, desktop);
  const question = { id: "call-fixture", type: "agentMessage", delivery: "async", text: "", questions: [{ title: "选择一个方案？", options: ["A", "B"] }] };
  history[0].items.push(question);
  const params = (card: any, answer = "B") => ({ threadId: "thread", requestId: card.requestId, answers: { [card.questionId]: { answers: [answer] } } });
  return { base, server, store, codex, desktop, history, question, params, async close() { await server.stop(); store.close(); } };
}

test("Desktop asynchronous question survives byte-trimmed history and replies using the exact native wrapper once", async () => {
  const f = fixture();
  try {
    f.history[0].items.push(...Array.from({ length: 9 }, (_, i) => ({ id: `output-${i}`, type: "commandExecution", aggregatedOutput: "x".repeat(100000) })));
    const result = await f.server.readThread({ threadId: "thread" });
    const card = result.thread.interactionItems[0];
    assert.equal(result.page.hasMore, true);
    assert.ok(!result.thread.turns[0].items.some((i: any) => i.type === "pocketQuestion"));
    assert.equal(card.questionId, JSON.stringify(["request_user_input_async", "call-fixture", 0]));
    assert.deepEqual(card.options, ["A", "B"]);
    assert.equal(card.selectedOption, undefined);
    assert.equal(result.thread.capabilities.question, true);
    const live = await f.server.threadInteractions("thread");
    assert.equal(live.items.length, 1);
    assert.equal(live.items[0].requestId, card.requestId);
    assert.ok(JSON.stringify(live).length < 2000, "interaction polling must not transfer transcript output");
    await assert.rejects(f.server.dispatchRelay("device", "question/respond", { ...f.params(card), threadId: "another" }));
    await f.server.dispatchRelay("device", "question/respond", f.params(card));
    const duplicate = await f.server.dispatchRelay("device", "question/respond", f.params(card, "A"));
    assert.equal(duplicate.answer, "B");
    assert.equal(f.desktop.sent.length, 1);
    assert.equal((await f.server.threadInteractions("thread")).items[0].selectedOption, "B");
    assert.equal(f.desktop.sent[0].text, desktopQuestionReplyText({ questionId: card.questionId, question: "选择一个方案？" }, "B"));
    assert.ok(f.codex.calls.every((c: any) => ["thread/read", "thread/turns/list"].includes(c.method)));
    assert.equal(f.store.threadOwner("thread"), undefined);
  } finally { await f.close(); }
});

test("failed Desktop answer stays pending; an answer arriving from Desktop prevents duplicate phone submission", async () => {
  const f = fixture();
  try {
    const card = (await f.server.readThread({ threadId: "thread" })).thread.interactionItems[0];
    f.desktop.fail = true;
    await assert.rejects(f.server.dispatchRelay("device", "question/respond", f.params(card)));
    assert.equal(f.store.pending(card.requestId).resolved_at, null);
    f.desktop.fail = false;
    f.history[0].items.push({ id: "desktop-answer", type: "userMessage", content: [{ type: "text", text: desktopQuestionReplyText({ questionId: card.questionId, question: card.prompt }, "自己的回答") }] });
    const response = await f.server.dispatchRelay("device", "question/respond", f.params(card));
    assert.equal(response.answer, "自己的回答");
    assert.equal(f.desktop.sent.length, 0);
    const read = await f.server.readThread({ threadId: "thread" });
    assert.equal(read.thread.interactionItems[0].selectedOption, "自己的回答");
  } finally { await f.close(); }
});

test("Host approval and multi-question cards restore without replay, retain failed writes, and expire on connection loss", async () => {
  const f = fixture();
  try {
    f.store.setThreadOwner("thread", "bridge");
    await f.server.onCodexRequest({ id: 10, method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", command: "echo fixture" } });
    await f.server.onCodexRequest({ id: 11, method: "item/tool/requestUserInput", params: { threadId: "thread", turnId: "turn", questions: [{ id: "q1", question: "One", options: [] }, { id: "q2", question: "Two", options: [{ label: "A" }] }] } });
    const cards = (await f.server.readThread({ threadId: "thread" })).thread.interactionItems;
    assert.equal(cards.length, 3);
    assert.ok(cards.every((c: any) => c.available));
    const approval = cards[0];
    const respond = f.codex.respond;
    f.codex.respond = () => { throw new Error("write failed"); };
    await assert.rejects(f.server.respondApproval({ requestId: approval.requestId, decision: "allowOnce" }));
    assert.equal(f.store.pending(approval.requestId).resolved_at, null);
    f.codex.respond = respond;
    await f.server.respondApproval({ requestId: approval.requestId, decision: "deny" });
    assert.deepEqual(f.codex.responses[0].result, { decision: "decline" });
    await assert.rejects(f.server.respondQuestion({ requestId: cards[1].requestId, answers: { q1: { answers: ["first"] } } }));
    f.codex.emit("exit", new Error("offline"));
    const restored = (await f.server.readThread({ threadId: "thread" })).thread.interactionItems;
    assert.equal(restored[0].decision, "deny");
    assert.equal(restored[1].available, false);
    await assert.rejects(f.server.respondQuestion({ requestId: cards[1].requestId, answers: { q1: { answers: ["first"] }, q2: { answers: ["A"] } } }));
  } finally { await f.close(); }
});

test("plain messages and unaccepted steering cannot impersonate asynchronous question state", () => {
  assert.deepEqual(desktopQuestions("t", { id: "q", type: "agentMessage", text: "Choose?", questions: [{ title: "x" }] }), []);
  assert.deepEqual(desktopQuestionReplies({ type: "steeringUserMessage", status: "pending", content: [{ type: "text", text: desktopQuestionReplyText({ questionId: "q", question: "x" }, "A") }] }), []);
  assert.deepEqual(desktopQuestionReplies({ type: "userMessage", content: [{ type: "text", text: "<send_user_message_question_reply>not JSON</send_user_message_question_reply>" }] }), []);
});
