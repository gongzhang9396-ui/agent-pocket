import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { hashPassword } from "../src/auth.js";
import { RelayServer } from "../src/server.js";
import { account, device, host, tempStore } from "./helpers.js";

function opened(url: string, token: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function request(socket: WebSocket, id: number, method: string, params: unknown) {
  return new Promise<any>((resolve, reject) => {
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== id) return;
      socket.off("message", listener);
      if (message.error) reject(Object.assign(new Error(message.error.message), message.error));
      else resolve(message.result);
    };
    socket.on("message", listener);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

function nextNotification(socket: WebSocket, method: string) {
  return new Promise<any>((resolve) => {
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      if (message.method !== method) return;
      socket.off("message", listener);
      resolve(message.params);
    };
    socket.on("message", listener);
  });
}

function relayConfig() {
  return {
    bindHost: "127.0.0.1",
    port: 0,
    dbPath: "unused",
    publicUrl: "http://127.0.0.1",
    adminDir: "missing",
  };
}

function cookieJar(response: Response) {
  return response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
}

test("admin CSP permits only WebAssembly evaluation required by libsodium", async () => {
  const context = tempStore();
  const adminDir = mkdtempSync(join(tmpdir(), "agent-pocket-admin-"));
  writeFileSync(join(adminDir, "index.html"), "<!doctype html><title>Agent Pocket</title>");
  const relay = new RelayServer({ ...relayConfig(), adminDir }, context.store);
  await relay.start();
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address()!.port}/bootstrap`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-security-policy"),
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
    );
  } finally {
    await relay.stop();
    context.close();
    rmSync(adminDir, { recursive: true, force: true });
  }
});

test("WSS routes ciphertext to the owned host and denies another account", async () => {
  const context = tempStore();
  const owner = account(context.store, "owner");
  const ownerDevice = device(context.store, owner.id, "owner");
  const ownedHost = host(context.store, owner.id, ownerDevice.id, "owner");
  const outsider = account(context.store, "outsider");
  const outsiderDevice = device(context.store, outsider.id, "outsider");
  const ownerSession = context.store.createSession(owner.id, "device", ownerDevice.id);
  const outsiderSession = context.store.createSession(outsider.id, "device", outsiderDevice.id);
  const relay = new RelayServer(relayConfig(), context.store);
  await relay.start();
  const port = relay.address()!.port;
  const hostSocket = await opened(`ws://127.0.0.1:${port}/ws/host`, ownedHost.hostToken);
  const ownerSocket = await opened(`ws://127.0.0.1:${port}/ws/device`, ownerSession.accessToken);
  const outsiderSocket = await opened(`ws://127.0.0.1:${port}/ws/device`, outsiderSession.accessToken);
  try {
    await request(hostSocket, 1, "relay/hello", { protocolVersion: 2 });
    await request(ownerSocket, 1, "relay/hello", { protocolVersion: 2 });
    await request(outsiderSocket, 1, "relay/hello", { protocolVersion: 2 });
    const delivered = nextNotification(hostSocket, "channel/open");
    const envelope = {
      accountId: owner.id,
      hostId: ownedHost.host.id,
      deviceId: ownerDevice.id,
      channelId: "channel-one",
      counter: 0,
      kind: "channel.open",
      ciphertext: "encrypted-payload",
    };
    await request(ownerSocket, 2, "channel/open", { envelope });
    assert.equal((await delivered).envelope.ciphertext, "encrypted-payload");
    await assert.rejects(
      request(ownerSocket, 3, "channel/data", { envelope: { ...envelope, counter: 1, kind: "channel.data", ciphertext: "too-early" } }),
      /握手尚未完成/,
    );
    const openedOnPhone = nextNotification(ownerSocket, "channel/open");
    await request(hostSocket, 2, "channel/open", {
      envelope: { ...envelope, counter: 0, kind: "channel.open", ciphertext: "host-handshake" },
    });
    assert.equal((await openedOnPhone).envelope.ciphertext, "host-handshake");
    const dataOnHost = nextNotification(hostSocket, "channel/data");
    await request(ownerSocket, 4, "channel/data", {
      envelope: { ...envelope, counter: 1, kind: "channel.data", ciphertext: "device-data" },
    });
    assert.equal((await dataOnHost).envelope.ciphertext, "device-data");
    await assert.rejects(
      request(outsiderSocket, 2, "channel/open", { envelope: { ...envelope, accountId: outsider.id, deviceId: outsiderDevice.id, channelId: "bad" } }),
      /主机不存在/,
    );
  } finally {
    hostSocket.close(); ownerSocket.close(); outsiderSocket.close();
    await relay.stop();
    context.close();
  }
});

test("a stale Host close cannot evict its replacement connection", async () => {
  const context = tempStore();
  const owner = account(context.store, "host-reconnect");
  const ownerDevice = device(context.store, owner.id, "host-reconnect");
  const ownedHost = host(context.store, owner.id, ownerDevice.id, "host-reconnect");
  const deviceSession = context.store.createSession(owner.id, "device", ownerDevice.id);
  const relay = new RelayServer(relayConfig(), context.store);
  await relay.start();
  const url = `ws://127.0.0.1:${relay.address()!.port}`;
  const oldHost = await opened(`${url}/ws/host`, ownedHost.hostToken);
  const phone = await opened(`${url}/ws/device`, deviceSession.accessToken);
  let newHost: WebSocket | undefined;
  try {
    await request(oldHost, 1, "relay/hello", { protocolVersion: 2 });
    await request(phone, 1, "relay/hello", { protocolVersion: 2 });
    const oldClosed = new Promise<void>((resolve) => oldHost.once("close", () => resolve()));
    newHost = await opened(`${url}/ws/host`, ownedHost.hostToken);
    await request(newHost, 1, "relay/hello", { protocolVersion: 2 });
    await oldClosed;

    const listed = await request(phone, 2, "host/list", {});
    assert.equal(listed.find((item: any) => item.id === ownedHost.host.id)?.online, true);
    const delivered = nextNotification(newHost, "channel/open");
    await request(phone, 3, "channel/open", {
      envelope: {
        accountId: owner.id,
        hostId: ownedHost.host.id,
        deviceId: ownerDevice.id,
        channelId: "replacement-channel",
        counter: 0,
        kind: "channel.open",
        ciphertext: "replacement-handshake",
      },
    });
    assert.equal((await delivered).envelope.channelId, "replacement-channel");
  } finally {
    oldHost.close();
    newHost?.close();
    phone.close();
    await relay.stop();
    context.close();
  }
});

test("Host responses do not consume a channel counter while the phone is reconnecting", async () => {
  const context = tempStore();
  const owner = account(context.store, "phone-reconnect");
  const ownerDevice = device(context.store, owner.id, "phone-reconnect");
  const ownedHost = host(context.store, owner.id, ownerDevice.id, "phone-reconnect");
  const deviceSession = context.store.createSession(owner.id, "device", ownerDevice.id);
  const relay = new RelayServer(relayConfig(), context.store);
  await relay.start();
  const url = `ws://127.0.0.1:${relay.address()!.port}`;
  const hostSocket = await opened(`${url}/ws/host`, ownedHost.hostToken);
  const phone = await opened(`${url}/ws/device`, deviceSession.accessToken);
  let replacement: WebSocket | undefined;
  const openEnvelope = {
    accountId: owner.id,
    hostId: ownedHost.host.id,
    deviceId: ownerDevice.id,
    channelId: "phone-reconnect-channel",
    counter: 0,
    kind: "channel.open",
    ciphertext: "device-handshake",
  };
  try {
    await request(hostSocket, 1, "relay/hello", { protocolVersion: 2 });
    await request(phone, 1, "relay/hello", { protocolVersion: 2 });
    const openedOnHost = nextNotification(hostSocket, "channel/open");
    await request(phone, 2, "channel/open", { envelope: openEnvelope });
    await openedOnHost;
    const openedOnPhone = nextNotification(phone, "channel/open");
    await request(hostSocket, 2, "channel/open", {
      envelope: { ...openEnvelope, ciphertext: "host-handshake" },
    });
    await openedOnPhone;

    replacement = await opened(`${url}/ws/device`, deviceSession.accessToken);
    const closed = new Promise<void>((resolve) => phone.once("close", () => resolve()));
    phone.close();
    await closed;
    const responseEnvelope = { ...openEnvelope, counter: 1, kind: "channel.data", ciphertext: "host-response" };
    await assert.rejects(request(hostSocket, 3, "channel/data", { envelope: responseEnvelope }), /目标手机当前离线/);

    await request(replacement, 1, "relay/hello", { protocolVersion: 2 });
    const delivered = nextNotification(replacement, "channel/data");
    await request(hostSocket, 4, "channel/data", { envelope: responseEnvelope });
    assert.equal((await delivered).envelope.ciphertext, "host-response");
  } finally {
    hostSocket.close();
    phone.close();
    replacement?.close();
    await relay.stop();
    context.close();
  }
});

test("unconfirmed channels expire and each device has a bounded channel quota", async () => {
  const context = tempStore();
  const owner = account(context.store, "channel-quota");
  const ownerDevice = device(context.store, owner.id, "channel-quota");
  const ownedHost = host(context.store, owner.id, ownerDevice.id, "channel-quota");
  const deviceSession = context.store.createSession(owner.id, "device", ownerDevice.id);
  const relay = new RelayServer(relayConfig(), context.store);
  await relay.start();
  const url = `ws://127.0.0.1:${relay.address()!.port}`;
  const hostSocket = await opened(`${url}/ws/host`, ownedHost.hostToken);
  const phone = await opened(`${url}/ws/device`, deviceSession.accessToken);
  const envelope = (channelId: string) => ({
    accountId: owner.id,
    hostId: ownedHost.host.id,
    deviceId: ownerDevice.id,
    channelId,
    counter: 0,
    kind: "channel.open",
    ciphertext: `cipher-${channelId}`,
  });
  try {
    await request(hostSocket, 1, "relay/hello", { protocolVersion: 2 });
    await request(phone, 1, "relay/hello", { protocolVersion: 2 });
    for (let index = 0; index < 8; index += 1) {
      await request(phone, 10 + index, "channel/open", { envelope: envelope(`quota-${index}`) });
    }
    await assert.rejects(request(phone, 30, "channel/open", { envelope: envelope("quota-overflow") }), /数量已达上限/);

    (relay as any).pruneChannels(Date.now() + 31_000);
    await request(phone, 31, "channel/open", { envelope: envelope("fresh-channel") });
    (relay as any).pruneChannels(Date.now() + 62_000);
    await assert.rejects(
      request(phone, 32, "channel/data", {
        envelope: { ...envelope("fresh-channel"), counter: 1, kind: "channel.data", ciphertext: "late-data" },
      }),
      /通道不存在/,
    );
  } finally {
    hostSocket.close();
    phone.close();
    await relay.stop();
    context.close();
  }
});

test("event/get returns only the authenticated account's encrypted event", async () => {
  const context = tempStore();
  const owner = account(context.store, "event-owner");
  const ownerDevice = device(context.store, owner.id, "event-owner");
  const ownedHost = host(context.store, owner.id, ownerDevice.id, "event-owner");
  const outsider = account(context.store, "event-outsider");
  const outsiderDevice = device(context.store, outsider.id, "event-outsider");
  const ownerSession = context.store.createSession(owner.id, "device", ownerDevice.id);
  const outsiderSession = context.store.createSession(outsider.id, "device", outsiderDevice.id);
  const relay = new RelayServer(relayConfig(), context.store);
  await relay.start();
  const port = relay.address()!.port;
  const hostSocket = await opened(`ws://127.0.0.1:${port}/ws/host`, ownedHost.hostToken);
  const ownerSocket = await opened(`ws://127.0.0.1:${port}/ws/device`, ownerSession.accessToken);
  const outsiderSocket = await opened(`ws://127.0.0.1:${port}/ws/device`, outsiderSession.accessToken);
  try {
    await request(hostSocket, 1, "relay/hello", { protocolVersion: 2 });
    await request(ownerSocket, 1, "relay/hello", { protocolVersion: 2 });
    await request(outsiderSocket, 1, "relay/hello", { protocolVersion: 2 });
    await request(hostSocket, 2, "event/append", {
      envelope: {
        accountId: owner.id,
        hostId: ownedHost.host.id,
        deviceId: ownedHost.host.id,
        channelId: "events",
        counter: 0,
        kind: "event.append",
        eventId: "event-one",
        eventType: "completed",
        ciphertext: "sealed-event",
      },
    });

    const stored = await request(ownerSocket, 2, "event/get", { hostId: ownedHost.host.id, eventId: "event-one" });
    assert.equal(stored.seq, 1);
    assert.equal(stored.envelope.ciphertext, "sealed-event");
    assert.equal(await request(ownerSocket, 3, "event/get", { hostId: ownedHost.host.id, eventId: "missing" }), null);
    await assert.rejects(
      request(outsiderSocket, 2, "event/get", { hostId: ownedHost.host.id, eventId: "event-one" }),
      /主机不存在/,
    );
  } finally {
    hostSocket.close(); ownerSocket.close(); outsiderSocket.close();
    await relay.stop();
    context.close();
  }
});

test("Host event and snapshot retries are idempotent only for identical ciphertext", async () => {
  const context = tempStore();
  const owner = account(context.store, "ack-owner");
  const ownerDevice = device(context.store, owner.id, "ack-owner");
  const ownedHost = host(context.store, owner.id, ownerDevice.id, "ack-owner");
  const ownerSession = context.store.createSession(owner.id, "device", ownerDevice.id);
  const relay = new RelayServer(relayConfig(), context.store);
  await relay.start();
  const hostSocket = await opened(`ws://127.0.0.1:${relay.address()!.port}/ws/host`, ownedHost.hostToken);
  const ownerSocket = await opened(`ws://127.0.0.1:${relay.address()!.port}/ws/device`, ownerSession.accessToken);
  try {
    await request(hostSocket, 1, "relay/hello", { protocolVersion: 2 });
    await request(ownerSocket, 1, "relay/hello", { protocolVersion: 2 });
    const eventEnvelope = {
      accountId: owner.id,
      hostId: ownedHost.host.id,
      deviceId: ownedHost.host.id,
      channelId: "events",
      counter: 0,
      kind: "event.append",
      eventId: "event-retry",
      eventType: "status",
      ciphertext: "same-event-ciphertext",
    };
    assert.equal((await request(hostSocket, 2, "event/append", { envelope: eventEnvelope })).stored, true);
    assert.equal((await request(hostSocket, 3, "event/append", { envelope: eventEnvelope })).duplicate, true);
    await assert.rejects(
      request(hostSocket, 4, "event/append", { envelope: { ...eventEnvelope, ciphertext: "different-event-ciphertext" } }),
      /不同密文/,
    );

    const snapshotEnvelope = {
      accountId: owner.id,
      hostId: ownedHost.host.id,
      deviceId: ownedHost.host.id,
      channelId: "snapshot",
      counter: 0,
      kind: "snapshot.put",
      ciphertext: "same-snapshot-ciphertext",
    };
    const snapshotUpdated = nextNotification(ownerSocket, "snapshot/updated");
    assert.equal((await request(hostSocket, 5, "snapshot/put", { envelope: snapshotEnvelope })).stored, true);
    const updated = await snapshotUpdated as any;
    assert.equal(updated.hostId, ownedHost.host.id);
    assert.equal(updated.revision, 0);
    assert.match(updated.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal((await request(hostSocket, 6, "snapshot/put", { envelope: snapshotEnvelope })).duplicate, true);
    await assert.rejects(
      request(hostSocket, 7, "snapshot/put", { envelope: { ...snapshotEnvelope, ciphertext: "different-snapshot-ciphertext" } }),
      /重复或乱序/,
    );
  } finally {
    hostSocket.close(); ownerSocket.close();
    await relay.stop();
    context.close();
  }
});

test("snapshot/get returns an explicit null before the host uploads a snapshot", async () => {
  const context = tempStore();
  const owner = account(context.store, "empty-snapshot-owner");
  const ownerDevice = device(context.store, owner.id, "empty-snapshot-owner");
  const ownedHost = host(context.store, owner.id, ownerDevice.id, "empty-snapshot-owner");
  const ownerSession = context.store.createSession(owner.id, "device", ownerDevice.id);
  const relay = new RelayServer(relayConfig(), context.store);
  await relay.start();
  const ownerSocket = await opened(`ws://127.0.0.1:${relay.address()!.port}/ws/device`, ownerSession.accessToken);
  try {
    await request(ownerSocket, 1, "relay/hello", { protocolVersion: 2 });
    assert.equal(await request(ownerSocket, 2, "snapshot/get", { hostId: ownedHost.host.id }), null);
  } finally {
    ownerSocket.close();
    await relay.stop();
    context.close();
  }
});

test("admin recovery API requires CSRF and audits the selected pending device", async () => {
  const context = tempStore();
  const password = "correct-horse-battery";
  const admin = context.store.createAccount({
    username: "relay-admin",
    displayName: "Relay Admin",
    passwordHash: await hashPassword(password),
    role: "admin",
    signingPublicKey: "admin-sign",
    encryptionPublicKey: "admin-box",
    escrowCiphertext: "admin-escrow",
  });
  const owner = account(context.store, "http-recovery");
  const pending = context.store.createDevice({
    accountId: owner.id,
    name: "Replacement phone",
    signingPublicKey: "pending-sign",
    encryptionPublicKey: "pending-box",
    approved: false,
  });
  context.store.setMeta("recoveryPublicKey", "offline-recovery-public-key");
  const relay = new RelayServer(relayConfig(), context.store);
  await relay.start();
  const base = `http://127.0.0.1:${relay.address()!.port}`;
  try {
    const login = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: admin.username, password }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as any;
    const setCookies = login.headers.getSetCookie();
    assert.ok(setCookies.some((value) => value.startsWith("ap_csrf=") && value.includes("Path=/;")));
    const cookies = cookieJar(login);
    assert.match(cookies, /ap_access=/);

    const path = `/api/admin/users/${owner.id}/devices/${pending.id}/recovery`;
    const bundleResponse = await fetch(`${base}${path}`, { headers: { cookie: cookies } });
    assert.equal(bundleResponse.status, 200);
    const bundle = await bundleResponse.json() as any;
    assert.equal(bundle.accountId, owner.id);
    assert.equal(bundle.deviceId, pending.id);
    assert.equal(bundle.recoveryPublicKey, "offline-recovery-public-key");
    assert.ok(context.store.auditRows(20).some((row) => row.action === "device.recovery_bundle.read"
      && row.actor_id === admin.id && row.target_id === pending.id));

    const rejected = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: cookies, "content-type": "application/json" },
      body: JSON.stringify({ keyPackage: "sealed-account-package" }),
    });
    assert.equal(rejected.status, 403);
    assert.equal(context.store.deviceById(owner.id, pending.id)?.status, "pending");

    const recovered = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: cookies, "x-csrf-token": loginBody.csrf, "content-type": "application/json" },
      body: JSON.stringify({ keyPackage: "sealed-account-package" }),
    });
    assert.equal(recovered.status, 200);
    assert.equal(context.store.deviceById(owner.id, pending.id)?.status, "approved");
    assert.ok(context.store.auditRows(20).some((row) => row.action === "device.recover"
      && row.actor_id === admin.id && row.target_id === pending.id));
    assert.equal(JSON.stringify(context.store.auditRows(100)).includes("sealed-account-package"), false);
    assert.equal(JSON.stringify(context.store.auditRows(100)).includes("admin-escrow"), false);
  } finally {
    await relay.stop();
    context.close();
  }
});
