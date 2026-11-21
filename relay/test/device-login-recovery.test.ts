import assert from "node:assert/strict";
import test from "node:test";
import sodium from "libsodium-wrappers-sumo";
import { RelayServer } from "../src/server.js";
import { hashPassword } from "../src/auth.js";
import { tempStore } from "./helpers.js";

test("device-private-key proof recovers the original login after a lost response", async () => {
  await sodium.ready;
  const context = tempStore();
  const relay = new RelayServer({ bindHost: "127.0.0.1", port: 0, dbPath: context.path, publicUrl: "http://127.0.0.1", adminDir: "missing", updatesDir: "missing" }, context.store);
  const password = "test-password-only", username = "recovery-test";
  const owner = context.store.createAccount({ username, displayName: "Test", role: "user", passwordHash: await hashPassword(password, { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }),
    signingPublicKey: "account-sign", encryptionPublicKey: "account-box", escrowCiphertext: "unused" });
  const signing = sodium.crypto_sign_keypair(), encryption = sodium.crypto_box_keypair();
  const sign = Buffer.from(signing.publicKey).toString("base64url"), box = Buffer.from(encryption.publicKey).toString("base64url");
  function request(proofTime = Date.now()) {
    const message = JSON.stringify(["agent-pocket-device-login-recovery-v1", username, sign, box, proofTime]);
    return { username, password, deviceName: "Phone", deviceSigningPublicKey: sign, deviceEncryptionPublicKey: box,
      recoverDeviceKeys: true, deviceProofIssuedAt: proofTime, deviceRecoveryProof: Buffer.from(sodium.crypto_sign_detached(Buffer.from(message), signing.privateKey)).toString("base64url") };
  }
  await relay.start();
  try {
    const base = `http://127.0.0.1:${relay.address()!.port}`;
    const post = (body: unknown) => fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const config = await (await fetch(`${base}/api/public/config`)).json() as any;
    assert.equal(config.deviceLoginRecovery, 1);
    const first = await post(request()); assert.equal(first.status, 200); const one = await first.json() as any;
    const retried = await post(request()); assert.equal(retried.status, 200); const two = await retried.json() as any;
    assert.equal(one.device.id, two.device.id); assert.equal(context.store.listDevices(owner.id).length, 1);
    assert.equal((await post({ ...request(), deviceRecoveryProof: "A".repeat(86) })).status, 401);
    assert.equal((await post(request(Date.now() - 6 * 60_000))).status, 401);
    assert.equal(context.store.listDevices(owner.id).length, 1);
  } finally { await relay.stop(); context.close(); sodium.memzero(signing.privateKey); sodium.memzero(encryption.privateKey); }
});
