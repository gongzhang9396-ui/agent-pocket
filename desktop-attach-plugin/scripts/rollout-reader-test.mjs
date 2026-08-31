import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  extractAssistantTextFromRollout,
  findRolloutFile,
  readAssistantTextFromRollout,
} from "../rollout-reader.mjs";

test("extracts the final assistant message for the requested turn", () => {
  const turnId = "01a058c1-3704-7961-b26d-c3728acf7660";
  const text = [
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "other", last_agent_message: "wrong" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "item_completed", turn_id: turnId, item: { type: "AgentMessage", content: [{ type: "Text", text: "诊断成功" }] } } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: "诊断成功" } }),
  ].join("\n");
  assert.equal(extractAssistantTextFromRollout(text, turnId), "诊断成功");
});

test("finds a rollout and reads only the matching turn", () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-rollout-"));
  try {
    const threadId = "01a04f2c-e25e-7993-9b17-e115b96706f6";
    const turnId = "01a058ba-8567-75f2-a7e2-adbb01aca34d";
    const folder = join(base, "sessions", "2026", "08", "30");
    mkdirSync(folder, { recursive: true });
    const rollout = join(folder, `rollout-2026-08-30T04-18-56-${threadId}.jsonl`);
    writeFileSync(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: "快乐" } })}\n`);
    assert.equal(findRolloutFile(threadId, base), rollout);
    assert.equal(readAssistantTextFromRollout({ threadId, turnId, codexHome: base }), "快乐");
    assert.equal(readAssistantTextFromRollout({ threadId, turnId: "different", codexHome: base }), undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("rejects path-like ids and honors the output cap", () => {
  assert.equal(findRolloutFile("../../secret", tmpdir()), undefined);
  const turnId = "turn-safe";
  const text = JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: "abcdef" } });
  assert.equal(extractAssistantTextFromRollout(text, turnId, 3), "abc");
});
