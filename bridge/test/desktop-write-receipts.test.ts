import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeServer } from "../src/server.ts";
import { BridgeStore } from "../src/store.ts";

test("lost Desktop create/send acknowledgements stay unknown and the original operation never repeats", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocket-desktop-receipt-")), store = new BridgeStore(join(root, "bridge.db"));
  const codex: any = Object.assign(new EventEmitter(), { activeTurns: new Map(), readOnly: true,
    async request(method: string) { if (method === "thread/turns/list") return { data: [], nextCursor: null }; return { thread: { id: "chat", cwd: root, turns: [] } }; } });
  let sends = 0, creates = 0;
  const desktop: any = { async readThreadNormalized(id: string) { return { thread: { id, cwd: root, turns: [] } }; },
    async waitThread() { return {}; },
    async sendMessage() { sends++; throw Object.assign(new Error("pipe closed after dispatch"), { delivery: "unknown" }); },
    async createThread() { creates++; throw Object.assign(new Error("create ack lost"), { delivery: "unknown" }); } };
  const server = new BridgeServer({ dbPath: join(root, "bridge.db"), projectRoots: [root], codexHome: root } as any, store, codex, {} as any, desktop);
  store.setThreadOwner("chat", "desktop"); server.startDesktopWatcher = () => {};
  try {
    for (const [method, params] of [["thread/start", { operationId: "create", cwd: root, text: "fixture", target: "desktop" }],
      ["turn/start", { operationId: "send", threadId: "chat", text: "fixture" }]] as const) {
      await assert.rejects(server.dispatchRelay("phone", method, params), (error: any) => error.nameCode === "OPERATION_UNKNOWN");
      assert.equal((await server.dispatchRelay("phone", "operation/get", { operationId: params.operationId })).status, "unknown");
      await assert.rejects(server.dispatchRelay("phone", method, params), (error: any) => error.nameCode === "OPERATION_UNKNOWN");
    }
    assert.equal(sends, 1); assert.equal(creates, 1);
  } finally { await server.stop(); store.close(); await rm(root, { recursive: true, force: true }); }
});
