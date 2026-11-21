import { createHash } from "node:crypto";
import sodium from "libsodium-wrappers-sumo";
import { verifyPassword } from "./auth.js";
import { LoginThrottle } from "./rate-limit.js";
import { MAX_KEY_PACKAGE_CHARS, normalizeUsername, RelayError, requiredString, token, tokenHash } from "./protocol.js";
import type { RelayStore } from "./store.js";

const DOMAIN = "agent-pocket-web-activation-v1\n";
const digest = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const b64 = (value: Uint8Array) => sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
function decode(value: unknown, name: string, size?: number) {
  const text = requiredString(value, name, MAX_KEY_PACKAGE_CHARS);
  try { if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error(); const decoded = sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING);
    if (size !== undefined && decoded.length !== size) throw new Error(); return decoded;
  } catch { throw new RelayError("INVALID_REQUEST", `${name} 格式或长度无效`); }
}

/** Uses existing v3 login/receipt tables; never grants an authenticated session. */
export class WebActivationService {
  private readonly throttle: LoginThrottle;
  constructor(private readonly store: RelayStore, private readonly origin: string, private readonly validatePackage: (value: unknown) => string) {
    this.throttle = new LoginThrottle({ persistent: store, freeFailures: 5 });
  }
  private material(body: Record<string, unknown>) {
    const result = { deviceName: requiredString(body.deviceName, "deviceName", 80),
      accountSigningPublicKey: requiredString(body.accountSigningPublicKey, "accountSigningPublicKey", 128),
      accountEncryptionPublicKey: requiredString(body.accountEncryptionPublicKey, "accountEncryptionPublicKey", 128),
      deviceSigningPublicKey: requiredString(body.deviceSigningPublicKey, "deviceSigningPublicKey", 128),
      deviceEncryptionPublicKey: requiredString(body.deviceEncryptionPublicKey, "deviceEncryptionPublicKey", 128),
      escrowCiphertext: requiredString(body.escrowCiphertext, "escrowCiphertext", MAX_KEY_PACKAGE_CHARS),
      sealedDevicePackage: requiredString(body.sealedDevicePackage, "sealedDevicePackage", MAX_KEY_PACKAGE_CHARS),
      packageJson: this.validatePackage(body.packageJson) };
    for (const field of ["accountSigningPublicKey", "accountEncryptionPublicKey", "deviceSigningPublicKey", "deviceEncryptionPublicKey"] as const) decode(result[field], field, 32);
    for (const field of ["escrowCiphertext", "sealedDevicePackage"] as const) if (decode(result[field], field).length < 48) throw new RelayError("INVALID_REQUEST", "密封密钥包过短");
    const packageValue = JSON.parse(result.packageJson);
    const fingerprint = b64(sodium.crypto_generichash(16, Buffer.from(`${result.accountSigningPublicKey}:${result.accountEncryptionPublicKey}`), null));
    if (packageValue.accountPublicKeyFingerprint !== fingerprint) throw new RelayError("INVALID_REQUEST", "网页密钥包与账户公钥不一致");
    return result;
  }
  async start(body: Record<string, unknown>, source: string) {
    await sodium.ready;
    const username = normalizeUsername(body.username); const sourceKey = `web-activation-source:${source}`;
    const accountKey = `web-activation-account:${username}`;
    this.throttle.assertAllowed(sourceKey); this.throttle.assertAllowed(accountKey);
    const provision = this.store.accountProvisionByUsername(username);
    if (!provision || !await verifyPassword(String(body.password || ""), provision.password_hash)) {
      const retryAfterMs = Math.max(this.throttle.failed(sourceKey), this.throttle.failed(accountKey));
      throw new RelayError(retryAfterMs ? "RATE_LIMITED" : "AUTH_FAILED", "用户名或密码错误", retryAfterMs ? { retryAfterMs } : undefined);
    }
    if (this.store.meta(`webActivationMode:${provision.id}`) !== "web-only") throw new RelayError("FORBIDDEN", "此账号尚未启用网页首次开通，请联系管理员");
    const operationId = requiredString(body.operationId, "operationId", 128); const material = this.material(body);
    const expiresAt = Date.now() + 5 * 60_000; const activationToken = token();
    const signingMessage = DOMAIN + JSON.stringify({ origin: this.origin, accountId: provision.id, operationId, expiresAt,
      verifierDigest: digest(provision.password_hash), materialDigest: digest(material),
      accountSigningPublicKey: material.accountSigningPublicKey, accountEncryptionPublicKey: material.accountEncryptionPublicKey,
      deviceSigningPublicKey: material.deviceSigningPublicKey, deviceEncryptionPublicKey: material.deviceEncryptionPublicKey });
    const deviceNonce = sodium.randombytes_buf(32), accountNonce = sodium.randombytes_buf(32);
    let deviceBoxChallenge: string, accountBoxChallenge: string;
    try {
      deviceBoxChallenge = b64(sodium.crypto_box_seal(deviceNonce, decode(material.deviceEncryptionPublicKey, "deviceEncryptionPublicKey", 32)));
      accountBoxChallenge = b64(sodium.crypto_box_seal(accountNonce, decode(material.accountEncryptionPublicKey, "accountEncryptionPublicKey", 32)));
    } catch { throw new RelayError("INVALID_REQUEST", "首次激活加密公钥无效"); }
    this.store.transaction(() => {
      const current = this.store.accountProvisionById(provision.id);
      if (!current || current.password_hash !== provision.password_hash || this.store.accountById(provision.id)) throw new RelayError("VERSION_CONFLICT", "账号已变化，请重新登录");
      this.store.db.prepare("DELETE FROM web_logins WHERE expires_at<?").run(Date.now());
      const count = this.store.db.prepare("SELECT count(*) AS n FROM web_logins WHERE signing_challenge LIKE ?").get(`${DOMAIN}%`) as any;
      const own = this.store.db.prepare("SELECT count(*) AS n FROM web_logins WHERE account_id=? AND signing_challenge LIKE ?").get(provision.id, `${DOMAIN}%`) as any;
      if (Number(count.n) >= 1000 || Number(own.n) >= 3) throw new RelayError("RATE_LIMITED", "激活请求过多，请等待旧请求过期", { retryAfterMs: 5 * 60_000 });
      this.store.db.prepare(`INSERT INTO web_logins(token_hash,account_id,expires_at,credential_version,totp_version,verified,proof,signing_challenge,box_nonce)
        VALUES(?,?,?,0,0,0,0,?,?)`).run(tokenHash(activationToken), provision.id, expiresAt, signingMessage, JSON.stringify([b64(deviceNonce), b64(accountNonce)]));
    });
    this.throttle.succeeded(sourceKey); this.throttle.succeeded(accountKey);
    return { state: "account_activation_required", accountId: provision.id, operationId, activationToken, expiresAt,
      challenge: { signingMessage, deviceBoxChallenge, accountBoxChallenge } };
  }
  async complete(body: Record<string, unknown>, source: string) {
    await sodium.ready;
    const activationToken = requiredString(body.activationToken, "activationToken", 256);
    const accountId = requiredString(body.accountId, "accountId", 64); const operationId = requiredString(body.operationId, "operationId", 128);
    const material = this.material(body);
    const proof = { deviceSignature: requiredString(body.deviceSignature, "deviceSignature", 128), accountSignature: requiredString(body.accountSignature, "accountSignature", 128),
      deviceBoxResponse: requiredString(body.deviceBoxResponse, "deviceBoxResponse", 128), accountBoxResponse: requiredString(body.accountBoxResponse, "accountBoxResponse", 128) };
    const deviceSignature = decode(proof.deviceSignature, "deviceSignature", 64), accountSignature = decode(proof.accountSignature, "accountSignature", 64);
    const deviceResponse = decode(proof.deviceBoxResponse, "deviceBoxResponse", 32), accountResponse = decode(proof.accountBoxResponse, "accountBoxResponse", 32);
    const fingerprint = digest({ accountId, operationId, tokenHash: tokenHash(activationToken), material, proof });
    const receiptId = `web-activate:${operationId}`;
    const prior = this.store.webOperation(accountId, receiptId, fingerprint);
    if (prior) return prior;
    const rateKey = `web-activation-proof:${source}:${tokenHash(activationToken)}`; this.throttle.assertAllowed(rateKey);
    try {
      return this.store.transaction(() => {
        const replay = this.store.webOperation(accountId, receiptId, fingerprint); if (replay) return replay;
        const login = this.store.db.prepare("SELECT * FROM web_logins WHERE token_hash=? AND account_id=? AND expires_at>=?").get(tokenHash(activationToken), accountId, Date.now()) as any;
        if (!login || login.verified || login.proof || !String(login.signing_challenge).startsWith(DOMAIN)) throw new RelayError("AUTH_FAILED", "首次激活请求已失效，请重新登录");
        const context = JSON.parse(login.signing_challenge.slice(DOMAIN.length)); const provision = this.store.accountProvisionById(accountId);
        if (!provision || this.store.accountByUsername(provision.username) || this.store.meta(`webActivationMode:${accountId}`) !== "web-only"
          || context.origin !== this.origin || context.accountId !== accountId || context.operationId !== operationId
          || context.expiresAt !== login.expires_at || context.verifierDigest !== digest(provision.password_hash) || context.materialDigest !== digest(material)) {
          throw new RelayError("AUTH_FAILED", "账号或密钥材料已变化，请重新开始激活");
        }
        const expected = JSON.parse(login.box_nonce);
        const valid = sodium.crypto_sign_verify_detached(deviceSignature, Buffer.from(login.signing_challenge), decode(material.deviceSigningPublicKey, "deviceSigningPublicKey", 32))
          && sodium.crypto_sign_verify_detached(accountSignature, Buffer.from(login.signing_challenge), decode(material.accountSigningPublicKey, "accountSigningPublicKey", 32))
          && sodium.memcmp(deviceResponse, decode(expected[0], "deviceNonce", 32)) && sodium.memcmp(accountResponse, decode(expected[1], "accountNonce", 32));
        if (!valid) throw new RelayError("AUTH_FAILED", "首次激活密钥持有证明失败");
        const account = this.store.createAccount({ username: provision.username, displayName: provision.display_name, passwordHash: provision.password_hash,
          role: "user", signingPublicKey: material.accountSigningPublicKey, encryptionPublicKey: material.accountEncryptionPublicKey, escrowCiphertext: material.escrowCiphertext }, provision.id);
        this.store.db.prepare("INSERT INTO web_security(account_id,totp_required) VALUES(?,1)").run(accountId);
        this.store.db.prepare("INSERT INTO web_key_packages(account_id,version,credential_version,package_json,stale) VALUES(?,1,0,?,0)").run(accountId, material.packageJson);
        this.store.db.prepare("DELETE FROM account_provisions WHERE id=?").run(accountId);
        this.store.db.prepare("DELETE FROM web_logins WHERE account_id=?").run(accountId);
        this.store.db.prepare("DELETE FROM meta WHERE key=?").run(`webActivationMode:${accountId}`);
        const result = { state: "activated", account: { id: account.id, username: account.username, displayName: account.display_name, role: account.role,
          signingPublicKey: account.signing_public_key, encryptionPublicKey: account.encryption_public_key }, keyPackageVersion: 1, totpEnrollmentRequired: true };
        this.store.saveWebOperation(accountId, receiptId, fingerprint, result);
        this.store.audit(accountId, "web", "activation", "web.account.activate", "account", accountId);
        return result;
      });
    } catch (error) { this.throttle.failed(rateKey); if (error instanceof RelayError) throw error; throw new RelayError("INVALID_REQUEST", "首次激活材料无效"); }
  }
}
