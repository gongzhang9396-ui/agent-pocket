import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServer, mapCodexBusy } from "../src/codex.ts";
import { ErrorName, RpcError } from "../src/protocol.ts";

function fakeServer(thread: any) {
  const codex = new CodexAppServer({
    command: "fake",
    codexHome: ".",
    minVersion: "1",
  });
  let params: any;
  codex.request = (async (_method: string, value: any) => {
    params = value;
    return { thread };
  }) as any;
  return { codex, params: () => params };
}

test("external in-progress turn stays read-only", async () => {
  const { codex, params } = fakeServer({
    id: "thread-external",
    status: { type: "active", activeFlags: [] },
    turns: [{ id: "turn-external", status: "inProgress" }],
  });

  await assert.rejects(
    codex.assertThreadControllable("thread-external"),
    (error: any) => error instanceof RpcError && error.nameCode === ErrorName.THREAD_BUSY_EXTERNAL,
  );
  assert.equal(params().includeTurns, true);
});

test("stale active status without an in-progress turn may be resumed", async () => {
  const thread = {
    id: "thread-idle",
    status: { type: "active", activeFlags: [] },
    turns: [{ id: "turn-old", status: "completed" }],
  };
  const { codex } = fakeServer(thread);

  assert.deepEqual(await codex.assertThreadControllable("thread-idle"), { thread });
});

test("a bridge-owned in-progress turn remains controllable", async () => {
  const thread = {
    id: "thread-owned",
    status: { type: "active", activeFlags: [] },
    turns: [{ id: "turn-owned", status: "inProgress" }],
  };
  const { codex } = fakeServer(thread);
  codex.markTurn("thread-owned", "turn-owned");

  assert.deepEqual(await codex.assertThreadControllable("thread-owned"), { thread });
});

test("writer-lock arbitration still maps to external busy", () => {
  const mapped = mapCodexBusy(new Error("writer lock is held by another app-server"));
  assert.ok(mapped instanceof RpcError);
  assert.equal(mapped.nameCode, ErrorName.THREAD_BUSY_EXTERNAL);
});
