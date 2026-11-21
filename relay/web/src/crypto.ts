import sodium from "libsodium-wrappers-sumo";

export type DeviceKeys = { signingPublicKey: string; signingPrivateKey: string; encryptionPublicKey: string; encryptionPrivateKey: string };
export type AccountPackage = { version: 1; signingPublicKey: string; signingPrivateKey: string; encryptionPublicKey: string; encryptionPrivateKey: string; contentKey: string };
export type WebPackage = { version: 1; algorithm: "argon2id+xchacha20poly1305"; salt: string; nonce: string; kdf: { opsLimit: number; memLimit: number; algorithm: number }; ciphertext: string; accountPublicKeyFingerprint: string };
export type Envelope = { accountId: string; hostId: string; deviceId: string; channelId: string; counter: number; kind: "channel.open"|"channel.data"|"channel.close"; ciphertext: string; eventId?: string; eventType?: string };
export const MAX_RELAY_FRAME_BYTES = 2 * 1024 * 1024;

const b64 = (v: Uint8Array) => sodium.to_base64(v, sodium.base64_variants.URLSAFE_NO_PADDING);
const bytes = (v: string) => sodium.from_base64(v, sodium.base64_variants.URLSAFE_NO_PADDING);
const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (v: unknown) => enc.encode(JSON.stringify(v));
let kdfWorker: Worker | undefined;
let kdfSequence = 1;
const kdfPending = new Map<number, { resolve: (value: Uint8Array) => void; reject: (error: Error) => void }>();
function workerKdf(password: string, salt: Uint8Array, kdf: { opsLimit: number; memLimit: number; algorithm: number }) {
  if (typeof Worker === "undefined") return undefined;
  if (!kdfWorker) {
    try {
      kdfWorker = new Worker(new URL("./crypto-worker.ts", import.meta.url), { type: "module" });
      kdfWorker.onmessage = (event: MessageEvent<{ id: number; result?: number[]; error?: string }>) => {
        const pending = kdfPending.get(event.data.id);
        if (!pending) return;
        kdfPending.delete(event.data.id);
        if (event.data.error || !event.data.result) pending.reject(new Error(event.data.error || "密码派生失败"));
        else pending.resolve(new Uint8Array(event.data.result));
      };
      kdfWorker.onerror = (event) => {
        for (const pending of kdfPending.values()) pending.reject(new Error(event.message || "密码派生 Worker 失败"));
        kdfPending.clear();
        kdfWorker?.terminate();
        kdfWorker = undefined;
      };
    } catch {
      kdfWorker = undefined;
      return undefined;
    }
  }
  const id = kdfSequence++;
  return new Promise<Uint8Array>((resolve, reject) => {
    kdfPending.set(id, { resolve, reject });
    kdfWorker!.postMessage({ id, password, salt: Array.from(salt), ...kdf });
  });
}
function base64UrlLength(bytesLength: number) {
  const padded = Math.ceil(bytesLength / 3) * 4;
  return padded - ((3 - (bytesLength % 3)) % 3);
}

export async function ready() { await sodium.ready; }
export function generateDeviceKeys(): DeviceKeys { const s=sodium.crypto_sign_keypair(); const e=sodium.crypto_box_keypair(); return { signingPublicKey:b64(s.publicKey), signingPrivateKey:b64(s.privateKey), encryptionPublicKey:b64(e.publicKey), encryptionPrivateKey:b64(e.privateKey) }; }
export async function createWebRegistration(password: string, recoveryPublicKey: string, device: DeviceKeys) {
  await ready();
  const pkg: AccountPackage = { version: 1, ...generateDeviceKeys(), contentKey: b64(sodium.randombytes_buf(32)) };
  const plain = json(pkg);
  try {
    return { pkg, payload: { accountSigningPublicKey: pkg.signingPublicKey, accountEncryptionPublicKey: pkg.encryptionPublicKey,
      escrowCiphertext: b64(sodium.crypto_box_seal(plain, bytes(recoveryPublicKey))),
      sealedDevicePackage: b64(sodium.crypto_box_seal(plain, bytes(device.encryptionPublicKey))),
      packageJson: await sealAccountPackage(password, pkg) } };
  } finally { sodium.memzero(plain); }
}
export async function activationProof(pkg: AccountPackage, device: DeviceKeys, challenge: { signingMessage: string; deviceBoxChallenge: string; accountBoxChallenge: string }) {
  await ready();
  const deviceResponse = sodium.crypto_box_seal_open(bytes(challenge.deviceBoxChallenge), bytes(device.encryptionPublicKey), bytes(device.encryptionPrivateKey));
  const accountResponse = sodium.crypto_box_seal_open(bytes(challenge.accountBoxChallenge), bytes(pkg.encryptionPublicKey), bytes(pkg.encryptionPrivateKey));
  if (!deviceResponse || !accountResponse) throw new Error("首次激活密钥证明失败");
  try { return { deviceSignature: b64(sodium.crypto_sign_detached(enc.encode(challenge.signingMessage), bytes(device.signingPrivateKey))),
    accountSignature: b64(sodium.crypto_sign_detached(enc.encode(challenge.signingMessage), bytes(pkg.signingPrivateKey))),
    deviceBoxResponse: b64(deviceResponse), accountBoxResponse: b64(accountResponse) }; }
  finally { sodium.memzero(deviceResponse); sodium.memzero(accountResponse); }
}
export async function sealHostContentKey(contentKey: string, hostPublicKey: string) {
  await ready(); return b64(sodium.crypto_box_seal(json({ version: 1, contentKey }), bytes(hostPublicKey)));
}
export function packagePublicFingerprint(pkg: AccountPackage) { return b64(sodium.crypto_generichash(16, enc.encode(`${pkg.signingPublicKey}:${pkg.encryptionPublicKey}`), null)); }
export async function derivePasswordKey(password: string, salt: Uint8Array, kdf: { opsLimit: number; memLimit: number; algorithm: number }) {
  const worker = workerKdf(password, salt, kdf);
  if (worker) return worker;
  await ready();
  return sodium.crypto_pwhash(32, password, salt, kdf.opsLimit, kdf.memLimit, kdf.algorithm);
}
export async function sealAccountPackage(password: string, pkg: AccountPackage): Promise<string> {
  await ready();
  const salt=sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES); const nonce=sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const kdf={opsLimit:sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,memLimit:sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,algorithm:sodium.crypto_pwhash_ALG_ARGON2ID13};
  const key=await derivePasswordKey(password,salt,kdf); const ciphertext=sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(json(pkg),enc.encode("agent-pocket-web-key-package-v1"),null,nonce,key); sodium.memzero(key);
  return JSON.stringify({version:1,algorithm:"argon2id+xchacha20poly1305",salt:b64(salt),nonce:b64(nonce),kdf,ciphertext:b64(ciphertext),accountPublicKeyFingerprint:packagePublicFingerprint(pkg)} satisfies WebPackage);
}
export async function openAccountPackage(password: string, text: string, account?: { id?: string; signingPublicKey?: string; encryptionPublicKey?: string }): Promise<AccountPackage> {
  await ready(); const item=JSON.parse(text) as WebPackage; if(item.version!==1||item.algorithm!=="argon2id+xchacha20poly1305") throw new Error("网页密钥包版本不支持");
  const key=await derivePasswordKey(password,bytes(item.salt),item.kdf); const plain=sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,bytes(item.ciphertext),enc.encode("agent-pocket-web-key-package-v1"),bytes(item.nonce),key); sodium.memzero(key); if(!plain) throw new Error("密码无法解开网页密钥包");
  const pkg=JSON.parse(dec.decode(plain)) as AccountPackage; if(pkg.version!==1||packagePublicFingerprint(pkg)!==item.accountPublicKeyFingerprint) throw new Error("网页密钥包账户指纹不匹配"); validateAccountPackage(pkg, account); return pkg;
}
export function validateAccountPackage(pkg: AccountPackage, account?: { signingPublicKey?: string; encryptionPublicKey?: string }) {
  if (pkg.version !== 1 || bytes(pkg.contentKey).length !== 32
    || b64(sodium.crypto_sign_ed25519_sk_to_pk(bytes(pkg.signingPrivateKey))) !== pkg.signingPublicKey
    || b64(sodium.crypto_scalarmult_base(bytes(pkg.encryptionPrivateKey))) !== pkg.encryptionPublicKey
    || (account && (pkg.signingPublicKey !== account.signingPublicKey || pkg.encryptionPublicKey !== account.encryptionPublicKey))) {
    throw new Error("账户密钥包校验失败");
  }
}
export async function openDeviceAccountPackage(keys: DeviceKeys, sealed: string, account: { signingPublicKey: string; encryptionPublicKey: string }) {
  await ready();
  const plain = sodium.crypto_box_seal_open(bytes(sealed), bytes(keys.encryptionPublicKey), bytes(keys.encryptionPrivateKey));
  if (!plain) throw new Error("无法解开手机提供的账户密钥包");
  try { const pkg = JSON.parse(dec.decode(plain)) as AccountPackage; validateAccountPackage(pkg, account); return pkg; }
  finally { sodium.memzero(plain); }
}
export async function deviceProof(keys: DeviceKeys, challenge: { signingMessage: string; boxChallenge: string }) { await ready(); const signature=sodium.crypto_sign_detached(enc.encode(challenge.signingMessage),bytes(keys.signingPrivateKey)); const plain=sodium.crypto_box_seal_open(bytes(challenge.boxChallenge),bytes(keys.encryptionPublicKey),bytes(keys.encryptionPrivateKey)); if(!plain) throw new Error("无法解开设备证明挑战"); return {signature:b64(signature),boxResponse:b64(plain)}; }

export function relayAad(e: Omit<Envelope,"ciphertext">) { return enc.encode(JSON.stringify([e.accountId,e.hostId,e.deviceId,e.channelId,e.counter,e.kind,e.eventId??null,e.eventType??null])); }
export function handshakeBytes(value: Record<string, unknown>) { return enc.encode(JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)))); }
function derive(shared: Uint8Array, transcript: Uint8Array, direction: string) { return sodium.crypto_generichash(32,new Uint8Array([...transcript,...enc.encode(`\0${direction}`)]),shared); }
export class DeviceChannel {
  private pull: any; private push: any; private deviceCounter=0; private hostCounter=0;
  private constructor(readonly accountId:string,readonly hostId:string,readonly deviceId:string,readonly channelId:string) {}
  static async open(keys:DeviceKeys, accountId:string, host:any, send:(method:string,params:any)=>Promise<any>, subscribe:(onData:(value:any)=>void,onError:(error:Error)=>void)=>()=>void) {
    await ready(); const channelId=crypto.randomUUID(); const deviceId=host.deviceId??""; const eph=sodium.crypto_box_keypair();
    const transcript=enc.encode(`agent-pocket-relay-v2\0${accountId}\0${host.id}\0${deviceId}\0${channelId}`);
    const deviceShared=sodium.crypto_scalarmult(eph.privateKey,bytes(host.encryptionPublicKey));
    const deviceToHost=derive(deviceShared,transcript,"device-to-host");
    const stream=sodium.crypto_secretstream_xchacha20poly1305_init_push(deviceToHost);
    sodium.memzero(deviceShared); sodium.memzero(deviceToHost);
    const unsigned={version:2,accountId,hostId:host.id,deviceId,channelId,issuedAt:Date.now(),ephemeralPublicKey:b64(eph.publicKey),secretstreamHeader:b64(stream.header)}; const signed={...unsigned,signature:b64(sodium.crypto_sign_detached(handshakeBytes(unsigned),bytes(keys.signingPrivateKey)))}; const sealed=sodium.crypto_box_seal(json(signed),bytes(host.encryptionPublicKey));
    const env:Envelope={accountId,hostId:host.id,deviceId,channelId,counter:0,kind:"channel.open",ciphertext:b64(sealed)};
    let off = () => {}; let timer: ReturnType<typeof setTimeout> | undefined; let settled = false;
    let openedChannel: DeviceChannel | undefined;
    const responsePromise = new Promise<DeviceChannel>((resolve, reject) => {
      const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
      timer = setTimeout(() => fail(new Error("Host 通道握手超时")), 30000);
      // Subscribe before sending: the real Host may reply before Relay's ACK.
      off = subscribe((response) => {
        if (settled || response?.channelId !== channelId) return;
        try {
          if (response.accountId !== accountId || response.hostId !== host.id || response.deviceId !== deviceId
            || response.kind !== "channel.open" || response.counter !== 0) throw new Error("Host 握手身份不匹配");
          const opened = sodium.crypto_box_seal_open(bytes(response.ciphertext), bytes(keys.encryptionPublicKey), bytes(keys.encryptionPrivateKey));
          if (!opened) throw new Error("Host 握手无法解密");
          const value = JSON.parse(dec.decode(opened)); const unsignedHost = { ...value }; delete unsignedHost.signature;
          if (value.version !== 2 || value.accountId !== accountId || value.hostId !== host.id || value.deviceId !== deviceId
            || value.channelId !== channelId || value.deviceEphemeralPublicKey !== unsigned.ephemeralPublicKey
            || !Number.isSafeInteger(value.issuedAt) || Math.abs(Date.now() - value.issuedAt) > 300_000
            || !sodium.crypto_sign_verify_detached(bytes(value.signature), handshakeBytes(unsignedHost), bytes(host.signingPublicKey))) throw new Error("Host 握手签名无效或已过期");
          const hostShared = sodium.crypto_scalarmult(bytes(keys.encryptionPrivateKey), bytes(value.ephemeralPublicKey));
          const h2d = derive(hostShared, transcript, "host-to-device");
          try {
            const c = new DeviceChannel(accountId, host.id, deviceId, channelId);
            c.pull = sodium.crypto_secretstream_xchacha20poly1305_init_pull(bytes(value.secretstreamHeader), h2d);
            c.push = stream.state; openedChannel = c; settled = true; resolve(c);
          } finally { sodium.memzero(hostShared); sodium.memzero(h2d); }
        } catch (error) { fail(error instanceof Error ? error : new Error("Host 握手失败")); }
      }, fail);
    });
    try { return (await Promise.all([Promise.resolve().then(() => send("channel/open", { envelope: env })), responsePromise]))[1]; }
    catch (error) { openedChannel?.destroy(); throw error; }
    finally { settled = true; clearTimeout(timer); off(); sodium.memzero(eph.privateKey); }
  }
  estimateFrameBytes(value: string, rpcId: number) {
    const metadata: Omit<Envelope, "ciphertext"> = {
      accountId: this.accountId,
      hostId: this.hostId,
      deviceId: this.deviceId,
      channelId: this.channelId,
      counter: this.deviceCounter + 1,
      kind: "channel.data",
    };
    const ciphertext = "A".repeat(base64UrlLength(enc.encode(value).byteLength + sodium.crypto_secretstream_xchacha20poly1305_ABYTES));
    const frame = JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "channel/data", params: { envelope: { ...metadata, ciphertext } } });
    return enc.encode(frame).byteLength;
  }
  encrypt(value:string):Envelope { const metadata:Omit<Envelope,"ciphertext">={accountId:this.accountId,hostId:this.hostId,deviceId:this.deviceId,channelId:this.channelId,counter:++this.deviceCounter,kind:"channel.data"}; const ciphertext=sodium.crypto_secretstream_xchacha20poly1305_push(this.push,enc.encode(value),relayAad(metadata),sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE); return {...metadata,ciphertext:b64(ciphertext)}; }
  decrypt(envelope:Envelope) { const {ciphertext,...metadata}=envelope; if(envelope.accountId!==this.accountId||envelope.hostId!==this.hostId||envelope.deviceId!==this.deviceId||envelope.channelId!==this.channelId||envelope.kind!=="channel.data"||envelope.counter!==this.hostCounter+1) throw new Error("Host 通道消息乱序或身份不匹配"); const opened=sodium.crypto_secretstream_xchacha20poly1305_pull(this.pull,bytes(ciphertext),relayAad(metadata)); if(!opened||opened.tag!==sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE) throw new Error("Host 通道消息认证失败"); this.hostCounter=envelope.counter; return JSON.parse(dec.decode(opened.message)); }
  destroy() { this.pull=undefined; this.push=undefined; }
}
export function decryptAccountEnvelope(contentKey:string,envelope:any) { const {ciphertext,...metadata}=envelope; const raw=bytes(ciphertext); const plain=sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,raw.slice(24),relayAad(metadata),raw.slice(0,24),bytes(contentKey)); if(!plain) throw new Error("账户数据认证失败"); return JSON.parse(dec.decode(plain)); }
export async function attachmentPayload(file: File) { const data=new Uint8Array(await file.arrayBuffer()); return {filename:file.name,mimeType:file.type||"application/octet-stream",data:sodium.to_base64(data,sodium.base64_variants.ORIGINAL),rawBytes:data.byteLength}; }
export function validateAttachmentBudget(items:Array<{mimeType:string;rawBytes:number}>, finalJsonBytes=0) { if(items.length>3)throw new Error("每次最多包含 3 个附件");let total=0;for(const item of items){if(item.mimeType.startsWith("image/")){if(!["image/jpeg","image/png","image/webp"].includes(item.mimeType)||item.rawBytes>450*1024)throw new Error("图片必须是 JPEG、PNG 或 WebP，且不超过 450 KiB");}else if(item.rawBytes>512*1024)throw new Error("单个文件不能超过 512 KiB");total+=item.rawBytes;}if(total>800*1024)throw new Error("附件总量不能超过 800 KiB");
  // When supplied, finalJsonBytes is already the complete encrypted Relay
  // frame estimate. The channel performs the exact same check immediately
  // before encrypting, so a rejected frame never advances its counter.
  if(finalJsonBytes>MAX_RELAY_FRAME_BYTES)throw new Error("加密信封超过 Relay 单帧大小");return true; }
export { b64, bytes };
