import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type sodiumType from "libsodium-wrappers-sumo";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo") as typeof sodiumType;

export type HostIdentity = {
  version: 2;
  relayUrl: string;
  hostName: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
  accountId?: string;
  hostId?: string;
  hostToken?: string;
  accountSigningPublicKey?: string;
  accountEncryptionPublicKey?: string;
  contentKey?: string;
  eventCounter: number;
  snapshotCounter: number;
  lastBridgeSeq: number;
  acceptedChannelIds?: Record<string, number>;
  pendingEvent?: { bridgeSeq: number; eventId: string; envelope: RelayCipherEnvelope };
  pendingSnapshot?: { envelope: RelayCipherEnvelope };
  _protectedSecrets?: string;
  _protectedSecretHash?: string;
};

export type RelayCipherEnvelope = {
  accountId: string;
  hostId: string;
  deviceId: string;
  channelId: string;
  counter: number;
  kind: "channel.open" | "channel.data" | "channel.close" | "snapshot.put" | "event.append";
  ciphertext: string;
  eventId?: string;
  eventType?: "attention" | "completed" | "status";
};

export type RelayPeer = { id: string; signingPublicKey: string; encryptionPublicKey: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CHANNEL_REPLAY_WINDOW_MS = 10 * 60 * 1000;
const MAX_CHANNEL_REPLAY_IDS = 2048;
const securedDirectories = new Set<string>();

const DPAPI_PROTECT = `
Add-Type -AssemblyName System.Security
$plain = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$entropy = [Text.Encoding]::UTF8.GetBytes('agent-pocket-host-identity-v2')
$sealed = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($sealed))
`;

const DPAPI_UNPROTECT = `
Add-Type -AssemblyName System.Security
$sealed = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$entropy = [Text.Encoding]::UTF8.GetBytes('agent-pocket-host-identity-v2')
$plain = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`;

const RESTRICT_DIRECTORY = `
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($current, 'FullControl', $inherit, $propagation, $allow)))
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, 'FullControl', $inherit, $propagation, $allow)))
Set-Acl -LiteralPath $path -AclObject $acl
[Console]::Out.Write('ok')
`;

function powershell(command: string, input: string, context: string) {
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`${context}失败`);
  return result.stdout.trim();
}

function protectSecrets(value: string) {
  return powershell(DPAPI_PROTECT, Buffer.from(value, "utf8").toString("base64"), "DPAPI 加密 Host 身份");
}

function unprotectSecrets(value: string) {
  const plain = powershell(DPAPI_UNPROTECT, value, "DPAPI 解密 Host 身份");
  return Buffer.from(plain, "base64").toString("utf8");
}

function restrictIdentityDirectory(path: string) {
  if (securedDirectories.has(path)) return;
  powershell(RESTRICT_DIRECTORY, Buffer.from(path, "utf8").toString("base64"), "收紧 Host 状态目录 ACL");
  securedDirectories.add(path);
}

function bytes(value: string) {
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function b64(value: Uint8Array) {
  return sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function deriveStreamKey(shared: Uint8Array, transcript: Uint8Array, direction: "device-to-host" | "host-to-device") {
  return sodium.crypto_generichash(32, new Uint8Array([...transcript, ...encoder.encode(`\0${direction}`)]), shared);
}

export function relayAad(envelope: Omit<RelayCipherEnvelope, "ciphertext">) {
  return encoder.encode(JSON.stringify([
    envelope.accountId,
    envelope.hostId,
    envelope.deviceId,
    envelope.channelId,
    envelope.counter,
    envelope.kind,
    envelope.eventId ?? null,
    envelope.eventType ?? null,
  ]));
}

export function relayHandshakeBytes(value: Record<string, unknown>) {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return encoder.encode(JSON.stringify(entries));
}

function rememberAcceptedChannel(identity: HostIdentity, channelId: string, at = Date.now()) {
  const accepted = identity.acceptedChannelIds && typeof identity.acceptedChannelIds === "object"
    ? identity.acceptedChannelIds
    : {};
  for (const [id, seenAt] of Object.entries(accepted)) {
    if (!Number.isSafeInteger(seenAt) || at - seenAt > CHANNEL_REPLAY_WINDOW_MS) delete accepted[id];
  }
  if (Object.hasOwn(accepted, channelId)) throw new Error("手机通道握手已被使用");
  if (Object.keys(accepted).length >= MAX_CHANNEL_REPLAY_IDS) throw new Error("手机通道重放保护记录已满");
  accepted[channelId] = at;
  identity.acceptedChannelIds = accepted;
}

export async function createHostIdentity(relayUrl: string, hostName: string): Promise<HostIdentity> {
  await sodium.ready;
  const signing = sodium.crypto_sign_keypair();
  const encryption = sodium.crypto_box_keypair();
  return {
    version: 2,
    relayUrl,
    hostName,
    signingPublicKey: b64(signing.publicKey),
    signingPrivateKey: b64(signing.privateKey),
    encryptionPublicKey: b64(encryption.publicKey),
    encryptionPrivateKey: b64(encryption.privateKey),
    eventCounter: -1,
    snapshotCounter: -1,
    lastBridgeSeq: 0,
  };
}

export function loadHostIdentity(path: string): HostIdentity | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as any;
    if (stored.version !== 2) throw new Error("Host 身份版本不兼容");
    if (stored.protection === "dpapi-current-user") {
      if (process.platform !== "win32" || typeof stored.protectedSecrets !== "string") throw new Error("Host 身份需要 Windows DPAPI");
      const secretText = unprotectSecrets(stored.protectedSecrets);
      const secrets = JSON.parse(secretText);
      const identity = { ...stored, ...secrets } as HostIdentity;
      delete (identity as any).protection;
      delete (identity as any).protectedSecrets;
      identity._protectedSecrets = stored.protectedSecrets;
      identity._protectedSecretHash = createHash("sha256").update(secretText).digest("hex");
      if (!identity.signingPrivateKey || !identity.encryptionPrivateKey) throw new Error("Host 身份缺少私钥");
      return identity;
    }
    if (!stored.signingPrivateKey || !stored.encryptionPrivateKey) throw new Error("Host 身份缺少私钥");
    return stored as HostIdentity;
  } catch (error) {
    throw new Error(`无法读取 Host 身份：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function saveHostIdentity(path: string, identity: HostIdentity) {
  if (process.platform !== "win32") throw new Error("Host 身份持久化仅支持 Windows DPAPI");
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  restrictIdentityDirectory(directory);
  const secrets = {
    signingPrivateKey: identity.signingPrivateKey,
    encryptionPrivateKey: identity.encryptionPrivateKey,
    hostToken: identity.hostToken,
    contentKey: identity.contentKey,
  };
  const secretText = JSON.stringify(secrets);
  const secretHash = createHash("sha256").update(secretText).digest("hex");
  const protectedSecrets = identity._protectedSecrets && identity._protectedSecretHash === secretHash
    ? identity._protectedSecrets
    : protectSecrets(secretText);
  identity._protectedSecrets = protectedSecrets;
  identity._protectedSecretHash = secretHash;
  const stored = {
    version: identity.version,
    protection: "dpapi-current-user",
    protectedSecrets,
    relayUrl: identity.relayUrl,
    hostName: identity.hostName,
    signingPublicKey: identity.signingPublicKey,
    encryptionPublicKey: identity.encryptionPublicKey,
    accountId: identity.accountId,
    hostId: identity.hostId,
    accountSigningPublicKey: identity.accountSigningPublicKey,
    accountEncryptionPublicKey: identity.accountEncryptionPublicKey,
    eventCounter: identity.eventCounter,
    snapshotCounter: identity.snapshotCounter,
    lastBridgeSeq: identity.lastBridgeSeq,
    acceptedChannelIds: identity.acceptedChannelIds,
    pendingEvent: identity.pendingEvent,
    pendingSnapshot: identity.pendingSnapshot,
  };
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export async function applyHostEnrollment(identity: HostIdentity, completed: any) {
  await sodium.ready;
  const plain = sodium.crypto_box_seal_open(
    bytes(String(completed.keyPackage)),
    bytes(identity.encryptionPublicKey),
    bytes(identity.encryptionPrivateKey),
  );
  if (!plain) throw new Error("手机下发的 Host 密钥包无法解密");
  const keyPackage = JSON.parse(decoder.decode(plain));
  const contentKey = String(keyPackage.contentKey || "");
  if (bytes(contentKey).length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
    throw new Error("Host 密钥包缺少有效内容密钥");
  }
  identity.accountId = String(completed.account.id);
  identity.hostId = String(completed.host.id);
  identity.hostToken = String(completed.hostToken);
  identity.accountSigningPublicKey = String(completed.account.signingPublicKey);
  identity.accountEncryptionPublicKey = String(completed.account.encryptionPublicKey);
  identity.contentKey = contentKey;
  return identity;
}

export async function encryptAccountPayload(
  identity: HostIdentity,
  metadata: Omit<RelayCipherEnvelope, "ciphertext">,
  value: unknown,
): Promise<RelayCipherEnvelope> {
  await sodium.ready;
  if (!identity.contentKey) throw new Error("Host 尚未获得账户内容密钥");
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    encoder.encode(JSON.stringify(value)),
    relayAad(metadata),
    null,
    nonce,
    bytes(identity.contentKey),
  );
  return { ...metadata, ciphertext: b64(new Uint8Array([...nonce, ...ciphertext])) };
}

export class HostChannelCrypto {
  private deviceCounter = 0;
  private hostCounter = 0;
  private pullState: unknown;
  private pushState: unknown;
  readonly identity: HostIdentity;
  readonly channelId: string;
  readonly peer: RelayPeer;

  private constructor(
    identity: HostIdentity,
    channelId: string,
    peer: RelayPeer,
  ) {
    this.identity = identity;
    this.channelId = channelId;
    this.peer = peer;
  }

  static async accept(identity: HostIdentity, envelope: RelayCipherEnvelope, peer: RelayPeer) {
    await sodium.ready;
    if (!identity.accountId || !identity.hostId || envelope.accountId !== identity.accountId || envelope.hostId !== identity.hostId
      || envelope.deviceId !== peer.id || envelope.kind !== "channel.open" || envelope.counter !== 0) {
      throw new Error("通道握手身份不匹配");
    }
    const sealed = sodium.crypto_box_seal_open(
      bytes(envelope.ciphertext),
      bytes(identity.encryptionPublicKey),
      bytes(identity.encryptionPrivateKey),
    );
    if (!sealed) throw new Error("通道握手无法解密");
    const open = JSON.parse(decoder.decode(sealed)) as Record<string, unknown>;
    const signature = String(open.signature || "");
    const unsigned = { ...open };
    delete unsigned.signature;
    const issuedAt = Number(open.issuedAt);
    if (open.version !== 2 || open.accountId !== identity.accountId || open.hostId !== identity.hostId
      || open.deviceId !== peer.id || open.channelId !== envelope.channelId
      || !Number.isSafeInteger(issuedAt) || Math.abs(Date.now() - issuedAt) > 5 * 60 * 1000
      || !sodium.crypto_sign_verify_detached(bytes(signature), relayHandshakeBytes(unsigned), bytes(peer.signingPublicKey))) {
      throw new Error("手机通道签名无效或已过期");
    }
    const deviceEphemeralPublicKey = bytes(String(open.ephemeralPublicKey));
    const deviceHeader = bytes(String(open.secretstreamHeader));
    if (deviceEphemeralPublicKey.length !== sodium.crypto_box_PUBLICKEYBYTES
      || deviceHeader.length !== sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES) {
      throw new Error("手机通道握手密钥材料无效");
    }
    rememberAcceptedChannel(identity, envelope.channelId);
    const hostEphemeral = sodium.crypto_box_keypair();
    const deviceShared = sodium.crypto_scalarmult(bytes(identity.encryptionPrivateKey), deviceEphemeralPublicKey);
    const hostShared = sodium.crypto_scalarmult(hostEphemeral.privateKey, bytes(peer.encryptionPublicKey));
    const transcript = encoder.encode(`agent-pocket-relay-v2\0${identity.accountId}\0${identity.hostId}\0${peer.id}\0${envelope.channelId}`);
    const deviceToHost = deriveStreamKey(deviceShared, transcript, "device-to-host");
    const hostToDevice = deriveStreamKey(hostShared, transcript, "host-to-device");
    const channel = new HostChannelCrypto(identity, envelope.channelId, peer);
    channel.pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(deviceHeader, deviceToHost);
    const push = sodium.crypto_secretstream_xchacha20poly1305_init_push(hostToDevice);
    channel.pushState = push.state;
    const responseUnsigned = {
      version: 2,
      accountId: identity.accountId,
      hostId: identity.hostId,
      deviceId: peer.id,
      channelId: envelope.channelId,
      issuedAt: Date.now(),
      deviceEphemeralPublicKey: String(open.ephemeralPublicKey),
      ephemeralPublicKey: b64(hostEphemeral.publicKey),
      secretstreamHeader: b64(push.header),
    };
    const response = {
      ...responseUnsigned,
      signature: b64(sodium.crypto_sign_detached(relayHandshakeBytes(responseUnsigned), bytes(identity.signingPrivateKey))),
    };
    const responseCiphertext = sodium.crypto_box_seal(encoder.encode(JSON.stringify(response)), bytes(peer.encryptionPublicKey));
    sodium.memzero(deviceShared);
    sodium.memzero(hostShared);
    sodium.memzero(deviceToHost);
    sodium.memzero(hostToDevice);
    return {
      channel,
      response: {
        accountId: identity.accountId,
        hostId: identity.hostId,
        deviceId: peer.id,
        channelId: envelope.channelId,
        counter: 0,
        kind: "channel.open" as const,
        ciphertext: b64(responseCiphertext),
      },
    };
  }

  decrypt(envelope: RelayCipherEnvelope, final = false) {
    const expectedKind = final ? "channel.close" : "channel.data";
    if (envelope.channelId !== this.channelId || envelope.accountId !== this.identity.accountId
      || envelope.hostId !== this.identity.hostId || envelope.deviceId !== this.peer.id
      || envelope.kind !== expectedKind || envelope.counter !== this.deviceCounter + 1) {
      throw new Error("手机通道消息重复、乱序或身份不匹配");
    }
    const { ciphertext, ...metadata } = envelope;
    const opened = sodium.crypto_secretstream_xchacha20poly1305_pull(
      this.pullState,
      bytes(ciphertext),
      relayAad(metadata),
    );
    const expectedTag = final
      ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    if (!opened || opened.tag !== expectedTag) {
      throw new Error("手机通道消息认证失败");
    }
    this.deviceCounter = envelope.counter;
    return decoder.decode(opened.message);
  }

  encrypt(value: string, final = false): RelayCipherEnvelope {
    const counter = this.hostCounter + 1;
    const metadata = {
      accountId: this.identity.accountId!,
      hostId: this.identity.hostId!,
      deviceId: this.peer.id,
      channelId: this.channelId,
      counter,
      kind: (final ? "channel.close" : "channel.data") as "channel.data" | "channel.close",
    };
    const ciphertext = sodium.crypto_secretstream_xchacha20poly1305_push(
      this.pushState,
      encoder.encode(value),
      relayAad(metadata),
      final ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    );
    this.hostCounter = counter;
    return { ...metadata, ciphertext: b64(ciphertext) };
  }
}
