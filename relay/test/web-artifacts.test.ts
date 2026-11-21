import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readArtifact, ArtifactCard } from "../web/src/artifacts.tsx";
import { prepareAttachments, attachmentParams } from "../web/src/attachments.tsx";
import { ready } from "../web/src/crypto.ts";
const artifact = { id: "a", messageId: "t:m", source: "report.txt", name: "report.txt", mimeType: "text/plain", size: 3 };
test("artifact reader rejects wrong scope, malformed chunks and cancellation", async () => {
  const valid = { id: "a", offset: 0, size: 3, nextOffset: 3, done: true, data: "YWJj" };
  const data = await readArtifact(async () => valid, artifact, new AbortController().signal, () => {}); assert.equal(await data.text(), "abc");
  for (const patch of [{ id: "b" }, { offset: 1 }, { size: 9 }, { nextOffset: 4 }, { done: false }, { data: "?" }]) await assert.rejects(readArtifact(async () => ({ ...valid, ...patch }), artifact, new AbortController().signal, () => {}));
  const abort = new AbortController(); abort.abort(); await assert.rejects(readArtifact(async () => valid, artifact, abort.signal, () => {}));
});
test("new-task and continuation attachments share budget and exact Host payload", async () => {
  await ready();
  const items = await prepareAttachments([new File(["abc"], "note.txt", { type: "text/plain" })], []);
  assert.deepEqual(attachmentParams(items), { images: [], files: [{ filename: "note.txt", mimeType: "text/plain", data: "YWJj" }] });
  await assert.rejects(prepareAttachments([new File([""], "empty.txt")], []), /空文件/);
  await assert.rejects(prepareAttachments([new File([new Uint8Array(513 * 1024)], "large.txt")], []), /512/);
  await assert.rejects(prepareAttachments([new File(["a"], "one.txt")], [...items, ...items, ...items]), /3/);
});
test("artifact filenames and unavailable descriptions are escaped and offline reads stay disabled", () => {
  const html = renderToStaticMarkup(React.createElement(ArtifactCard, { artifact: { ...artifact, name: '<img src=x onerror="bad">' }, connected: false }));
  assert.doesNotMatch(html, /<img src=x/); assert.match(html, /disabled/); assert.match(html, /&lt;img/);
});
