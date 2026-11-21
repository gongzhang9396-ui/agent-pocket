import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../web/src/markdown.tsx";
import { QuestionCard, groupQuestions, questionActionable, questionOptions } from "../web/src/question-card.tsx";
import { threadCapabilities, threadState, projectName, agentName } from "../web/src/workspace-data.ts";
import { pendingKey, readPending, removePending, savePending } from "../web/src/pending-writes.ts";

test("capabilities follow the actual execution target, preserving only known legacy Codex fallbacks", () => {
  const desktop = { source: "desktop", capabilities: { send: true, approval: true }, execution: { backend: "desktop", owner: null, capabilities: { send: false, approval: false } } };
  assert.equal(threadCapabilities(desktop).send, false);
  assert.equal(threadCapabilities(desktop).approval, false);
  assert.equal(threadCapabilities(desktop).attachments, true);
  assert.equal(threadCapabilities({ source: "bridge", capabilities: { attachments: false } }).attachments, false);
  assert.equal(threadCapabilities({ source: "grok", capabilities: { send: true } }).attachments, false);
  assert.equal(threadCapabilities({ source: "grok", capabilities: { send: true } }).steer, false);
  assert.equal(threadCapabilities({ capabilities: { send: true } }).attachments, false);
  assert.equal(agentName({ agentId: "grok", source: "desktop" }), "Grok");
  assert.equal(threadState({ status: { type: "notLoaded" } }).label, "未载入");
  assert.equal(threadState({ status: { type: "active", activeFlags: ["waitingOnApproval"] } }).label, "需要确认");
  assert.equal(projectName({ cwd: "G:\\项目\\工作台\\" }), "工作台");
});

test("question groups retain every Bridge question and normalize Desktop/Bridge choices", () => {
  const items = [{ type: "pocketQuestion", id: "r:a", requestId: "r", questionId: "a", available: true, options: ["first", { label: "second", description: "detail" }] },
    { type: "pocketQuestion", id: "r:b", requestId: "r", questionId: "b", available: true },
    { type: "futureInteraction", id: "other", requestId: "r" }];
  assert.deepEqual(groupQuestions(items).map((group) => group.map((item) => item.questionId)), [["a", "b"]]);
  assert.deepEqual(questionOptions(items[0]), [{ label: "first" }, { label: "second", description: "detail" }]);
  assert.equal(questionActionable(items[0], true, true), true);
  for (const patch of [{ selectedOption: "answered" }, { selectedOption: "" }, { available: false }, { type: "futureInteraction" }, { submissionState: "unknown" }, { unavailableReason: "desktop" }]) {
    assert.equal(questionActionable({ ...items[0], ...patch }, true, true), false);
  }
  assert.equal(questionActionable(items[0], false, true), false);
  assert.equal(questionActionable(items[0], true, false), false);
  const html = renderToStaticMarkup(React.createElement(QuestionCard, { items: [{ ...items[0], selectedOption: "first" }], fresh: true, capable: true, busy: false, onAnswer() {} }));
  assert.match(html, /已回答/); assert.doesNotMatch(html, /<button/);
});

test("Markdown renders GFM without active HTML, remote image loads, or unsafe URLs", () => {
  const text = '**加粗**\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)\n\n![image](https://tracker.invalid/a.svg)\n\n[normal](https://example.com)\n\n```html\n<img onerror=alert(1)>\n```\n\n| Column | Value |\n|---|---|\n| x | y |';
  const html = renderToStaticMarkup(React.createElement(Markdown, { text }));
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /class="table-scroll"/); assert.match(html, /class="code-block"/);
  assert.match(html, /rel="noopener noreferrer"/); assert.match(html, /&lt;img onerror/);
  assert.doesNotMatch(html, /<script|<iframe|<img|href="javascript:|src="https:\/\/tracker/);
});

test("pending receipts survive remount but never save prompts, answers or credentials", () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"); const store = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) || null, setItem: (k: string, v: string) => store.set(k, v) } });
  try {
    const key = pendingKey("account", "device");
    savePending(key, { operationId: "one", hostId: "host", threadId: "thread", answers: "private", text: "private", token: "secret" } as any);
    assert.equal(readPending(key)[0].operationId, "one");
    assert.doesNotMatch(store.get(key)!, /private|secret|answers|token/);
    assert.deepEqual(readPending(pendingKey("another", "device")), []);
    savePending(key, { operationId: "one", hostId: "host", threadId: "thread" }); assert.equal(readPending(key).length, 1);
    removePending(key, "one"); assert.deepEqual(readPending(key), []);
  } finally { if (prior) Object.defineProperty(globalThis, "sessionStorage", prior); else delete (globalThis as any).sessionStorage; }
});
