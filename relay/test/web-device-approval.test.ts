import assert from "node:assert/strict";
import test from "node:test";
import sodium from "libsodium-wrappers-sumo";
import { b64, bytes, generateDeviceKeys, ready } from "../web/src/crypto.ts";
import { approvePendingDevice, deviceVerificationCode, pendingDevices } from "../web/src/device-approval.ts";

await ready();
const accountKeys = generateDeviceKeys();
const account = { signingPublicKey: accountKeys.signingPublicKey, encryptionPublicKey: accountKeys.encryptionPublicKey };
const pkg = { version: 1 as const, ...accountKeys, contentKey: b64(sodium.randombytes_buf(32)) };
const target = generateDeviceKeys();
const row = { id: "new-device", name: "test-phone", status: "pending", signing_public_key: target.signingPublicKey, encryption_public_key: target.encryptionPublicKey, created_at: 123 };

test("verification code matches Android and binds the device and public key", () => {
  assert.equal(deviceVerificationCode({ id: "test-device", encryption_public_key: "public-key" }), "1BA1 CD2F F06A BA12");
  assert.notEqual(deviceVerificationCode(row), deviceVerificationCode({ ...row, id: "other" }));
});

test("web approval seals the full Android account package for the selected device only", async () => {
  const calls: string[] = [];
  const client = { async request(method: string, params: any) {
    calls.push(method);
    if (method === "device/list") return [row];
    assert.equal(method, "device/approve"); assert.equal(params.deviceId, row.id);
    const opened = sodium.crypto_box_seal_open(bytes(params.keyPackage), bytes(target.encryptionPublicKey), bytes(target.encryptionPrivateKey));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(opened)), pkg);
    const other = generateDeviceKeys();
    assert.throws(() => sodium.crypto_box_seal_open(bytes(params.keyPackage), bytes(other.encryptionPublicKey), bytes(other.encryptionPrivateKey)));
    assert.doesNotMatch(params.keyPackage, new RegExp(pkg.contentKey));
    return { approved: true };
  } };
  const [selected] = await pendingDevices(client);
  assert.deepEqual(await approvePendingDevice(client, selected, pkg, account), { approved: true });
  assert.deepEqual(calls, ["device/list", "device/list", "device/approve"]);
});

test("stale device information, malformed keys, duplicate IDs and mismatched accounts cannot be approved", async () => {
  let devices: any[] = [row]; let writes = 0;
  const client = { async request(method: string) { if (method === "device/list") return devices; writes++; return {}; } };
  const [selected] = await pendingDevices(client);
  for (const changed of [{ ...row, name: "other" }, { ...row, status: "approved" }, { ...row, encryption_public_key: generateDeviceKeys().encryptionPublicKey }]) {
    devices = [changed]; await assert.rejects(approvePendingDevice(client, selected, pkg, account));
  }
  devices = [row, row]; await assert.rejects(approvePendingDevice(client, selected, pkg, account));
  devices = [{ ...row, encryption_public_key: "invalid" }]; await assert.rejects(pendingDevices(client));
  devices = [row]; await assert.rejects(approvePendingDevice(client, selected, pkg, { ...account, encryptionPublicKey: generateDeviceKeys().encryptionPublicKey }));
  assert.equal(writes, 0);
});

test("an uncertain approval response is never retried automatically", async () => {
  let writes = 0;
  const client = { async request(method: string) { if (method === "device/list") return [row]; writes++; throw new Error("disconnected"); } };
  const [selected] = await pendingDevices(client);
  await assert.rejects(approvePendingDevice(client, selected, pkg, account));
  assert.equal(writes, 1);
});
