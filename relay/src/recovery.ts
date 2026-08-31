import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import sodium from "libsodium-wrappers-sumo";

type RecoveryFile = {
  version: number;
  algorithm: string;
  publicKey: string;
  salt: string;
  nonce: string;
  opsLimit: number;
  memLimit: number;
  ciphertext: string;
};

type RecoveryBundle = {
  accountId: string;
  username: string;
  accountSigningPublicKey: string;
  accountEncryptionPublicKey: string;
  escrowCiphertext: string;
  recoveryPublicKey: string;
  deviceId: string;
  deviceName: string;
  deviceEncryptionPublicKey: string;
};

const b64 = (value: string) => sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
const toB64 = (value: Uint8Array) => sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);

class MutedOutput extends Writable {
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { callback(); }
}

async function prompt(label: string, secret = false) {
  process.stdout.write(label);
  const output = secret ? new MutedOutput() : process.stdout;
  const lines = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  try {
    const value = await lines.question("");
    if (secret) process.stdout.write("\n");
    return value.trim();
  } finally {
    lines.close();
  }
}

function endpoint(value: string) {
  const parsed = new URL(value);
  const local = ["127.0.0.1", "localhost"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("Relay 地址必须使用 HTTPS；仅本机测试可用 HTTP");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.href.replace(/\/$/, "");
}

async function responseJson(response: Response) {
  const value = await response.json() as any;
  if (!response.ok) throw new Error(value?.error?.message || `Relay 请求失败 (${response.status})`);
  return value;
}

function cookieHeader(response: Response) {
  const values = (response.headers as any).getSetCookie?.() as string[] | undefined;
  const source = values?.length ? values : [response.headers.get("set-cookie") || ""];
  const cookie = source.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
  if (!cookie.includes("ap_access=")) throw new Error("管理员登录未返回安全会话 Cookie");
  return cookie;
}

function validateRecoveryFile(value: unknown): RecoveryFile {
  if (!value || typeof value !== "object") throw new Error("恢复文件格式无效");
  const item = value as Record<string, unknown>;
  const result = item as unknown as RecoveryFile;
  if (result.version !== 1 || result.algorithm !== "argon2id+xchacha20poly1305") throw new Error("不支持的恢复文件版本");
  if (![result.publicKey, result.salt, result.nonce, result.ciphertext].every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error("恢复文件缺少加密字段");
  }
  if (!Number.isInteger(result.opsLimit) || !Number.isInteger(result.memLimit)
    || result.opsLimit < sodium.crypto_pwhash_OPSLIMIT_MIN || result.opsLimit > sodium.crypto_pwhash_OPSLIMIT_SENSITIVE
    || result.memLimit < sodium.crypto_pwhash_MEMLIMIT_MIN || result.memLimit > sodium.crypto_pwhash_MEMLIMIT_SENSITIVE) {
    throw new Error("恢复文件的 Argon2 参数超出允许范围");
  }
  return result;
}

export async function recoverDevice(argv: string[]) {
  if (argv.length < 4) {
    throw new Error("用法: recover-device <relay-url> <account-id> <device-id> <recovery-file>");
  }
  await sodium.ready;
  const [relayValue, accountId, deviceId, recoveryPath] = argv;
  const relay = endpoint(relayValue);
  const username = process.env.AGENT_POCKET_ADMIN_USERNAME || await prompt("管理员用户名：");
  const password = process.env.AGENT_POCKET_ADMIN_PASSWORD || await prompt("管理员密码：", true);
  const recoveryPassphrase = process.env.AGENT_POCKET_RECOVERY_PASSPHRASE || await prompt("离线恢复口令：", true);
  if (!username || !password || !recoveryPassphrase) throw new Error("管理员凭据和恢复口令不能为空");

  const loginResponse = await fetch(`${relay}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const login = await responseJson(loginResponse);
  const cookies = cookieHeader(loginResponse);
  const csrf = String(login.csrf || "");
  if (!csrf) throw new Error("管理员登录未返回 CSRF token");

  const recoveryResponse = await fetch(`${relay}/api/admin/users/${encodeURIComponent(accountId)}/devices/${encodeURIComponent(deviceId)}/recovery`, {
    headers: { cookie: cookies },
  });
  const bundle = await responseJson(recoveryResponse) as RecoveryBundle;
  if (bundle.accountId !== accountId || bundle.deviceId !== deviceId) throw new Error("Relay 返回的恢复目标不匹配");

  const file = validateRecoveryFile(JSON.parse(await readFile(recoveryPath, "utf8")));
  const publicKey = b64(file.publicKey);
  const recoveryKey = sodium.crypto_pwhash(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    recoveryPassphrase,
    b64(file.salt),
    file.opsLimit,
    file.memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  let recoveryPrivateKey: Uint8Array | undefined;
  let privatePayload: Uint8Array | undefined;
  let accountPackage: Uint8Array | undefined;
  try {
    privatePayload = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      b64(file.ciphertext),
      publicKey,
      b64(file.nonce),
      recoveryKey,
    );
    const privateMaterial = JSON.parse(sodium.to_string(privatePayload)) as Record<string, string>;
    recoveryPrivateKey = b64(privateMaterial.recoveryPrivateKey);
    if (!sodium.memcmp(sodium.crypto_scalarmult_base(recoveryPrivateKey), publicKey)
      || file.publicKey !== bundle.recoveryPublicKey) {
      throw new Error("恢复文件与此 Relay 不匹配");
    }
    accountPackage = sodium.crypto_box_seal_open(b64(bundle.escrowCiphertext), publicKey, recoveryPrivateKey);
    const account = JSON.parse(sodium.to_string(accountPackage)) as Record<string, string | number>;
    if (account.version !== 1
      || account.signingPublicKey !== bundle.accountSigningPublicKey
      || account.encryptionPublicKey !== bundle.accountEncryptionPublicKey
      || account.contentKey !== privateMaterial.contentKey) {
      throw new Error("账户密钥包校验失败");
    }
    const keyPackage = toB64(sodium.crypto_box_seal(accountPackage, b64(bundle.deviceEncryptionPublicKey)));
    const complete = await fetch(`${relay}/api/admin/users/${encodeURIComponent(accountId)}/devices/${encodeURIComponent(deviceId)}/recovery`, {
      method: "POST",
      headers: { cookie: cookies, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ keyPackage }),
    });
    await responseJson(complete);
    console.log(`设备恢复完成：${bundle.deviceName} (${bundle.deviceId})`);
  } finally {
    sodium.memzero(recoveryKey);
    if (recoveryPrivateKey) sodium.memzero(recoveryPrivateKey);
    if (privatePayload) sodium.memzero(privatePayload);
    if (accountPackage) sodium.memzero(accountPackage);
  }
}
