import assert from "node:assert/strict";
import test from "node:test";
import { rows, activeTurn, conversationMessages } from "../web/src/workspace-data.ts";
import { attachmentPayload, ready } from "../web/src/crypto.ts";

test("workspace consumes paged Host lists, newest-first history and active turns", () => {
  assert.deepEqual(rows({ data: [{ id: "t" }], nextCursor: null }), [{ id: "t" }]);
  const detail = { page: { order: "newest_first" }, thread: { turns: [
    { id: "new", status: "inProgress", items: [{ type: "agentMessage", text: "reply" }] },
    { id: "old", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "request" }] }] },
  ] } };
  assert.equal(activeTurn(detail)?.id, "new");
  assert.deepEqual(conversationMessages(detail).map(item => item.text), ["request", "reply"]);
});
test("attachments use the Host's standard padded base64 codec", async () => {
  await ready();
  const file = new File([new Uint8Array([251, 255])], "sample.txt", { type: "text/plain" });
  const result = await attachmentPayload(file);
  assert.equal(result.data, "+/8=");
});
