import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type sodiumType from "libsodium-wrappers-sumo";
import {
  HostChannelCrypto,
  createHostIdentity,
  loadHostIdentity,
  relayAad,
  relayHandshakeBytes,
  saveHostIdentity,
  type RelayCipherEnvelope,
} from "../src/relay-crypto.ts";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo") as typeof sodiumType;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const b64 = (value: Uint8Array) => sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
const bytes = (value: string) => sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
const streamKey = (shared: Uint8Array, transcript: Uint8Array, direction: string) =>
  sodium.crypto_generichash(32, new Uint8Array([...transcript, ...encoder.encode(`\0${direction}`)]), shared);

test("fixed libsodium vectors match the Android and browser protocol", async () => {
  await sodium.ready;
  const vector = JSON.parse(readFileSync(new URL("../../protocol/crypto-vectors.json", import.meta.url), "utf8"));
  const metadata = vector.metadata as Omit<RelayCipherEnvelope, "ciphertext">;
  const aad = relayAad(metadata);
  assert.equal(b64(aad), vector.aad);

  const aeadCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    bytes(vector.aead.message),
    aad,
    null,
    bytes(vector.aead.nonce),
    bytes(vector.aead.key),
  );
  assert.equal(b64(aeadCiphertext), vector.aead.ciphertext);

  const publicA = sodium.crypto_scalarmult_base(bytes(vector.x25519.privateA));
  const publicB = sodium.crypto_scalarmult_base(bytes(vector.x25519.privateB));
  const shared = sodium.crypto_scalarmult(bytes(vector.x25519.privateA), publicB);
  assert.equal(b64(publicA), vector.x25519.publicA);
  assert.equal(b64(publicB), vector.x25519.publicB);
  assert.equal(b64(shared), vector.x25519.shared);
  assert.equal(b64(streamKey(shared, bytes(vector.x25519.transcript), vector.x25519.direction)), vector.x25519.derivedKey);

  assert.equal(b64(relayHandshakeBytes(vector.ed25519.handshake)), vector.ed25519.handshakeBytes);
  assert.equal(
    sodium.crypto_sign_verify_detached(
      bytes(vector.ed25519.signature),
      bytes(vector.ed25519.handshakeBytes),
      bytes(vector.ed25519.publicKey),
    ),
    true,
  );

  const unsealed = sodium.crypto_box_seal_open(
    bytes(vector.sealedBox.ciphertext),
    bytes(vector.sealedBox.publicKey),
    bytes(vector.sealedBox.privateKey),
  );
  assert.equal(b64(unsealed), vector.sealedBox.message);

  const pull = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
    bytes(vector.secretstream.header),
    bytes(vector.secretstream.key),
  );
  const opened = sodium.crypto_secretstream_xchacha20poly1305_pull(
    pull,
    bytes(vector.secretstream.ciphertext),
    bytes(vector.secretstream.aad),
  );
  assert.ok(opened);
  assert.equal(opened.tag, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
  assert.equal(b64(opened.message), vector.secretstream.message);
});

test("phone and Host complete signed ephemeral handshake and secretstream exchange", async () => {
  await sodium.ready;
  const identity = await createHostIdentity("https://relay.example.test", "PC");
  identity.accountId = "account-id";
  identity.hostId = "host-id";
  const phoneSigning = sodium.crypto_sign_keypair();
  const phoneEncryption = sodium.crypto_box_keypair();
  const phoneEphemeral = sodium.crypto_box_keypair();
  const peer = {
    id: "device-id",
    signingPublicKey: b64(phoneSigning.publicKey),
    encryptionPublicKey: b64(phoneEncryption.publicKey),
  };
  const channelId = "channel-id";
  const provisionalHeader = sodium.randombytes_buf(sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES);
  const openUnsigned = {
    version: 2,
    accountId: identity.accountId,
    hostId: identity.hostId,
    deviceId: peer.id,
    channelId,
    issuedAt: Date.now(),
    ephemeralPublicKey: b64(phoneEphemeral.publicKey),
    secretstreamHeader: b64(provisionalHeader),
  };
  const staticShared = sodium.crypto_scalarmult(phoneEphemeral.privateKey, bytes(identity.encryptionPublicKey));
  const transcript = encoder.encode(`agent-pocket-relay-v2\0${identity.accountId}\0${identity.hostId}\0${peer.id}\0${channelId}`);
  const deviceToHost = streamKey(staticShared, transcript, "device-to-host");
  const devicePush = sodium.crypto_secretstream_xchacha20poly1305_init_push(deviceToHost);
  openUnsigned.secretstreamHeader = b64(devicePush.header);
  const openPayload = {
    ...openUnsigned,
    signature: b64(sodium.crypto_sign_detached(relayHandshakeBytes(openUnsigned), phoneSigning.privateKey)),
  };
  const openEnvelope: RelayCipherEnvelope = {
    accountId: identity.accountId,
    hostId: identity.hostId,
    deviceId: peer.id,
    channelId,
    counter: 0,
    kind: "channel.open",
    ciphertext: b64(sodium.crypto_box_seal(encoder.encode(JSON.stringify(openPayload)), bytes(identity.encryptionPublicKey))),
  };
  const accepted = await HostChannelCrypto.accept(identity, openEnvelope, peer);
  const responsePlain = sodium.crypto_box_seal_open(
    bytes(accepted.response.ciphertext),
    phoneEncryption.publicKey,
    phoneEncryption.privateKey,
  );
  assert.ok(responsePlain);
  const response = JSON.parse(decoder.decode(responsePlain));
  const responseSignature = response.signature;
  delete response.signature;
  assert.equal(sodium.crypto_sign_verify_detached(bytes(responseSignature), relayHandshakeBytes(response), bytes(identity.signingPublicKey)), true);

  const hostEphemeralPublic = bytes(response.ephemeralPublicKey);
  const ephemeralShared = sodium.crypto_scalarmult(phoneEncryption.privateKey, hostEphemeralPublic);
  const hostToDevice = streamKey(ephemeralShared, transcript, "host-to-device");
  const deviceMetadata = {
    accountId: identity.accountId,
    hostId: identity.hostId,
    deviceId: peer.id,
    channelId,
    counter: 1,
    kind: "channel.data" as const,
  };
  const ciphertext = sodium.crypto_secretstream_xchacha20poly1305_push(
    devicePush.state,
    encoder.encode("phone request"),
    relayAad(deviceMetadata),
    sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
  );
  const dataEnvelope = { ...deviceMetadata, ciphertext: b64(ciphertext) };
  assert.equal(accepted.channel.decrypt(dataEnvelope), "phone request");
  assert.throws(() => accepted.channel.decrypt(dataEnvelope), /重复、乱序/);

  const hostResponse = accepted.channel.encrypt("host response");
  const devicePull = sodium.crypto_secretstream_xchacha20poly1305_init_pull(bytes(response.secretstreamHeader), hostToDevice);
  const opened = sodium.crypto_secretstream_xchacha20poly1305_pull(
    devicePull,
    bytes(hostResponse.ciphertext),
    relayAad((({ ciphertext: _ciphertext, ...metadata }) => metadata)(hostResponse)),
  );
  assert.ok(opened);
  assert.equal(decoder.decode(opened.message), "host response");
});

test("Windows persists Host secrets with DPAPI and remembers accepted channels across restarts", {
  skip: process.platform !== "win32",
}, async () => {
  await sodium.ready;
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-dpapi-"));
  const identityPath = join(base, "host-identity.json");
  try {
    const identity = await createHostIdentity("https://relay.example.test", "PC");
    identity.accountId = "account-id";
    identity.hostId = "host-id";
    identity.hostToken = "host-token-must-not-leak";
    identity.contentKey = b64(sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES));

    const phoneSigning = sodium.crypto_sign_keypair();
    const phoneEncryption = sodium.crypto_box_keypair();
    const phoneEphemeral = sodium.crypto_box_keypair();
    const peer = {
      id: "device-id",
      signingPublicKey: b64(phoneSigning.publicKey),
      encryptionPublicKey: b64(phoneEncryption.publicKey),
    };
    const channelId = "persisted-channel-id";
    const shared = sodium.crypto_scalarmult(phoneEphemeral.privateKey, bytes(identity.encryptionPublicKey));
    const transcript = encoder.encode(`agent-pocket-relay-v2\0${identity.accountId}\0${identity.hostId}\0${peer.id}\0${channelId}`);
    const push = sodium.crypto_secretstream_xchacha20poly1305_init_push(streamKey(shared, transcript, "device-to-host"));
    const unsigned = {
      version: 2,
      accountId: identity.accountId,
      hostId: identity.hostId,
      deviceId: peer.id,
      channelId,
      issuedAt: Date.now(),
      ephemeralPublicKey: b64(phoneEphemeral.publicKey),
      secretstreamHeader: b64(push.header),
    };
    const payload = {
      ...unsigned,
      signature: b64(sodium.crypto_sign_detached(relayHandshakeBytes(unsigned), phoneSigning.privateKey)),
    };
    const envelope: RelayCipherEnvelope = {
      accountId: identity.accountId,
      hostId: identity.hostId,
      deviceId: peer.id,
      channelId,
      counter: 0,
      kind: "channel.open",
      ciphertext: b64(sodium.crypto_box_seal(encoder.encode(JSON.stringify(payload)), bytes(identity.encryptionPublicKey))),
    };

    await HostChannelCrypto.accept(identity, envelope, peer);
    saveHostIdentity(identityPath, identity);
    const firstDisk = readFileSync(identityPath, "utf8");
    const stored = JSON.parse(firstDisk);
    assert.equal(stored.protection, "dpapi-current-user");
    assert.equal(typeof stored.protectedSecrets, "string");
    for (const name of ["signingPrivateKey", "encryptionPrivateKey", "hostToken", "contentKey"]) {
      assert.equal(Object.hasOwn(stored, name), false);
    }
    for (const secret of [identity.signingPrivateKey, identity.encryptionPrivateKey, identity.hostToken, identity.contentKey]) {
      assert.equal(firstDisk.includes(secret!), false);
    }

    const loaded = loadHostIdentity(identityPath)!;
    assert.equal(loaded.hostToken, identity.hostToken);
    assert.equal(loaded.signingPrivateKey, identity.signingPrivateKey);
    loaded.eventCounter = 7;
    saveHostIdentity(identityPath, loaded);
    const reloaded = loadHostIdentity(identityPath)!;
    assert.equal(reloaded.eventCounter, 7);
    await assert.rejects(HostChannelCrypto.accept(reloaded, envelope, peer), /握手已被使用/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
