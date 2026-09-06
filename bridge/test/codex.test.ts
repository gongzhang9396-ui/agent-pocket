import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServer, mapCodexBusy } from "../src/codex.ts";
import { ErrorName, RpcError } from "../src/protocol.ts";

test("executor initializes without querying unrelated model/history directories", async () => {
  const program = `const lines = require('node:readline').createInterface({input:process.stdin});
    lines.on('line', line => { const message=JSON.parse(line); if(message.id == null)return;
      process.stdout.write(JSON.stringify({id:message.id, ...(message.method==='initialize' ? {result:{}} : {error:{code:-32601,message:'Catalog unavailable'}})})+'\\n'); });`;
  const codex = new CodexAppServer({ command: process.execPath, args: ["-e", program], codexHome: ".", minVersion: "1" });
  try {
    assert.equal((await codex.start()).readOnly, false);
    await assert.rejects(codex.request("model/list", {}), /Catalog unavailable/);
    assert.equal(codex.readOnly, false);
    await codex.closeGracefully();
    assert.equal(codex.readOnly, true);
  } finally { codex.stop(); }
});

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

test("active status with no turns may be resumed", async () => {
  const thread = {
    id: "thread-empty-active",
    status: { type: "active", activeFlags: [] },
    turns: [],
  };
  const { codex } = fakeServer(thread);

  assert.deepEqual(await codex.assertThreadControllable("thread-empty-active"), { thread });
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

test("ordinary Desktop Attach failures are not rewritten as busy", () => {
  const error = new Error("Could not attach to Codex Desktop: pipe closed");
  assert.equal(mapCodexBusy(error), error);
});
