import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard } from "../web/src/approval-card.tsx";

const item = { id: "native", requestId: "native", owner: "desktop", available: true,
  allowedDecisions: ["allowOnce", "deny"], command: "echo <script>alert(1)</script>", cwd: "C:\\project" };
function render(patch = {}, props = {}) { return renderToStaticMarkup(React.createElement(ApprovalCard, {
  item: { ...item, ...patch }, capability: true, connected: true, busy: false, onDecision() {}, ...props,
})); }

test("web native approval renders exact choices and escaped command/file details", () => {
  const html = render({ changes: [{ path: "<img src=x onerror=alert(1)>", diff: "+hello" }] });
  assert.match(html, /允许本次/); assert.match(html, /拒绝/); assert.doesNotMatch(html, />取消<|永久|<script>|<img /);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /文件改动/);
  assert.match(render({ allowedDecisions: ["cancel"] }), />取消</);
  assert.doesNotMatch(render({ allowedDecisions: ["deny"] }), /允许本次/);
});

test("web native approval never exposes actions while stale, disconnected, unknown, resolved or unsupported", () => {
  for (const patch of [{ available: false }, { unavailableReason: "请回 Desktop" }, { submissionState: "unknown" },
    { submissionState: "submitting" }, { decision: "deny" }, { allowedDecisions: undefined }]) {
    assert.doesNotMatch(render(patch), /<button/);
  }
  assert.doesNotMatch(render({}, { capability: false }), /<button/);
  assert.doesNotMatch(render({}, { connected: false }), /<button/);
  assert.match(render({}, { busy: true }), /disabled/);
});
