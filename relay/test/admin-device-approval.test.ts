import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WebSocket from "ws";
import sodium from "libsodium-wrappers-sumo";
import { assertApprovalAccount, canApproveDevice } from "../admin/src/approval-context.ts";
import { Login } from "../web/src/auth.tsx";
import { b64, bytes, deviceProof, generateDeviceKeys, openAccountPackage, ready, sealAccountPackage } from "../web/src/crypto.ts";
import { approvePendingDevice, pendingDevices } from "../web/src/device-approval.ts";
import { RelayServer } from "../src/server.js";
import { hashPassword } from "../src/auth.js";
import { tempStore } from "./helpers.js";

test("admin approval is restricted to an active own-account pending device", () => {
  assert.equal(canApproveDevice("owner", "owner", "active", "pending"), true);
  for (const args of [["owner", "other", "active", "pending"], ["owner", "owner", "disabled", "pending"],
    ["owner", "owner", "active", "approved"], ["owner", "owner", "active", "revoked"], ["", "", "active", "pending"]]) {
    assert.equal(canApproveDevice(...args as [string, string, string, string]), false);
  }
});

test("temporary unlock fixes the account and offers no persisted-browser checkbox", () => {
  const html = renderToStaticMarkup(React.createElement(Login, { temporaryAccount: { id: "owner", username: "admin" }, onReady() {} }));
  assert.match(html, /readonly=""[^>]*value="admin"/i);
  assert.match(html, /验证账号/);
  assert.doesNotMatch(html, /type="checkbox"|信任此浏览器|设备名称/);
});

test("admin password unlock uses a separate web session and seals only its own pending phone", { timeout: 30000 }, async () => {
  await ready(); const context = tempStore();
  const password = "fixture-admin-password-only";
  const accountKeys = generateDeviceKeys();
  const pkg = { version: 1 as const, ...accountKeys, contentKey: b64(sodium.randombytes_buf(32)) };
  const account = context.store.createAccount({ username: "approval-admin", displayName: "Fixture", role: "admin",
    passwordHash: await hashPassword(password), signingPublicKey: pkg.signingPublicKey, encryptionPublicKey: pkg.encryptionPublicKey, escrowCiphertext: "test-only" });
  const security = context.store.ensureWebSecurity(account.id);
  context.store.saveWebKeyPackage(account.id, await sealAccountPackage(password, pkg), 0, Number(security.credential_version));
  const phoneKeys = generateDeviceKeys();
  const phone = context.store.createDevice({ accountId: account.id, name: "Pending phone", ...phoneKeys, approved: false });
  const otherKeys = generateDeviceKeys();
  const other = context.store.createAccount({ username: "other-owner", displayName: "Other", role: "user", passwordHash: "unused",
    signingPublicKey: otherKeys.signingPublicKey, encryptionPublicKey: otherKeys.encryptionPublicKey, escrowCiphertext: "test-only" });
  const otherPhone = context.store.createDevice({ accountId: other.id, name: "Other phone", ...generateDeviceKeys(), approved: false });
  const oldBrowser = context.store.createDevice({ accountId: account.id, name: "Existing browser", ...generateDeviceKeys(), approved: true });
  const server = new RelayServer({ bindHost: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1", dbPath: "unused", adminDir: "missing", updatesDir: "missing", webEnabled: true }, context.store);
  await server.start(); const base = `http://127.0.0.1:${server.address()!.port}`;
  let socket: WebSocket | undefined;
  const post = async (path: string, body: unknown, token?: string) => {
    const response = await fetch(base + path, { method: "POST", headers: { Origin: "http://127.0.0.1", "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const cookieSession = context.store.createSession(account.id, "web", account.id);
    assert.equal((await post("/api/web/ws-ticket", {}, cookieSession.accessToken)).status, 401, "admin cookie authority cannot grant device authority");
    const keys = generateDeviceKeys();
    const request = { username: account.username, password, deviceName: "Temporary approval", deviceSigningPublicKey: keys.signingPublicKey,
      deviceEncryptionPublicKey: keys.encryptionPublicKey, trustBrowser: false };
    assert.equal((await post("/api/web/login", { ...request, password: "wrong" })).status, 401);
    const login = await post("/api/web/login", request); assert.equal(login.status, 200);
    const completed = await post("/api/web/device/complete", { loginToken: login.body.loginToken, ...await deviceProof(keys, login.body.challenge) });
    assert.equal(completed.status, 200);
    const result = completed.body;
    const opened = await openAccountPackage(password, result.keyPackage, result.account);
    assertApprovalAccount(account.id, result.account, opened);
    assert.throws(() => assertApprovalAccount(other.id, result.account, opened), /不一致/);
    assert.throws(() => assertApprovalAccount(account.id, result.account, { ...opened, contentKey: "bad" }));
    const ticket = await post("/api/web/ws-ticket", {}, result.tokens.accessToken);
    assert.equal(ticket.status, 200);
    socket = new WebSocket(base.replace("http", "ws") + "/ws/device", ["agentpocket.device.v1", ticket.body.ticket], { headers: { Origin: "http://127.0.0.1" } });
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
    let sequence = 0;
    const rpc = { request(method: string, params: unknown): Promise<any> {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket!.off("message", receive); reject(new Error("test RPC timeout")); }, 5000);
        const receive = (raw: any) => { const value = JSON.parse(String(raw)); if (value.id !== id) return;
          clearTimeout(timer); socket!.off("message", receive); if (value.error) reject(new Error(value.error.message)); else resolve(value.result); };
        socket!.on("message", receive); socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    } };
    await rpc.request("relay/hello", { protocolVersion: 2 });
    const pending = await pendingDevices(rpc);
    assert.deepEqual(pending.map((item) => item.id), [phone.id]);
    await assert.rejects(rpc.request("device/approve", { deviceId: otherPhone.id, keyPackage: "test-package" }));
    await approvePendingDevice(rpc, pending[0], opened, result.account);
    const approved = context.store.listDevices(account.id).find((item) => item.id === phone.id)!;
    assert.equal(approved.status, "approved");
    const full = context.store.deviceById(account.id, phone.id)!;
    const plain = sodium.crypto_box_seal_open(bytes(full.key_package!), bytes(phoneKeys.encryptionPublicKey), bytes(phoneKeys.encryptionPrivateKey));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), pkg);
    assert.equal((await post("/api/web/device/forget", {}, result.tokens.accessToken)).status, 200);
    assert.equal(context.store.deviceById(account.id, result.device.id)!.status, "revoked");
    assert.equal(context.store.deviceById(account.id, oldBrowser.id)!.status, "approved");
    assert.equal(context.store.deviceById(account.id, phone.id)!.status, "approved");
    assert.equal(context.store.deviceById(other.id, otherPhone.id)!.status, "pending");
  } finally { socket?.terminate(); await server.stop(); context.close(); }
});
