import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_COMMAND_BYTES, newEvent, sanitizedFcmData, truncateUtf8 } from "../src/protocol.ts";
import { BridgeStore } from "../src/store.ts";

function storeAt(now = 1_000_000) {
  const dir = mkdtempSync(join(tmpdir(), "agent-pocket-store-"));
  let clock = now;
  return { store: new BridgeStore(join(dir, "test.db"), () => clock), setNow: (value: number) => { clock = value; } };
}

test("pairing is one-time, expires, hashes tokens, and revokes devices", () => {
  const { store, setNow } = storeAt();
  const pairing = store.createPairing();
  const claimed = store.claimPairing({ pairingId: pairing.id, secret: pairing.secret, deviceName: "Pixel" });
  assert.equal(store.authenticate(claimed.token)?.id, claimed.deviceId);
  assert.throws(() => store.claimPairing({ pairingId: pairing.id, secret: pairing.secret }));
  assert.ok(!JSON.stringify(store.listDevices()).includes(claimed.token));
  assert.equal(store.revokeDevice(claimed.deviceId), true);
  assert.equal(store.authenticate(claimed.token), undefined);

  const expired = store.createPairing(100);
  setNow(expired.expiresAt + 1);
  assert.throws(() => store.claimPairing({ pairingId: expired.id, secret: expired.secret }));
  store.close();
});

test("events replay in order and report a pruned gap", () => {
  const { store, setNow } = storeAt();
  const first = store.appendEvent(newEvent("message.delta", { threadId: "t", delta: "a" }));
  const second = store.appendEvent(newEvent("message.delta", { threadId: "t", delta: "b" }));
  assert.deepEqual(store.eventsAfter(first.seq!).map((event) => event.seq), [second.seq]);
  setNow(1_000_000 + 24 * 60 * 60 * 1000 + 1);
  store.appendEvent(newEvent("turn.status", { threadId: "t", status: "done" }));
  assert.throws(() => store.eventsAfter(first.seq!), (error: any) => error?.nameCode === "EVENT_GAP");
  store.close();
});

test("pending responses are idempotent", () => {
  const { store } = storeAt();
  const id = store.addPending(9, "item/commandExecution/requestApproval", { command: "x" });
  assert.equal(store.resolvePending(id, { decision: "accept" }).duplicate, false);
  assert.equal(store.resolvePending(id, { decision: "decline" }).duplicate, true);
  store.close();
});

test("thread owner claims are exclusive and persist across Bridge restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-pocket-owner-"));
  const path = join(dir, "test.db");
  const first = new BridgeStore(path);
  first.setThreadOwner("thread-1", "bridge");
  assert.equal(first.claimThreadOwner("thread-1", "desktop"), "bridge");
  assert.equal(first.threadOwner("thread-1"), "bridge");
  first.close();

  const reopened = new BridgeStore(path);
  assert.equal(reopened.threadOwner("thread-1"), "bridge");
  reopened.close();
});

test("output truncation preserves UTF-8 and FCM is metadata-only", () => {
  const truncated = truncateUtf8("你".repeat(MAX_COMMAND_BYTES), MAX_COMMAND_BYTES);
  assert.equal(truncated.truncated, true);
  assert.ok(Buffer.byteLength(truncated.value) <= MAX_COMMAND_BYTES);
  assert.deepEqual(sanitizedFcmData({ hostId: "h", sessionId: "s", eventId: "e", type: "done", prompt: "secret", output: "secret" }), {
    hostId: "h", sessionId: "s", eventId: "e", type: "done",
  });
});
