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
    assert.equal(context.store.meta("schemaVersion"), "3");
  } finally {
    context.close();
  }
});
test("opt-in private-key login recovery reuses one device and never recreates revoked/browser keys", () => {
  const context = tempStore();
  try {
    const owner = account(context.store, "device-recovery");
    const first = context.store.findDeviceForLogin(owner.id, undefined, "sign-a", "box-a", "Phone", true);
    const second = context.store.findDeviceForLogin(owner.id, undefined, "sign-a", "box-a", "Phone renamed", true);
    assert.equal(second.id, first.id); assert.equal(second.name, "Phone renamed"); assert.equal(context.store.listDevices(owner.id).length, 1);
    assert.throws(() => context.store.findDeviceForLogin(owner.id, undefined, "sign-a", "other-box", "Phone", true));
    context.store.revokeDevice(owner.id, first.id, "test-actor");
    assert.throws(() => context.store.findDeviceForLogin(owner.id, undefined, "sign-a", "box-a", "Phone", true));
    const web = context.store.findWebDeviceForLogin(owner.id, undefined, "web-sign", "web-box", "Browser");
    assert.throws(() => context.store.findDeviceForLogin(owner.id, undefined, "web-sign", "web-box", "Phone", true));
    assert.equal(context.store.deviceById(owner.id, web.id)?.status, "pending");
    // Older clients retain their original registration semantics.
    const legacy = context.store.findDeviceForLogin(owner.id, undefined, "legacy-sign", "legacy-box", "Legacy");
    assert.ok(legacy.id);
  } finally { context.close(); }
});
test("opt-in event replay pages respect count and byte budgets without skipping ciphertext", () => {
  const context = tempStore();
  try {
    const owner = account(context.store, "paged-events"), phone = device(context.store, owner.id, "paged-events"), pc = host(context.store, owner.id, phone.id, "paged-events");
    for (let index = 1; index <= 8; index++) context.store.appendEvent({ accountId: owner.id, hostId: pc.host.id, deviceId: pc.host.id,
      channelId: "events", counter: index, kind: "event.append", eventId: `event-${index}`, eventType: "status", ciphertext: "A".repeat(256 * 1024) });
    assert.equal(context.store.eventsAfter(owner.id, pc.host.id, 0).length, 8);
    const first = context.store.eventsAfter(owner.id, pc.host.id, 0, 128);
    assert.ok(first.length > 0 && first.length < 8); assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1024 * 1024);
    const seen: number[] = []; let cursor = 0;
    while (true) {
      const page = context.store.eventsAfter(owner.id, pc.host.id, cursor, 128); if (!page.length) break;
      seen.push(...page.map(item => item.seq)); cursor = page.at(-1)!.seq;
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(context.store.eventsAfter(owner.id, pc.host.id, 0, 1).length, 1);
    assert.throws(() => context.store.eventsAfter(owner.id, pc.host.id, 0, 257));
  } finally { context.close(); }
});

test("schema v1 upgrades in place and creates v3 tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-pocket-relay-v1-"));
  const path = join(directory, "relay.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('schemaVersion','1')");
  old.close();
  const store = new RelayStore(path);
  try {
    assert.equal(store.meta("schemaVersion"), "3");
    const names = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((row) => row.name);
    assert.ok(names.includes("account_provisions"));
    assert.ok(names.includes("auth_rate_limits"));
    assert.ok(names.includes("update_releases"));
    assert.ok(names.includes("web_security"));
    assert.ok(names.includes("web_key_packages"));
    assert.ok(names.includes("web_tickets"));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v2 upgrades add web tables without changing legacy rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-pocket-relay-v2-"));
  const path = join(directory, "relay.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('schemaVersion','2')");
  old.close();
  const store = new RelayStore(path);
  try {
    assert.equal(store.meta("schemaVersion"), "3");
    assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='web_operations'").get());
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TOTP enrollment advances its version without invalidating the pending login", () => {
  const context = tempStore();
  try {
    const owner = account(context.store, "totp-pending");
    const pending = device(context.store, owner.id, "web-pending");
    const security = context.store.setTotpRequired(owner.id, true);
    const loginToken = context.store.createWebLogin({ accountId: owner.id, deviceId: pending.id, credentialVersion: security.credential_version, totpVersion: security.totp_version, verified: false, signingChallenge: "challenge", boxNonce: "AA", trusted: true, enrollmentSecret: "JBSWY3DPEHPK3PXP" });
    context.store.setTotpSecret(owner.id, "JBSWY3DPEHPK3PXP", ["hash"], loginToken);
    assert.ok(context.store.webLoginByToken(loginToken));
  } finally {
    context.close();
  }
});

test("only the current first TOTP enrollment can commit its secret and recovery hashes", () => {
  const context = tempStore();
  try {
    const owner = account(context.store, "totp-concurrent"); const security = context.store.setTotpRequired(owner.id, true);
    const create = (secret: string) => context.store.createWebLogin({ accountId: owner.id, credentialVersion: security.credential_version, totpVersion: security.totp_version, verified: false, signingChallenge: "challenge", boxNonce: "AA", trusted: true, enrollmentSecret: secret });
    const first = create("SECRET-A"); const second = create("SECRET-B");
    context.store.setTotpSecret(owner.id, "SECRET-A", ["recovery-A"], first);
    assert.throws(() => context.store.setTotpSecret(owner.id, "SECRET-B", ["recovery-B"], second), /已经完成或已失效/);
    const saved = context.store.ensureWebSecurity(owner.id); assert.equal(saved.totp_secret, "SECRET-A"); assert.equal(saved.recovery_hashes, '["recovery-A"]');
    assert.equal(context.store.webLoginByToken(second), undefined);
  } finally { context.close(); }
});

test("Host enrollment repeats exactly with a caller-held token and reserves names before approval", () => {
  const context = tempStore();
  try {
    const owner = account(context.store, "host-retry"); const phone = device(context.store, owner.id, "host-retry");
    const first = context.store.startHostEnrollment("PC", "sign1", "box1"); const second = context.store.startHostEnrollment("PC", "sign2", "box2");
    context.store.approveHostEnrollment(owner.id, phone.id, first.id, first.secret, "PC", "sealed");
    assert.throws(() => context.store.approveHostEnrollment(owner.id, phone.id, second.id, second.secret, "PC", "sealed2"), /同名电脑/);
    assert.equal(context.store.hostEnrollment(second.id, second.secret).approved_account_id, null);
    const proposed = "synthetic-proposed-host-token-123456789";
    const saved = context.store.completeHostEnrollment(first.id, first.secret, proposed);
    context.store.startHostEnrollment("Another", "s3", "b3"); // Pruning must retain the completed receipt.
    assert.deepEqual(context.store.completeHostEnrollment(first.id, first.secret, proposed), saved);
    assert.throws(() => context.store.completeHostEnrollment(first.id, first.secret, "different-proposed-host-token-123456789"), /重试材料/);
    assert.throws(() => context.store.completeHostEnrollment(first.id, "wrong-secret", proposed), /尚未批准或已经失效/);
    context.store.approveHostEnrollment(owner.id, phone.id, second.id, second.secret, "PC 2", "sealed2");
    assert.equal(context.store.completeHostEnrollment(second.id, second.secret).host!.name, "PC 2", "legacy complete remains supported");
    assert.equal(context.store.listHosts(owner.id).length, 2);
    assert.equal(context.store.auditRows().filter((row) => row.action === "host.enroll.complete").length, 2);
    context.store.revokeHost(owner.id, saved.host!.id, phone.id);
    assert.throws(() => context.store.completeHostEnrollment(first.id, first.secret, proposed), /撤销/);
  } finally { context.close(); }
});

test("web migration and password change commit their idempotent result with the business update", () => {
  const context = tempStore();
  try {
    const owner = account(context.store, "web-operations");
    const pending = context.store.createDevice({ accountId: owner.id, name: "Safari", signingPublicKey: "web-sign", encryptionPublicKey: "web-box", approved: false });
    const fingerprint = "migration-fingerprint";
    const first = context.store.completeWebMigration(owner.id, pending.id, "wrapped-package", 0, pending.id, "migration-1", fingerprint,
      (result, tokens) => ({ state: "ready", keyPackageVersion: result.version, tokens }));
    assert.equal(first.replay, false);
    assert.equal((first.response as any).keyPackageVersion, 1);
    const sessionCount = () => Number((context.store.db.prepare("SELECT count(*) AS value FROM sessions WHERE account_id=?").get(owner.id) as any).value);
    assert.equal(sessionCount(), 1);
    const replay = context.store.completeWebMigration(owner.id, pending.id, "wrapped-package", 0, pending.id, "migration-1", fingerprint,
      () => { throw new Error("must not create a second session") });
    assert.equal(replay.replay, true);
    assert.deepEqual(replay.response, { state: "ready", keyPackageVersion: 1 });
    const persisted = String((context.store.db.prepare("SELECT result_json FROM web_operations WHERE account_id=? AND operation_id=?").get(owner.id, "migration-1") as any).result_json);
    assert.equal(/accessToken|refreshToken/.test(persisted), false);
    assert.equal(sessionCount(), 1);

    const current = first.response as any;
    const changed = context.store.changeWebPassword(owner.id, "new-verifier", "rewrapped-package", 1, pending.id, current.tokens.sessionId,
      "password-1", "password-fingerprint", result => ({ changed: true, ...result }));
    assert.equal(changed.replay, false);
    const changedReplay = context.store.changeWebPassword(owner.id, "different-verifier", "different-package", 1, pending.id, current.tokens.sessionId,
      "password-1", "password-fingerprint", () => { throw new Error("must not update twice") });
    assert.equal(changedReplay.replay, true);
    assert.deepEqual(changedReplay.response, changed.response);
  } finally {
    context.close();
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
