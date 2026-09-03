import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RelayStore } from "../src/store.js";
import { account, device, host, tempStore } from "./helpers.js";

test("database initialization records an explicit schema version", () => {
  const context = tempStore();
  try {
    assert.equal(context.store.meta("schemaVersion"), "2");
  } finally {
    context.close();
  }
});

test("schema v1 upgrades in place and creates v2 tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-pocket-relay-v1-"));
  const path = join(directory, "relay.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('schemaVersion','1')");
  old.close();
  const store = new RelayStore(path);
  try {
    assert.equal(store.meta("schemaVersion"), "2");
    const names = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((row) => row.name);
    assert.ok(names.includes("account_provisions"));
    assert.ok(names.includes("auth_rate_limits"));
    assert.ok(names.includes("update_releases"));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a provision activates exactly one approved first device", () => {
  const context = tempStore();
  try {
    const admin = account(context.store, "provision-admin", "admin");
    const provision = context.store.createAccountProvision({
      username: "friend",
      displayName: "Friend",
      passwordHash: "hash",
      createdBy: admin.id,
    });
    const claimed = context.store.activateAccountProvision(provision.id, {
      username: "friend",
      displayName: "ignored",
      passwordHash: "ignored",
      role: "user",
      signingPublicKey: "account-sign",
      encryptionPublicKey: "account-box",
      escrowCiphertext: "escrow",
    }, {
      name: "First phone",
      signingPublicKey: "device-sign",
      encryptionPublicKey: "device-box",
      keyPackage: "sealed-account-package",
    });
    assert.equal(claimed.account.id, provision.id);
    assert.equal(claimed.device.status, "approved");
    assert.equal(context.store.accountProvisionByUsername("friend"), undefined);
    assert.throws(() => context.store.activateAccountProvision(provision.id, {
      username: "friend",
      displayName: "Friend",
      passwordHash: "hash",
      role: "user",
      signingPublicKey: "second-sign",
      encryptionPublicKey: "second-box",
      escrowCiphertext: "second-escrow",
    }, {
      name: "Second phone",
      signingPublicKey: "second-device-sign",
      encryptionPublicKey: "second-device-box",
    }), /用户名或密码错误/);
  } finally {
    context.close();
  }
});

test("snapshot, event, push and enrollment operations enforce account ownership", () => {
  const context = tempStore();
  try {
    const first = account(context.store, "first");
    const second = account(context.store, "second");
    const firstDevice = device(context.store, first.id, "first");
    const secondDevice = device(context.store, second.id, "second");
    const firstHost = host(context.store, first.id, firstDevice.id, "first").host;
    const envelope = {
      accountId: second.id,
      hostId: firstHost.id,
      deviceId: firstHost.id,
      channelId: "snapshot",
      counter: 0,
      kind: "snapshot.put" as const,
      ciphertext: "ciphertext",
    };
    assert.throws(() => context.store.putSnapshot(envelope), /主机不存在/);
    assert.throws(() => context.store.registerPush(first.id, secondDevice.id, "install", "fcm"), /设备不存在/);

    const enrollment = context.store.startHostEnrollment("new", "sign", "box");
    assert.throws(
      () => context.store.approveHostEnrollment(first.id, secondDevice.id, enrollment.id, enrollment.secret, "new", "key-package"),
      /只有已批准设备/,
    );
  } finally {
    context.close();
  }
});

test("event cursors are contiguous and independent per host", () => {
  const context = tempStore();
  try {
    const owner = account(context.store, "owner");
    const phone = device(context.store, owner.id, "owner");
    const firstHost = host(context.store, owner.id, phone.id, "one").host;
    const secondHost = host(context.store, owner.id, phone.id, "two").host;
    const append = (hostId: string, eventId: string, counter: number) => context.store.appendEvent({
      accountId: owner.id,
      hostId,
      deviceId: hostId,
      channelId: "events",
      counter,
      kind: "event.append",
      eventId,
      eventType: "status",
      ciphertext: `cipher-${eventId}`,
    });
    assert.equal(append(firstHost.id, "a", 0)?.seq, 1);
    assert.equal(append(secondHost.id, "b", 0)?.seq, 1);
    assert.equal(append(firstHost.id, "c", 1)?.seq, 2);
    assert.deepEqual(context.store.eventsAfter(owner.id, firstHost.id, 1).map((event) => event.seq), [2]);
    assert.deepEqual(context.store.eventsAfter(owner.id, secondHost.id, 0).map((event) => event.seq), [1]);
  } finally {
    context.close();
  }
});

test("persistent counters reject replay and gaps", () => {
  const context = tempStore();
  try {
    const owner = account(context.store, "counter");
    context.store.advanceCounter(owner.id, "host", "host", "events", 0);
    assert.throws(() => context.store.advanceCounter(owner.id, "host", "host", "events", 0), /重复或乱序/);
    assert.throws(() => context.store.advanceCounter(owner.id, "host", "host", "events", 2), /重复或乱序/);
    context.store.advanceCounter(owner.id, "host", "host", "events", 1);
  } finally {
    context.close();
  }
});

test("offline recovery only approves the selected pending device and is audited", () => {
  const context = tempStore();
  try {
    const owner = account(context.store, "recovery");
    const admin = account(context.store, "recovery-admin", "admin");
    const pending = context.store.createDevice({
      accountId: owner.id,
      name: "Replacement phone",
      signingPublicKey: "pending-sign",
      encryptionPublicKey: "pending-box",
      approved: false,
    });
    const bundle = context.store.recoveryBundle(owner.id, pending.id);
    assert.equal(bundle.deviceEncryptionPublicKey, "pending-box");
    assert.throws(() => context.store.recoveryBundle(admin.id, pending.id), /待恢复设备不存在/);
    context.store.recoverDevice(owner.id, pending.id, "sealed-account-package", admin.id);
    assert.equal(context.store.deviceById(owner.id, pending.id)?.status, "approved");
    assert.throws(() => context.store.recoverDevice(owner.id, pending.id, "again", admin.id), /待恢复设备不存在/);
    assert.ok(context.store.auditRows(20).some((row) => row.action === "device.recover" && row.target_id === pending.id));
  } finally {
    context.close();
  }
});
