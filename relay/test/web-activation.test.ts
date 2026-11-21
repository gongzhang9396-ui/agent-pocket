import assert from "node:assert/strict";
import test from "node:test";
import sodium from "libsodium-wrappers-sumo";
import WebSocket from "ws";
import { hashPassword } from "../src/auth.js";
import { RelayServer } from "../src/server.js";
import { totpCode } from "../src/totp.js";
import { tempStore } from "./helpers.js";
import { activationProof, b64, bytes, createWebRegistration, deviceProof, generateDeviceKeys, openAccountPackage, ready, sealHostContentKey } from "../web/src/crypto.ts";
import { RelayClient } from "../web/src/relay-client.ts";
import { approvePendingDevice, pendingDevices } from "../web/src/device-approval.ts";
import { createHostIdentity, applyHostEnrollment, HostChannelCrypto } from "../../bridge/src/relay-crypto.ts";
import { beginHostEnrollment, waitForHostEnrollment } from "../../bridge/src/relay-connector.ts";
import { join } from "node:path";

async function setup() {
  await ready(); const context = tempStore(); const password = "synthetic-friend-password";
  const recovery = generateDeviceKeys(); const adminKeys = generateDeviceKeys();
  const admin = context.store.createAccount({ username: "owner", displayName: "Owner", passwordHash: await hashPassword(password), role: "admin", signingPublicKey: adminKeys.signingPublicKey, encryptionPublicKey: adminKeys.encryptionPublicKey, escrowCiphertext: "fixture" });
  context.store.setMeta("recoveryPublicKey", recovery.encryptionPublicKey);
  const provision = context.store.createAccountProvision({ username: "friend", displayName: "Friend", passwordHash: await hashPassword(password), createdBy: admin.id, webOnly: true });
  const relay = new RelayServer({ bindHost: "127.0.0.1", port: 0, dbPath: "unused", publicUrl: "http://127.0.0.1", adminDir: "missing", updatesDir: "missing", webEnabled: true }, context.store);
  await relay.start(); const base = `http://127.0.0.1:${relay.address()!.port}`;
  const post = async (path: string, body: any, extra: any = {}) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { Origin: "http://127.0.0.1", "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const keys = generateDeviceKeys(); const registration = await createWebRegistration(password, recovery.encryptionPublicKey, keys);
  const material = { ...registration.payload, deviceName: "iPhone browser", deviceSigningPublicKey: keys.signingPublicKey, deviceEncryptionPublicKey: keys.encryptionPublicKey };
  const start = () => post("/api/web/activate/start", { username: provision.username, password, operationId: "test-activation", ...material });
  const completion = async () => { const result = await start(); assert.equal(result.status, 200); const proof = await activationProof(registration.pkg, keys, result.body.challenge); return { ...material, ...proof, activationToken: result.body.activationToken, accountId: result.body.accountId, operationId: result.body.operationId }; };
  return { ...context, relay, base, post, password, admin, recovery, provision, keys, registration, material, start, completion, close: async () => { await relay.stop(); context.close(); } };
}

test("web-only provisions cannot be claimed through Android or reserved-name invites; activation requires password/origin/JSON", async () => {
  const s = await setup();
  try {
    const login = await s.post("/api/web/login", { username: "friend", password: s.password }); assert.equal(login.body.error.code, "ACCOUNT_ACTIVATION_REQUIRED");
    assert.equal((await s.post("/api/web/activate/start", { username: "friend", password: "incorrect", operationId: "x", ...s.material })).status, 401);
    assert.equal((await s.post("/api/web/activate/start", { username: "friend", password: s.password, operationId: "x", ...s.material }, { Origin: "https://foreign.test" })).status, 403);
    assert.equal((await s.post("/api/web/activate/start", { username: "friend", password: s.password, operationId: "x", ...s.material }, { "Content-Type": "application/jsonp" })).status, 400);
    const old = await s.post("/api/auth/activate", { username: "friend", password: s.password, ...s.material, keyPackage: s.material.sealedDevicePackage }); assert.equal(old.status, 403);
    const invite = s.store.createInvite(s.admin.id, "user");
    assert.throws(() => s.store.claimInvite(invite.id, invite.secret, { username: "friend", displayName: "Bad", passwordHash: "fixture", role: "user", signingPublicKey: "sign", encryptionPublicKey: "box", escrowCiphertext: "cipher" }, { name: "device", signingPublicKey: "sign", encryptionPublicKey: "box" }), /预留/);
    assert.equal(s.store.accountById(s.provision.id), undefined); assert.equal(s.store.listDevices(s.provision.id).length, 0);
  } finally { await s.close(); }
});

test("password reset and provision cancellation invalidate activation transactions", async () => {
  const s = await setup();
  try {
    const body = await s.completion(); s.store.resetUserPassword(s.provision.id, await hashPassword("new-synthetic-password"), s.admin.id);
    assert.equal((await s.post("/api/web/activate/complete", body)).status, 401);
    assert.equal(s.store.meta(`webActivationMode:${s.provision.id}`), "web-only", "reset must not downgrade activation policy");
    s.store.resetUserPassword(s.provision.id, await hashPassword(s.password), s.admin.id);
    const next = await s.completion(); s.store.cancelAccountProvision(s.provision.id, s.admin.id);
    assert.equal((await s.post("/api/web/activate/complete", next)).status, 401);
    assert.equal(s.store.accountById(s.provision.id), undefined);
  } finally { await s.close(); }
});

test("activation expiration and malformed public keys fail before account creation", async () => {
  const s = await setup();
  try {
    const body = await s.completion();
    s.store.db.prepare("UPDATE web_logins SET expires_at=? WHERE account_id=?").run(Date.now() - 1, s.provision.id);
    assert.equal((await s.post("/api/web/activate/complete", body)).status, 401);
    assert.equal(s.store.accountById(s.provision.id), undefined);
    assert.equal((await s.post("/api/web/activate/start", { username: "friend", password: s.password, operationId: "short-pk", ...s.material, deviceSigningPublicKey: b64(new Uint8Array(31)) })).status, 400);
    assert.equal((await s.post("/api/web/activate/start", { username: "friend", password: s.password, operationId: "invalid-box", ...s.material, deviceEncryptionPublicKey: b64(new Uint8Array(32)) })).status, 400);
    assert.equal(s.store.listDevices(s.provision.id).length, 0);
  } finally { await s.close(); }
});

test("activation proves all four keys, rolls back partial writes and retries atomically without issuing sessions", async () => {
  const s = await setup();
  try {
    const body = await s.completion();
    for (const patch of [{ deviceSignature: b64(new Uint8Array(64)) }, { accountSignature: b64(new Uint8Array(64)) }, { deviceBoxResponse: b64(new Uint8Array(32)) }, { accountBoxResponse: b64(new Uint8Array(32)) }, { operationId: "other" }, { escrowCiphertext: b64(new Uint8Array(50)) }]) {
      assert.equal((await s.post("/api/web/activate/complete", { ...body, ...patch })).status, 401);
      s.store.db.prepare("DELETE FROM auth_rate_limits").run();
    }
    // Clear test-only throttling after deliberately bad proofs.
    s.store.db.prepare("DELETE FROM auth_rate_limits").run();
    s.store.db.exec("CREATE TEMP TRIGGER fixture_activation_failure BEFORE INSERT ON web_key_packages BEGIN SELECT RAISE(FAIL, 'fixture'); END");
    assert.notEqual((await s.post("/api/web/activate/complete", body)).status, 200);
    assert.ok(s.store.accountProvisionById(s.provision.id)); assert.equal(s.store.accountById(s.provision.id), undefined);
    s.store.db.exec("DROP TRIGGER fixture_activation_failure");
    const results = await Promise.all([s.post("/api/web/activate/complete", body), s.post("/api/web/activate/complete", body)]);
    assert.deepEqual(results.map((result) => result.status), [200, 200]); assert.deepEqual(results[0].body, results[1].body);
    assert.equal(results[0].body.state, "activated"); assert.equal(results[0].body.tokens, undefined);
    assert.equal(s.store.listDevices(s.provision.id).length, 0); assert.equal((s.store.db.prepare("SELECT count(*) AS n FROM sessions WHERE account_id=?").get(s.provision.id) as any).n, 0);
    assert.equal(s.store.accountProvisionById(s.provision.id), undefined); assert.equal(s.store.ensureWebSecurity(s.provision.id).totp_required, 1);
    assert.equal(s.store.auditRows().filter((row) => row.action === "web.account.activate").length, 1);
    assert.equal((await s.post("/api/web/activate/complete", { ...body, accountBoxResponse: b64(new Uint8Array(32)) })).status, 409);
    assert.deepEqual(await openAccountPackage(s.password, s.store.webKeyPackage(s.provision.id).package_json, results[0].body.account), s.registration.pkg);
    const escrow = sodium.crypto_box_seal_open(bytes(s.material.escrowCiphertext), bytes(s.recovery.encryptionPublicKey), bytes(s.recovery.encryptionPrivateKey));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(escrow)), s.registration.pkg);
    const login = await s.post("/api/web/login", { username: "friend", password: s.password, deviceName: "Safari", deviceSigningPublicKey: s.keys.signingPublicKey, deviceEncryptionPublicKey: s.keys.encryptionPublicKey });
    assert.equal(login.body.error.code, "TOTP_ENROLLMENT_REQUIRED"); assert.equal(s.store.listDevices(s.provision.id).length, 0);
    const { loginToken, secret } = login.body.error.data;
    assert.equal((await s.post("/api/web/ws-ticket", { loginToken })).status, 401);
    assert.equal((await s.post("/api/web/device/challenge", { loginToken })).status, 401);
    const enrolled = await s.post("/api/web/totp/enroll/finish", { loginToken, code: totpCode(secret) }); assert.equal(enrolled.status, 200);
    assert.equal(s.store.listDevices(s.provision.id)[0].status, "pending");
    const challenge = await s.post("/api/web/device/challenge", { loginToken });
    const originalVerify = (s.relay as any).verifyWebProof.bind(s.relay); let arrivals = 0; let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    (s.relay as any).verifyWebProof = async (...args: any[]) => { await originalVerify(...args); if (++arrivals === 2) release(); await barrier; };
    const proofBody = { loginToken, ...await deviceProof(s.keys, challenge.body) };
    const attempts = await Promise.all([s.post("/api/web/device/complete", proofBody), s.post("/api/web/device/complete", proofBody)]);
    assert.deepEqual(attempts.map((item) => item.status).sort(), [200, 401]);
    const complete = attempts.find((item) => item.status === 200)!;
    assert.equal((s.store.db.prepare("SELECT count(*) AS n FROM sessions WHERE account_id=?").get(s.provision.id) as any).n, 1);
    assert.equal(complete.body.state, "ready"); assert.ok(complete.body.tokens.accessToken);
    assert.equal(s.store.listDevices(s.provision.id)[0].status, "approved");
    assert.equal((await s.post("/api/web/ws-ticket", {}, { Authorization: `Bearer ${complete.body.tokens.accessToken}` })).status, 200);
    await verifyBrowserHostPairing(s, complete.body);
  } finally { await s.close(); }
});

async function verifyBrowserHostPairing(s: Awaited<ReturnType<typeof setup>>, session: any) {
  const fetchOriginal = globalThis.fetch; const previous = { window: (globalThis as any).window, location: (globalThis as any).location, WebSocket: globalThis.WebSocket };
  let client: RelayClient | undefined; let hostSocket: WebSocket | undefined; let hostChannel: HostChannelCrypto | undefined;
  let seq = 1; const errors: any[] = [];
  const rpc = (socket: WebSocket, method: string, params: any): Promise<any> => {
    const id = seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off("message", receive); reject(new Error("fixture timeout")); }, 5000);
      const receive = (raw: any) => { const value = JSON.parse(String(raw)); if (value.id !== id) return; clearTimeout(timer); socket.off("message", receive); value.error ? reject(new Error(value.error.message)) : resolve(value.result); };
      socket.on("message", receive); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  };
  try {
    (globalThis as any).window = { setTimeout, clearTimeout }; (globalThis as any).location = new URL(s.base);
    (globalThis as any).WebSocket = class extends WebSocket { constructor(url: string, protocols: string[]) { super(url, protocols, { headers: { Origin: "http://127.0.0.1" } }); } };
    globalThis.fetch = ((url: any, init: any) => fetchOriginal(new URL(url, s.base), { ...init, headers: { ...init?.headers, Origin: "http://127.0.0.1" } })) as typeof fetch;
    client = new RelayClient(session.tokens.accessToken, session.tokens.refreshToken, session.account.id, session.device.id, s.keys, s.registration.pkg.contentKey);
    await client.connect(); assert.deepEqual(await client.listHosts(), []);
    const android = generateDeviceKeys();
    const androidLogin = await s.post("/api/auth/login", { username: "friend", password: s.password, deviceName: "Android fixture", deviceSigningPublicKey: android.signingPublicKey, deviceEncryptionPublicKey: android.encryptionPublicKey });
    assert.equal(androidLogin.body.device.status, "pending");
    const pending = (await pendingDevices(client)).find((item) => item.id === androidLogin.body.device.id)!;
    assert.ok(pending); await approvePendingDevice(client, pending, s.registration.pkg, session.account);
    const statusResponse = await fetchOriginal(`${s.base}/api/device/status`, { headers: { Authorization: `Bearer ${androidLogin.body.tokens.accessToken}` } });
    const status: any = await statusResponse.json(); assert.equal(status.device.status, "approved");
    const packageBytes = sodium.crypto_box_seal_open(bytes(status.device.keyPackage), bytes(android.encryptionPublicKey), bytes(android.encryptionPrivateKey));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(packageBytes)), s.registration.pkg);
    assert.equal(s.store.auditRows().filter((row) => row.action === "device.approve").length, 1);
    const identityPath = join(s.directory, "synthetic-host-identity.json");
    const start = process.platform === "win32" ? await beginHostEnrollment(s.base, "Synthetic friend PC", identityPath) : undefined;
    const identity = start?.identity || await createHostIdentity(s.base, "Synthetic friend PC");
    const fallback = start ? undefined : await s.post("/api/host/enroll/start", { name: identity.hostName, signingPublicKey: identity.signingPublicKey, encryptionPublicKey: identity.encryptionPublicKey });
    const enrollment = start?.enrollment || fallback!.body;
    const code = { enrollmentId: enrollment.id, secret: enrollment.secret };
    const inspected = await client.request("host/enroll/inspect", code);
    assert.equal(inspected.signing_public_key, identity.signingPublicKey); assert.equal(inspected.encryption_public_key, identity.encryptionPublicKey);
    await client.request("host/enroll/approve", { ...code, name: identity.hostName, keyPackage: await sealHostContentKey(s.registration.pkg.contentKey, inspected.encryption_public_key) });
    if (start) {
      let lost = false; const bodies: any[] = [];
      globalThis.fetch = (async (url: any, init: any) => {
        const resolved = new URL(url, s.base);
        const response = await fetchOriginal(resolved, { ...init, headers: { ...init?.headers, Origin: "http://127.0.0.1" } });
        if (resolved.pathname === "/api/host/enroll/complete") { bodies.push(JSON.parse(init.body)); if (!lost) { lost = true; throw new Error("simulated completed response lost"); } }
        return response;
      }) as typeof fetch;
      await waitForHostEnrollment(s.base, identityPath, identity, enrollment);
      assert.equal(lost, true); assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1]); assert.ok(bodies[0].proposedHostToken);
      assert.equal(s.store.listHosts(session.account.id).length, 1);
    } else {
      const completed = await s.post("/api/host/enroll/complete", code); assert.equal(completed.status, 201); await applyHostEnrollment(identity, completed.body);
    }
    assert.equal(identity.contentKey, s.registration.pkg.contentKey);
    assert.equal(identity.accountId, session.account.id);
    hostSocket = new WebSocket(s.base.replace("http", "ws") + "/ws/host", { headers: { Authorization: `Bearer ${identity.hostToken}` } });
    await new Promise<void>((resolve, reject) => { hostSocket!.once("open", resolve); hostSocket!.once("error", reject); });
    await rpc(hostSocket, "relay/hello", { protocolVersion: 2 });
    hostSocket.on("message", (raw) => void (async () => {
      const message = JSON.parse(String(raw));
      if (message.method === "channel/open") {
        const accepted = await HostChannelCrypto.accept(identity, message.params.envelope, { id: session.device.id, ...s.keys }); hostChannel = accepted.channel;
        await rpc(hostSocket!, "channel/open", { envelope: accepted.response });
      } else if (message.method === "channel/data") {
        const value = JSON.parse(hostChannel!.decrypt(message.params.envelope));
        await rpc(hostSocket!, "channel/data", { envelope: hostChannel!.encrypt(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { data: [{ id: "fixture-friend-thread" }] } })) });
      }
    })().catch((error) => errors.push(error)));
    const hosts = await client.listHosts(); assert.equal(hosts.length, 1); assert.equal(hosts[0].online, true); assert.deepEqual(s.store.listHosts(s.admin.id), []);
    const channel = await client.openChannel(hosts[0]);
    assert.equal((await client.call(channel, "thread/list", {})).data[0].id, "fixture-friend-thread");
    assert.deepEqual(errors, []);
  } finally {
    await client?.close(); hostSocket?.terminate(); globalThis.fetch = fetchOriginal; Object.assign(globalThis, previous);
  }
}
