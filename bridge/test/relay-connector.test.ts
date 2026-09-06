import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RelayConnector } from "../src/relay-connector.ts";
import { createHostIdentity, loadHostIdentity } from "../src/relay-crypto.ts";

test("the wire budget rejects an oversized frame without sending or retaining a pending request", async () => {
  const identity = { hostId: "host", accountId: "account", hostToken: "token", contentKey: "key" } as any;
  const connector = new RelayConnector("http://127.0.0.1", "unused", identity, {} as any, {} as any);
  let sends = 0;
  (connector as any).socket = { readyState: 1, send: (frame: string) => {
    sends++;
    const id = JSON.parse(frame).id;
    queueMicrotask(() => void (connector as any).onMessage(JSON.stringify({ id, result: { ok: true } })));
  } };
  await assert.rejects((connector as any).request("channel/data", { ciphertext: "x".repeat(2 * 1024 * 1024) }),
    (error: any) => error.nameCode === "RESPONSE_TOO_LARGE");
  assert.equal(sends, 0);
  assert.equal((connector as any).pending.size, 0);
  assert.deepEqual(await (connector as any).request("relay/hello", {}), { ok: true });
  assert.equal(sends, 1);
});

test("oversized RPC results become a small error before advancing channel encryption", async () => {
  const identity = { hostId: "host", accountId: "account", hostToken: "token", contentKey: "key" } as any;
  const bridge = { dispatchRelay: async (_peer: string, method: string) => method === "large" ? "中".repeat(900_000) : { ok: true } } as any;
  const connector = new RelayConnector("http://127.0.0.1", "unused", identity, bridge, {} as any);
  let method = "large";
  const encrypted: any[] = [];
  const sent: any[] = [];
  (connector as any).channels.set("channel", {
    peer: { id: "device" },
    decrypt: () => JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    encrypt: (value: string) => { encrypted.push(JSON.parse(value)); return { ciphertext: value }; },
  });
  (connector as any).request = async (_method: string, params: any) => sent.push(params);
  await (connector as any).handleChannelData({ envelope: { channelId: "channel" } });
  assert.equal(encrypted.length, 1, "an oversized response must never consume a secretstream counter");
  assert.equal(encrypted[0].error?.data.name, "RESPONSE_TOO_LARGE");
  assert.ok(Buffer.byteLength(JSON.stringify(sent[0])) < 4096);
  method = "small";
  await (connector as any).handleChannelData({ envelope: { channelId: "channel" } });
  assert.deepEqual(encrypted[1].result, { ok: true });
});

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
