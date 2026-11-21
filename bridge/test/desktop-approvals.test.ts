import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeServer } from "../src/server.ts";
import { BridgeStore } from "../src/store.ts";
import { DESKTOP_APPROVAL_CAPABILITY } from "../src/desktop-attach.ts";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ap-desktop-approvals-")); const db = join(base, "test.db");
  const store = new BridgeStore(db);
  const codex: any = Object.assign(new EventEmitter(), { activeTurns: new Map(), readOnly: true,
    assertWritable() { assert.fail("Desktop approval must not use app-server"); }, respond() { assert.fail("wrong writer"); },
    async request(method: string, params: any) {
      if (method === "thread/read") return { thread: { id: params.threadId, cwd: base } };
      if (method === "thread/turns/list") return { data: [], nextCursor: null };
      assert.fail("unexpected app-server write");
    } });
  const request: any = { id: 1, method: "item/commandExecution/requestApproval", fingerprint: "a".repeat(64),
    available: true, allowedDecisions: ["allowOnce", "deny"], params: { threadId: "t", turnId: "turn", cwd: base, command: "echo test" } };
  const desktop: any = { supported: true, fail: "", sent: [], requests: [request], ownerClientId: "owner", cwd: base,
    supportsWritableCapability(capability: string) { return this.supported && capability === DESKTOP_APPROVAL_CAPABILITY; },
    async readThreadNormalized(id: string) { return { thread: { id, cwd: this.cwd, turns: [] } }; },
    async readApprovals(threadId: string, cwd: string) { if (this.fail === "read") throw new Error("offline");
      return { threadId, cwd, ownerClientId: this.ownerClientId, available: true, requests: this.requests }; },
    async respondApproval(params: any) {
      if (this.fail === "before") throw Object.assign(new Error("stale before socket write"), { delivery: "not_sent" });
      this.sent.push(params); if (this.fail === "after") throw Object.assign(new Error("lost ack"), { delivery: "unknown" });
      if (this.wait) await this.wait;
      return { ok: true, decision: params.decision };
    } };
  const server = new BridgeServer({ bindHost: "127.0.0.1", port: 0, dbPath: db, codexHome: base,
    codexCommand: "fake", minCodexVersion: "1", projectRoots: [base], hostName: "test" }, store, codex, { send: async () => {} } as any, desktop);
  server.startDesktopWatcher = () => {};
  return { base, db, store, server, desktop, request,
    async card() { return (await server.threadInteractions("t")).items[0]; },
    async call(card: any, operationId: string, decision = "allowOnce", extra = {}) {
      return server.dispatchRelay("web-device", "approval/respond", { requestId: card.requestId, threadId: "t", operationId, decision, ...extra });
    }, async close() { await server.stop(); store.close(); } };
}

test("Desktop native approvals restore and resolve through their actual owner despite read-only app-server", async () => {
  const f = fixture();
  try {
    const card = await f.card(); assert.equal(card.owner, "desktop"); assert.equal(card.available, true);
    assert.equal((await f.server.threadInteractions("t")).execution.capabilities.approval, true);
    await f.call(card, "op-1", "allowOnce", { target: "bridge", backend: "bridge", agentId: "grok" });
    assert.equal(f.desktop.sent.length, 1); assert.equal(f.store.threadOwner("t"), "desktop");
    assert.equal(f.store.getOperation("op-1")?.backend, "desktop"); assert.equal(f.store.getOperation("op-1")?.agent, "codex");
    assert.equal(f.desktop.sent[0].ownerClientId, "owner"); assert.equal(f.desktop.sent[0].requestId, 1);
    assert.equal(f.desktop.sent[0].fingerprint, f.request.fingerprint);
    assert.equal((await f.call(card, "op-2")).duplicate, true);
    await assert.rejects(f.call(card, "op-3", "deny"), (error: any) => error.nameCode === "CONFLICT");
    await assert.rejects(f.call(card, "op-1", "deny"), (error: any) => error.nameCode === "CONFLICT");
    assert.equal(f.desktop.sent.length, 1);
    assert.equal((await f.card()).decision, "allowOnce");
  } finally { await f.close(); }
});

test("Desktop approval validation rejects cross-thread, changed contents, expired, unavailable and Bridge-owned requests", async () => {
  const f = fixture();
  try {
    const card = await f.card();
    await assert.rejects(f.call(card, "cross-thread", "allowOnce", { threadId: "another" }));
    await assert.rejects(f.call(card, "permanent", "acceptForSession"));
    await assert.rejects(f.call(card, "cancel", "cancel"));
    f.request.fingerprint = "b".repeat(64);
    assert.equal((await f.card()).available, false);
    f.desktop.supported = false;
    await assert.rejects(f.call(card, "unsupported")); f.desktop.supported = true;
    f.store.setThreadOwner("t", "bridge");
    await assert.rejects(f.call(card, "wrong-writer")); f.store.setThreadOwner("t", "desktop");
    f.desktop.requests = []; await f.card();
    await assert.rejects(f.call(card, "gone"));
    assert.equal(f.desktop.sent.length, 0);
  } finally { await f.close(); }
});

test("Desktop pending identity blocks new operationIds after timeout and restart; absence never fabricates a decision", async () => {
  const f = fixture();
  try {
    const card = await f.card(); f.desktop.fail = "after";
    await assert.rejects(f.call(card, "lost-ack"), (error: any) => error.nameCode === "OPERATION_UNKNOWN");
    assert.equal(f.store.getOperation("lost-ack")?.status, "unknown");
    f.desktop.fail = "";
    await assert.rejects(f.call(card, "different-id"), (error: any) => error.nameCode === "OPERATION_UNKNOWN");
    assert.equal(f.desktop.sent.length, 1); assert.equal((await f.card()).available, false);
    const other = new BridgeStore(f.db);
    assert.equal(other.reserveDesktopApproval(card.requestId, "deny").reserved, false); other.close();
    f.desktop.ownerClientId = "transferred-owner"; f.request.fingerprint = "b".repeat(64);
    const transferred = await f.card();
    assert.equal(transferred.requestId, card.requestId); assert.equal(transferred.available, false);
    f.desktop.requests = []; const ended = await f.card();
    assert.equal(ended.available, false); assert.equal(ended.decision, undefined);
    assert.equal(f.store.getOperation("lost-ack")?.status, "unknown");
    f.desktop.requests = [f.request];
    assert.equal((await f.card()).requestId, card.requestId, "unknown cannot be recycled even after observed absence");
    await assert.rejects(f.call(card, "after-transfer"), (error: any) => error.nameCode === "OPERATION_UNKNOWN");
    assert.equal(f.desktop.sent.length, 1);
  } finally { await f.close(); }
});

test("only a proven pre-send error releases the native reservation; simultaneous responders cannot both write", async () => {
  const f = fixture();
  try {
    const card = await f.card(); f.desktop.fail = "before";
    await assert.rejects(f.call(card, "not-sent")); assert.equal(f.store.pending(card.requestId).response, undefined);
    assert.equal(f.store.getOperation("not-sent")?.status, "failed");
    f.desktop.fail = ""; let unblock!: () => void; f.desktop.wait = new Promise<void>((resolve) => unblock = resolve);
    const first = f.call(card, "first");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(f.call(card, "second"));
    unblock(); await first; assert.equal(f.desktop.sent.length, 1);
  } finally { await f.close(); }
});

test("native reservation survives crash points and event pruning, without pruning ordinary legacy behavior", () => {
  const base = mkdtempSync(join(tmpdir(), "ap-approval-crash-")); const db = join(base, "test.db"); let clock = 1000;
  let store = new BridgeStore(db, () => clock);
  const id = store.addPending(9, "item/commandExecution/requestApproval", { source: "desktop", threadId: "t", nativeApproval: { requestId: 9 } }, "native");
  const legacy = store.addPending(10, "item/commandExecution/requestApproval", { threadId: "t" });
  assert.equal(store.reserveDesktopApproval(id, "allowOnce").reserved, true); store.close();
  clock += 25 * 60 * 60 * 1000; store = new BridgeStore(db, () => clock);
  try {
    store.addPending(11, "item/commandExecution/requestApproval", { threadId: "other" });
    assert.throws(() => store.pending(legacy));
    assert.equal(store.pending(id).response.desktopApprovalState, "submitting");
    assert.equal(store.reserveDesktopApproval(id, "deny").reserved, false);
    store.markDesktopApprovalAbsent(id);
    assert.equal(store.pending(id).response.desktopApprovalState, "submitting", "late read cannot overwrite the reservation");
    assert.equal(store.interactionsForThread("t").length, 1);
    store.settleDesktopApproval(id, "succeeded", "allowOnce");
    store.addPending(9, "item/commandExecution/requestApproval", { source: "desktop", threadId: "t", nativeApproval: {} }, "native");
    assert.equal(store.reserveDesktopApproval(id, "deny").reserved, false);
  } finally { store.close(); }
});

test("owner transfer cannot turn a live or uncertain native approval into a new actionable card", async () => {
  const f = fixture();
  try {
    const original = await f.card();
    f.desktop.ownerClientId = "second-owner"; f.request.fingerprint = "b".repeat(64);
    const moved = await f.card();
    assert.equal(moved.requestId, original.requestId); assert.equal(moved.available, false);
    assert.equal(f.store.activeDesktopApproval("t", 1).params.nativeApproval.ownerClientId, "owner");
    // No submission existed: an explicit absence ends that active identity.
    f.desktop.requests = []; await f.card();
    f.desktop.requests = [f.request];
    const fresh = (await f.server.threadInteractions("t")).items.find((item: any) => item.available);
    assert.ok(fresh); assert.notEqual(fresh.requestId, original.requestId);
    assert.equal(f.desktop.sent.length, 0);
  } finally { await f.close(); }
});
