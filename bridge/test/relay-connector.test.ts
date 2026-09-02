import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RelayConnector } from "../src/relay-connector.ts";
import { createHostIdentity, loadHostIdentity } from "../src/relay-crypto.ts";

test("Relay outbox reuses identical event and snapshot ciphertext after lost acknowledgements", {
  skip: process.platform !== "win32",
}, async () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-outbox-"));
  const identityPath = join(base, "host-identity.json");
  try {
    const identity = await createHostIdentity("https://relay.example.test", "PC");
    Object.assign(identity, {
      accountId: "account-id",
      hostId: "host-id",
      hostToken: "host-token",
      contentKey: "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA",
    });
    const bridge = {
      subscribeRelayEvents: () => () => undefined,
      dispatchRelay: async () => ({ data: [{ id: "thread-id", name: "Encrypted snapshot" }] }),
    } as any;
    const store = { eventsAfter: () => [], latestSeq: () => 0 } as any;
    const first = new RelayConnector(identity.relayUrl, identityPath, identity, bridge, store);
    (first as any).connected = true;
    const firstEventAttempts: any[] = [];
    (first as any).request = async (method: string, params: any) => {
      assert.equal(method, "event/append");
      firstEventAttempts.push(structuredClone(params.envelope));
      throw new Error("simulated lost event acknowledgement");
    };
    const event = {
      seq: 1,
      eventId: "event-id",
      type: "turn.status" as const,
      threadId: "thread-id",
      turnId: "turn-id",
      at: new Date().toISOString(),
      payload: { status: "completed" },
    };
    await assert.rejects((first as any).publishEvent(event), /lost event acknowledgement/);
    assert.equal(identity.eventCounter, -1);
    assert.equal(identity.lastBridgeSeq, 0);
    assert.ok(identity.pendingEvent);

    const afterEventRestart = loadHostIdentity(identityPath)!;
    const second = new RelayConnector(identity.relayUrl, identityPath, afterEventRestart, bridge, store);
    const secondEventAttempts: any[] = [];
    (second as any).request = async (method: string, params: any) => {
      assert.equal(method, "event/append");
      secondEventAttempts.push(structuredClone(params.envelope));
      return { stored: false, duplicate: true };
    };
    await (second as any).flushPendingEvent();
    assert.deepEqual(secondEventAttempts[0], firstEventAttempts[0]);
    assert.equal(afterEventRestart.eventCounter, 0);
    assert.equal(afterEventRestart.lastBridgeSeq, 1);
    assert.equal(afterEventRestart.pendingEvent, undefined);

    (second as any).connected = true;
    const firstSnapshotAttempts: any[] = [];
    (second as any).request = async (method: string, params: any) => {
      assert.equal(method, "snapshot/put");
      firstSnapshotAttempts.push(structuredClone(params.envelope));
      throw new Error("simulated lost snapshot acknowledgement");
    };
    await (second as any).sendSnapshot();
    assert.equal(afterEventRestart.snapshotCounter, -1);
    assert.ok(afterEventRestart.pendingSnapshot);
    assert.ok((second as any).snapshotTimer, "failed snapshots must schedule a retry");

    const afterSnapshotRestart = loadHostIdentity(identityPath)!;
    const third = new RelayConnector(identity.relayUrl, identityPath, afterSnapshotRestart, bridge, store);
    const secondSnapshotAttempts: any[] = [];
    (third as any).request = async (method: string, params: any) => {
      assert.equal(method, "snapshot/put");
      secondSnapshotAttempts.push(structuredClone(params.envelope));
      return { stored: false, duplicate: true };
    };
    await (third as any).flushPendingSnapshot();
    assert.deepEqual(secondSnapshotAttempts[0], firstSnapshotAttempts[0]);
    assert.equal(afterSnapshotRestart.snapshotCounter, 0);
    assert.equal(afterSnapshotRestart.pendingSnapshot, undefined);
    clearTimeout((second as any).snapshotTimer);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
