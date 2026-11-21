import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import sodium from "libsodium-wrappers-sumo";
import { hashPassword } from "../src/auth.js";
import { RelayServer } from "../src/server.js";
import { totpCode } from "../src/totp.js";
import { tempStore } from "./helpers.js";
import { b64, bytes, generateDeviceKeys, deviceProof, openDeviceAccountPackage, sealAccountPackage, openAccountPackage, ready, type AccountPackage } from "../web/src/crypto.ts";
import { RelayClient } from "../web/src/relay-client.ts";
import { createHostIdentity, HostChannelCrypto } from "../../bridge/src/relay-crypto.ts";

let sequence = 1;
function rpc(socket: WebSocket, method: string, params: any): Promise<any> {
  const id = sequence++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", receive); reject(new Error(`timeout: ${method}`)); }, 5000);
    const receive = (raw: any) => { const value = JSON.parse(String(raw)); if (value.id !== id) return; clearTimeout(timer); socket.off("message", receive); if (value.error) reject(new Error(value.error.message)); else resolve(value.result); };
    socket.on("message", receive); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}
async function socketAt(url: string, token: string) {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  await rpc(socket, "relay/hello", { protocolVersion: 2 }); return socket;
}

test("first browser: TOTP → legacy Android sealed package → migration → real Relay/Host cryptography", { timeout: 30000 }, async () => {
  await ready(); const context = tempStore(); const password = "owner-trial-test-password";
  const accountKeys = generateDeviceKeys(); const pkg: AccountPackage = { version: 1, ...accountKeys, contentKey: b64(sodium.randombytes_buf(32)) };
  const account = context.store.createAccount({ username: "web-first-use", displayName: "Test", passwordHash: await hashPassword(password), role: "user", signingPublicKey: pkg.signingPublicKey, encryptionPublicKey: pkg.encryptionPublicKey, escrowCiphertext: "test-only" });
  const phoneKeys = generateDeviceKeys(); const phone = context.store.createDevice({ accountId: account.id, name: "Test Android", ...phoneKeys, approved: true });
  const phoneSession = context.store.createSession(account.id, "device", phone.id);
  context.store.setTotpRequired(account.id, true);
  const relay = new RelayServer({ bindHost: "127.0.0.1", port: 0, dbPath: "unused", publicUrl: "http://127.0.0.1", adminDir: "missing", updatesDir: "missing", webEnabled: true }, context.store);
  await relay.start(); const base = `http://127.0.0.1:${relay.address()!.port}`;
  const fetchOriginal = globalThis.fetch; const previous = { window: (globalThis as any).window, location: (globalThis as any).location, WebSocket: globalThis.WebSocket };
  let phoneSocket: WebSocket | undefined; let hostSocket: WebSocket | undefined; let client: RelayClient | undefined;
  const post = async (path: string, body: any, token?: string) => {
    const response = await fetchOriginal(`${base}/api/web/${path}`, { method: "POST", headers: { Origin: "http://127.0.0.1", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const keys = generateDeviceKeys();
    const login = await post("login", { username: account.username, password, deviceName: "Test browser", deviceSigningPublicKey: keys.signingPublicKey, deviceEncryptionPublicKey: keys.encryptionPublicKey });
    assert.equal(login.body.error.code, "TOTP_ENROLLMENT_REQUIRED");
    const { loginToken, secret } = login.body.error.data;
    assert.equal(context.store.listDevices(account.id).length, 1, "no browser device before TOTP");
    assert.equal((await post("key-migration/package", { loginToken })).status, 401);
    assert.equal((await post("key-migration/package", { loginToken: phoneSession.accessToken })).status, 401);
    const enrolled = await post("totp/enroll/finish", { loginToken, code: totpCode(secret) });
    assert.equal(enrolled.status, 200); assert.equal(enrolled.body.recoveryCodes.length, 10);
    assert.equal((await post("key-migration/package", { loginToken })).status, 401);
    const challenge = await post("device/challenge", { loginToken });
    const proof = await deviceProof(keys, challenge.body);
    assert.equal((await post("device/complete", { loginToken, ...proof, boxResponse: b64(sodium.randombytes_buf(32)) })).status, 401);
    const complete = await post("device/complete", { loginToken, ...proof });
    assert.equal(complete.body.state, "key_migration_required"); const deviceId = complete.body.device.id;
    const pending = await post("key-migration/package", { loginToken }); assert.equal(pending.body.state, "pending");
    assert.equal(context.store.webKeyPackage(account.id), undefined);
    assert.equal((context.store.db.prepare("SELECT count(*) AS n FROM web_sessions").get() as any).n, 0);
    phoneSocket = await socketAt(base.replace("http", "ws") + "/ws/device", phoneSession.accessToken);
    const sealed = b64(sodium.crypto_box_seal(new TextEncoder().encode(JSON.stringify(pkg)), bytes(keys.encryptionPublicKey)));
    await rpc(phoneSocket, "device/approve", { deviceId, keyPackage: sealed });
    const fetched = await post("key-migration/package", { loginToken }); assert.equal(fetched.status, 200); assert.equal(fetched.body.sealedKeyPackage, sealed);
    const unpacked = await openDeviceAccountPackage(keys, fetched.body.sealedKeyPackage, complete.body.account); assert.deepEqual(unpacked, pkg);
    await assert.rejects(openDeviceAccountPackage(keys, sealed, { ...complete.body.account, signingPublicKey: phoneKeys.signingPublicKey }), /校验失败/);
    const packageJson = await sealAccountPackage(password, unpacked);
    const request = { loginToken, packageJson, expectedVersion: 0, operationId: "first-migration" };
    const migrated = await post("key-migration/complete", request); assert.equal(migrated.status, 200); assert.equal(migrated.body.keyPackageVersion, 1);
    assert.equal((await post("key-migration/complete", { ...request, operationId: "another-migration", expectedVersion: 1 })).status, 401);
    const replayed = await post("key-migration/complete", request); assert.equal(replayed.status, 200); assert.ok(replayed.body.tokens.accessToken);
    assert.deepEqual(await openAccountPackage(password, migrated.body.keyPackage, complete.body.account), pkg);
    assert.throws(() => context.store.refreshSession(replayed.body.tokens.refreshToken), /网页|刷新/);

    const identity = await createHostIdentity(base, "Test Host");
    const enrollment = context.store.startHostEnrollment(identity.hostName, identity.signingPublicKey, identity.encryptionPublicKey);
    context.store.approveHostEnrollment(account.id, phone.id, enrollment.id, enrollment.secret, identity.hostName, "test-key-package");
    const enrolledHost = context.store.completeHostEnrollment(enrollment.id, enrollment.secret);
    Object.assign(identity, { accountId: account.id, hostId: enrolledHost.host.id });
    hostSocket = await socketAt(base.replace("http", "ws") + "/ws/host", enrolledHost.hostToken);
    let hostChannel: HostChannelCrypto | undefined; const hostErrors: any[] = [];
    hostSocket.on("message", (raw) => void (async () => {
      const message = JSON.parse(String(raw));
      if (message.method === "channel/open") {
        const accepted = await HostChannelCrypto.accept(identity, message.params.envelope, { id: deviceId, ...keys }); hostChannel = accepted.channel;
        await rpc(hostSocket!, "channel/open", { envelope: accepted.response });
      } else if (message.method === "channel/data") {
        const value = JSON.parse(hostChannel!.decrypt(message.params.envelope));
        await rpc(hostSocket!, "channel/data", { envelope: hostChannel!.encrypt(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { data: [{ id: "fixture-thread", name: "Encrypted fixture" }] } })) });
      }
    })().catch(error => hostErrors.push(error)));
    (globalThis as any).window = { setTimeout, clearTimeout }; (globalThis as any).location = new URL(base);
    (globalThis as any).WebSocket = class extends WebSocket { constructor(url: string, protocols: string[]) { super(url, protocols, { headers: { Origin: "http://127.0.0.1" } }); } };
    globalThis.fetch = ((url: any, init: any) => fetchOriginal(new URL(url, base), { ...init, headers: { ...init?.headers, Origin: "http://127.0.0.1" } })) as typeof fetch;
    client = new RelayClient(replayed.body.tokens.accessToken, replayed.body.tokens.refreshToken, account.id, deviceId, keys, pkg.contentKey);
    await client.connect(); const hosts = await client.listHosts(); assert.equal(hosts[0].online, true);
    const channel = await client.openChannel(hosts[0]);
    assert.equal((await client.call(channel, "thread/list", {})).data[0].id, "fixture-thread");
    const envelope = hostChannel!.encrypt(JSON.stringify({ value: 1 }));
    assert.throws(() => channel.decrypt({ ...envelope, deviceId: phone.id } as any), /身份/);
    assert.equal(channel.decrypt(envelope as any).value, 1);
    assert.throws(() => channel.decrypt(envelope as any), /乱序/);
    assert.deepEqual(hostErrors, []);
  } finally {
    await client?.close(); phoneSocket?.terminate(); hostSocket?.terminate();
    globalThis.fetch = fetchOriginal; Object.assign(globalThis, previous);
    await relay.stop(); context.close();
  }
});
