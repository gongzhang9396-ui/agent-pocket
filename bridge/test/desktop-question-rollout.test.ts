import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enrichDesktopQuestions, readDesktopAsyncQuestions } from "../src/desktop-question-rollout.ts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ap-rollout-"));
  const dir = join(home, "sessions", "2026", "10", "27");
  mkdirSync(dir, { recursive: true });
  return { home, path: join(dir, "rollout-thread.jsonl") };
}
const row = (type: string, payload: any) => JSON.stringify({ type, payload }) + "\n";
const meta = (payload: any = { id: "thread", session_id: "thread" }) => row("session_meta", payload);
const call = (id = "call_a", turn = "turn", questions: any = [{ title: "选择？", options: ["A", "B"] }]) =>
  row("response_item", { type: "function_call", name: "request_user_input_async", call_id: id,
    arguments: JSON.stringify({ questions }), internal_chat_message_metadata_passthrough: { turn_id: turn } });
const output = (id = "call_a", turn = "turn", accepted: any = true) =>
  row("response_item", { type: "function_call_output", call_id: id, output: JSON.stringify({ accepted }),
    internal_chat_message_metadata_passthrough: { turn_id: turn } });

test("recovers only the accepted matching call and permits free text without options", () => {
  const f = fixture();
  writeFileSync(f.path, meta({ id: "thread" }) + call("call_a", "turn", [{ title: "自由回答" }]) + output());
  const turns = enrichDesktopQuestions(f.home, "thread", [{ id: "turn", items: [
    { id: "call_a", type: "agentMessage", text: "plain native text" }, { id: "ordinary", type: "agentMessage", text: "请选择？" },
  ] }]);
  assert.deepEqual(turns[0].items[0].questions, [{ title: "自由回答" }]);
  assert.equal(turns[0].items[1].delivery, undefined);
  assert.equal(enrichDesktopQuestions(f.home, "thread", [{ id: "other", items: [{ id: "call_a", type: "agentMessage" }] }])[0].items[0].delivery, undefined);
});

test("rejects missing acceptance, wrong session, wrong turn, and malformed questions", () => {
  for (const body of [
    meta() + call(), meta() + call() + output("call_a", "other"),
    meta({ id: "other", session_id: "thread" }) + call() + output(),
    meta({ id: "thread", session_id: "other" }) + call() + output(),
    meta({ session_id: "thread" }) + call() + output(),
    meta() + call("call_a", "turn", [{ options: ["A"] }]) + output(),
    meta() + call() + output("call_a", "turn", false),
  ]) {
    const f = fixture(); writeFileSync(f.path, body);
    assert.equal(readDesktopAsyncQuestions(f.home, "thread").size, 0);
  }
});

test("partial lines and changed files invalidate cached results", () => {
  const f = fixture();
  writeFileSync(f.path, meta() + call() + output().trimEnd());
  assert.equal(readDesktopAsyncQuestions(f.home, "thread").size, 0);
  appendFileSync(f.path, "\n");
  assert.equal(readDesktopAsyncQuestions(f.home, "thread").size, 1);
  writeFileSync(f.path, meta());
  assert.equal(readDesktopAsyncQuestions(f.home, "thread").size, 0);
});

test("reads header separately when the file exceeds the bounded tail", () => {
  const f = fixture();
  writeFileSync(f.path, meta() + " ".repeat(32 * 1024 * 1024) + "\n" + call() + output());
  assert.equal(readDesktopAsyncQuestions(f.home, "thread").size, 1);
});
