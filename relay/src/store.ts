import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WEB_SCHEMA, invalidateWebCredentials } from "./web-schema.js";
import {
  ACCESS_TOKEN_TTL_MS,
  ENROLLMENT_TTL_MS,
  EVENT_MAX_AGE_MS,
  EVENT_MAX_ROWS_PER_HOST,
  INVITE_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  RelayError,
  id,
  token,
  tokenHash,
  type AccountRole,
  type CipherEnvelope,
  type PrincipalKind,
} from "./protocol.js";

const MAX_PENDING_HOST_ENROLLMENTS = 5_000;

// Operation receipts can survive a retry, but bearer credentials must never be
// copied into the durable SQLite operation ledger.
function operationReceipt(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(operationReceipt);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "accessToken" || key === "refreshToken" || key === "tokens") continue;
    result[key] = operationReceipt(item);
  }
  return result;
}

type AccountInput = {
  username: string;
  displayName: string;
  passwordHash: string;
  role: AccountRole;
  signingPublicKey: string;
  encryptionPublicKey: string;
  escrowCiphertext: string;
};

type DeviceInput = {
  accountId: string;
  name: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  approved: boolean;
  keyPackage?: string;
};

type AccountProvisionInput = {
  username: string;
  displayName: string;
  passwordHash: string;
  createdBy: string;
  webOnly?: boolean;
};

export type UpdatePlatform = "android" | "host";

export type UpdateReleaseInput = {
  platform: UpdatePlatform;
  version: string;
  versionCode?: number;
  manifestJson: string;
  manifestSignature: string;
  assetName: string;
  assetPath: string;
  assetSize: number;
  assetSha256: string;
  assetSignature?: string;
  createdBy: string;
};

const SCHEMA_VERSION = 3;

function compareReleaseVersions(left: string, right: string) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const compared = (a[index] || 0) - (b[index] || 0);
    if (compared) return compared;
  }
  return 0;
}

function now() { return Date.now(); }

export class RelayStore {
  db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const storedVersion = this.meta("schemaVersion");
    const schemaVersion = storedVersion === undefined ? 0 : Number(storedVersion);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 0 || schemaVersion > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`Relay 数据库版本不兼容: ${storedVersion ?? "unknown"}`);
    }
    if (schemaVersion === SCHEMA_VERSION) {
      this.transaction(() => this.ensureWebLoginColumns());
      return;
    }

    this.transaction(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bootstrap_tokens (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
        signing_public_key TEXT NOT NULL,
        encryption_public_key TEXT NOT NULL,
        escrow_ciphertext TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        disabled_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS account_provisions (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role='user'),
        created_by TEXT NOT NULL REFERENCES accounts(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        secret_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')),
        expires_at INTEGER NOT NULL,
        used_by TEXT REFERENCES accounts(id),
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        name TEXT NOT NULL,
        signing_public_key TEXT NOT NULL,
        encryption_public_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','revoked')),
        key_package TEXT,
        created_at INTEGER NOT NULL,
        approved_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS devices_account_idx ON devices(account_id, status);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        principal_kind TEXT NOT NULL CHECK(principal_kind IN ('device','host','web')),
        principal_id TEXT NOT NULL,
        access_hash TEXT NOT NULL UNIQUE,
        refresh_hash TEXT UNIQUE,
        access_expires_at INTEGER NOT NULL,
        refresh_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions(account_id, principal_kind, principal_id);
      CREATE TABLE IF NOT EXISTS host_enrollments (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        requested_name TEXT NOT NULL,
        signing_public_key TEXT NOT NULL,
        encryption_public_key TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        approved_by TEXT REFERENCES devices(id),
        approved_account_id TEXT REFERENCES accounts(id),
        approved_name TEXT,
        key_package TEXT,
        completed_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        name TEXT NOT NULL,
        signing_public_key TEXT NOT NULL,
        encryption_public_key TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER,
        UNIQUE(account_id, name)
      );
      CREATE INDEX IF NOT EXISTS hosts_account_idx ON hosts(account_id, revoked_at);
      CREATE TABLE IF NOT EXISTS encrypted_snapshots (
        account_id TEXT NOT NULL REFERENCES accounts(id),
        host_id TEXT NOT NULL REFERENCES hosts(id),
        device_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, host_id)
      );
      CREATE TABLE IF NOT EXISTS encrypted_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        host_id TEXT NOT NULL REFERENCES hosts(id),
        host_seq INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        counter INTEGER NOT NULL,
        kind TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(account_id, host_id, event_id),
        UNIQUE(account_id, host_id, host_seq)
      );
      CREATE INDEX IF NOT EXISTS encrypted_events_replay_idx ON encrypted_events(account_id, host_id, host_seq);
      CREATE TABLE IF NOT EXISTS message_counters (
        account_id TEXT NOT NULL REFERENCES accounts(id),
        principal_kind TEXT NOT NULL CHECK(principal_kind IN ('device','host')),
        principal_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        counter INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, principal_kind, principal_id, stream)
      );
      CREATE TABLE IF NOT EXISTS push_tokens (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        device_id TEXT NOT NULL REFERENCES devices(id),
        installation_id TEXT NOT NULL,
        fcm_token TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        revoked_at INTEGER,
        UNIQUE(device_id, installation_id)
      );
      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        key_hash TEXT PRIMARY KEY,
        failure_count INTEGER NOT NULL,
        last_failure_at INTEGER NOT NULL,
        blocked_until INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_rate_limits_updated_idx ON auth_rate_limits(last_failure_at);
      CREATE TABLE IF NOT EXISTS update_releases (
        platform TEXT NOT NULL CHECK(platform IN ('android','host')),
        version TEXT NOT NULL,
        version_code INTEGER,
        manifest_json TEXT NOT NULL,
        manifest_signature TEXT NOT NULL,
        asset_name TEXT NOT NULL,
        asset_path TEXT NOT NULL,
        asset_size INTEGER NOT NULL,
        asset_sha256 TEXT NOT NULL,
        asset_signature TEXT,
        published_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY(platform,version)
      );
      CREATE INDEX IF NOT EXISTS update_releases_latest_idx ON update_releases(platform,published_at DESC);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_kind TEXT,
        target_id TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at DESC);
      `);
      this.db.exec(WEB_SCHEMA);
      this.setMeta("schemaVersion", String(SCHEMA_VERSION));
    });
    // WEB_SCHEMA is part of the v0/v1/v2 -> v3 transaction above. The
    // additive column check is also kept idempotent for databases created by
    // an earlier v3 build; wrap it so that a partial upgrade cannot expose a
    // half-shaped login table.
    this.transaction(() => this.ensureWebLoginColumns());
  }

  private ensureWebLoginColumns() {
    const columns = new Set((this.db.prepare("PRAGMA table_info(web_logins)").all() as any[]).map((column) => String(column.name)));
    for (const [name, definition] of [
      ["device_name", "TEXT"],
      ["device_signing_public_key", "TEXT"],
      ["device_encryption_public_key", "TEXT"],
    ] as const) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE web_logins ADD COLUMN ${name} ${definition}`);
    }
  }

  close() { this.db.close(); }

  meta(key: string) {
    return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  accountCount() {
    return Number((this.db.prepare("SELECT count(*) AS value FROM accounts").get() as any).value);
  }

  createBootstrap(ttlMs = 15 * 60 * 1000) {
    if (this.accountCount() > 0) throw new RelayError("BOOTSTRAP_CLOSED", "管理员已经初始化");
    const value = { id: id(), secret: token(24), expiresAt: now() + ttlMs };
    this.db.prepare("INSERT INTO bootstrap_tokens(id,secret_hash,expires_at,created_at) VALUES(?,?,?,?)")
      .run(value.id, tokenHash(value.secret), value.expiresAt, now());
    return value;
  }

  claimBootstrap(
    bootstrapId: string,
    secret: string,
    account: AccountInput,
    device: Omit<DeviceInput, "accountId" | "approved">,
    recoveryPublicKey: string,
  ) {
    return this.transaction(() => {
      if (this.accountCount() > 0) throw new RelayError("BOOTSTRAP_CLOSED", "管理员已经初始化");
      const row = this.db.prepare("SELECT * FROM bootstrap_tokens WHERE id=?").get(bootstrapId) as any;
      if (!row || row.used_at || row.expires_at < now() || row.secret_hash !== tokenHash(secret)) {
        throw new RelayError("AUTH_FAILED", "初始化链接无效或已过期");
      }
      const created = this.createAccount(account);
      const firstDevice = this.createDevice({ ...device, accountId: created.id, approved: true });
      this.setMeta("recoveryPublicKey", recoveryPublicKey);
      this.db.prepare("UPDATE bootstrap_tokens SET used_at=? WHERE id=?").run(now(), bootstrapId);
      this.audit(created.id, "device", firstDevice.id, "account.bootstrap", "account", created.id);
      return { account: created, device: firstDevice };
    });
  }

  createAccount(input: AccountInput, accountId = id()) {
    this.db.prepare(`INSERT INTO accounts(
      id,username,display_name,password_hash,role,signing_public_key,encryption_public_key,escrow_ciphertext,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      accountId, input.username, input.displayName, input.passwordHash, input.role,
      input.signingPublicKey, input.encryptionPublicKey, input.escrowCiphertext, now(),
    );
    return this.accountById(accountId)!;
  }

  accountById(accountId: string) {
    return this.db.prepare("SELECT * FROM accounts WHERE id=?").get(accountId) as any | undefined;
  }

  accountByUsername(username: string) {
    return this.db.prepare("SELECT * FROM accounts WHERE username=? COLLATE NOCASE").get(username) as any | undefined;
  }

  accountProvisionByUsername(username: string) {
    return this.db.prepare("SELECT * FROM account_provisions WHERE username=? COLLATE NOCASE")
      .get(username) as any | undefined;
  }

  accountProvisionById(provisionId: string) {
    return this.db.prepare("SELECT * FROM account_provisions WHERE id=?").get(provisionId) as any | undefined;
  }

  createAccountProvision(input: AccountProvisionInput) {
    return this.transaction(() => {
      if (this.accountByUsername(input.username) || this.accountProvisionByUsername(input.username)) {
        throw new RelayError("CONFLICT", "用户名已经存在");
      }
      const provisionId = id();
      this.db.prepare(`INSERT INTO account_provisions(
        id,username,display_name,password_hash,role,created_by,created_at
      ) VALUES(?,?,?,?,?,?,?)`).run(
        provisionId, input.username, input.displayName, input.passwordHash, "user", input.createdBy, now(),
      );
      if (input.webOnly) this.setMeta(`webActivationMode:${provisionId}`, "web-only");
      this.audit(input.createdBy, "web", input.createdBy, "account.provision.create", "account_provision", provisionId, {
        username: input.username,
      });
      return this.accountProvisionById(provisionId)!;
    });
  }

  cancelAccountProvision(provisionId: string, actorId: string) {
    return this.transaction(() => {
    const provision = this.accountProvisionById(provisionId);
    if (!provision) throw new RelayError("NOT_FOUND", "待激活用户不存在");
    const changed = this.db.prepare("DELETE FROM account_provisions WHERE id=?").run(provisionId);
    if (!changed.changes) throw new RelayError("NOT_FOUND", "待激活用户不存在");
    this.db.prepare("DELETE FROM web_logins WHERE account_id=?").run(provisionId);
    this.db.prepare("DELETE FROM meta WHERE key=?").run(`webActivationMode:${provisionId}`);
    this.audit(actorId, "web", actorId, "account.provision.cancel", "account_provision", provisionId, {
      username: provision.username,
    });
    });
  }

  activateAccountProvision(
    provisionId: string,
    account: AccountInput,
    device: Omit<DeviceInput, "accountId" | "approved">,
  ) {
    return this.transaction(() => {
      const provision = this.accountProvisionById(provisionId);
      if (!provision || provision.username !== account.username) {
        throw new RelayError("AUTH_FAILED", "用户名或密码错误");
      }
      if (this.meta(`webActivationMode:${provisionId}`) === "web-only") {
        throw new RelayError("FORBIDDEN", "此账号需要在网页完成首次激活和验证码绑定");
      }
      if (this.accountByUsername(account.username)) throw new RelayError("CONFLICT", "用户已经激活");
      const created = this.createAccount({
        ...account,
        displayName: provision.display_name,
        passwordHash: provision.password_hash,
        role: "user",
      }, provision.id);
      const firstDevice = this.createDevice({ ...device, accountId: created.id, approved: true });
      const removed = this.db.prepare("DELETE FROM account_provisions WHERE id=?").run(provision.id);
      if (!removed.changes) throw new RelayError("CONFLICT", "用户已经激活");
      this.audit(created.id, "device", firstDevice.id, "account.activate", "account", created.id);
      return { account: created, device: firstDevice };
    });
  }

  listAccounts() {
    return this.db.prepare(`SELECT * FROM (
      SELECT id,username,display_name,role,status,created_at,disabled_at,
        (SELECT count(*) FROM devices d WHERE d.account_id=accounts.id AND d.status='approved') AS device_count,
        (SELECT count(*) FROM hosts h WHERE h.account_id=accounts.id AND h.revoked_at IS NULL) AS host_count,
        COALESCE((SELECT totp_required FROM web_security ws WHERE ws.account_id=accounts.id), 0) AS totp_required,
        CASE WHEN EXISTS (SELECT 1 FROM web_security ws WHERE ws.account_id=accounts.id AND ws.totp_secret IS NOT NULL) THEN 1 ELSE 0 END AS totp_configured,
        (SELECT version FROM web_key_packages wk WHERE wk.account_id=accounts.id) AS web_key_package_version,
        COALESCE((SELECT stale FROM web_key_packages wk WHERE wk.account_id=accounts.id), 0) AS web_key_package_stale
        FROM accounts
      UNION ALL
      SELECT id,username,display_name,role,'pending_activation' AS status,created_at,NULL AS disabled_at,
        0 AS device_count,0 AS host_count,0 AS totp_required,0 AS totp_configured,NULL AS web_key_package_version,0 AS web_key_package_stale FROM account_provisions
      ) ORDER BY created_at ASC`).all() as any[];
  }

  listAllHosts() {
    return this.db.prepare(`SELECT h.id,h.account_id,h.name,h.created_at,h.last_seen_at,h.revoked_at,a.username
      FROM hosts h JOIN accounts a ON a.id=h.account_id ORDER BY a.username,h.name`).all() as any[];
  }

  listInvites(accountId: string) {
    return this.db.prepare(`SELECT id,role,expires_at,used_by,used_at,created_at
      FROM invitations WHERE account_id=? ORDER BY created_at DESC`).all(accountId) as any[];
  }

  setAccountDisabled(accountId: string, disabled: boolean, actorId: string) {
    const changed = this.db.prepare("UPDATE accounts SET status=?,disabled_at=? WHERE id=?")
      .run(disabled ? "disabled" : "active", disabled ? now() : null, accountId);
    if (!changed.changes) throw new RelayError("NOT_FOUND", "用户不存在");
    if (disabled) this.db.prepare("UPDATE sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL").run(now(), accountId);
    this.audit(accountId, "web", actorId, disabled ? "account.disable" : "account.enable", "account", accountId);
  }

  changeAccountPassword(accountId: string, passwordHash: string, actorId: string, keepSessionId?: string) {
    return this.transaction(() => {
    const changed = this.db.prepare("UPDATE accounts SET password_hash=? WHERE id=? AND status='active'")
      .run(passwordHash, accountId);
    if (!changed.changes) throw new RelayError("NOT_FOUND", "用户不存在或已停用");
    if (keepSessionId) {
      this.db.prepare("UPDATE sessions SET revoked_at=? WHERE account_id=? AND id<>? AND revoked_at IS NULL")
        .run(now(), accountId, keepSessionId);
    } else {
      this.db.prepare("UPDATE sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL")
        .run(now(), accountId);
    }
    this.audit(accountId, "device", actorId, "account.password.change", "account", accountId);
    invalidateWebCredentials(this.db, accountId);
    });
  }

  resetUserPassword(targetId: string, passwordHash: string, actorId: string) {
    return this.transaction(() => {
    const account = this.accountById(targetId);
    if (account) {
      this.db.prepare("UPDATE accounts SET password_hash=? WHERE id=?").run(passwordHash, targetId);
      this.db.prepare("UPDATE sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL").run(now(), targetId);
      this.audit(targetId, "web", actorId, "account.password.reset", "account", targetId);
      invalidateWebCredentials(this.db, targetId);
      return "active" as const;
    }
    const provision = this.accountProvisionById(targetId);
    if (!provision) throw new RelayError("NOT_FOUND", "用户不存在");
    this.db.prepare("UPDATE account_provisions SET password_hash=? WHERE id=?").run(passwordHash, targetId);
    this.db.prepare("DELETE FROM web_logins WHERE account_id=?").run(targetId);
    this.audit(actorId, "web", actorId, "account.provision.password.reset", "account_provision", targetId);
    return "pending_activation" as const;
    });
  }

  createInvite(accountId: string, role: AccountRole, ttlMs = INVITE_TTL_MS) {
    const invite = { id: id(), secret: token(24), expiresAt: now() + ttlMs, role };
    this.db.prepare("INSERT INTO invitations(id,account_id,secret_hash,role,expires_at,created_at) VALUES(?,?,?,?,?,?)")
      .run(invite.id, accountId, tokenHash(invite.secret), role, invite.expiresAt, now());
    this.audit(accountId, "web", accountId, "invite.create", "invite", invite.id, { role });
    return invite;
  }

  claimInvite(inviteId: string, secret: string, account: AccountInput, device: Omit<DeviceInput, "accountId" | "approved">) {
    return this.transaction(() => {
      const invite = this.db.prepare("SELECT * FROM invitations WHERE id=?").get(inviteId) as any;
      if (!invite || invite.used_at || invite.expires_at < now() || invite.secret_hash !== tokenHash(secret)) {
        throw new RelayError("AUTH_FAILED", "邀请无效或已过期");
      }
      if (this.accountProvisionByUsername(account.username)) throw new RelayError("CONFLICT", "用户名已由管理员预留，请使用分配的账号激活");
      const created = this.createAccount({ ...account, role: invite.role });
      const firstDevice = this.createDevice({ ...device, accountId: created.id, approved: true });
      this.db.prepare("UPDATE invitations SET used_by=?,used_at=? WHERE id=?").run(created.id, now(), inviteId);
      this.audit(created.id, "device", firstDevice.id, "invite.claim", "invite", inviteId);
      return { account: created, device: firstDevice };
    });
  }

  createDevice(input: DeviceInput) {
    const deviceId = id();
    const status = input.approved ? "approved" : "pending";
    this.db.prepare(`INSERT INTO devices(
      id,account_id,name,signing_public_key,encryption_public_key,status,key_package,created_at,approved_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      deviceId, input.accountId, input.name, input.signingPublicKey, input.encryptionPublicKey,
      status, input.keyPackage || null, now(), input.approved ? now() : null,
    );
    return this.deviceById(input.accountId, deviceId)!;
  }

  findDeviceForLogin(accountId: string, deviceId: string | undefined, signingPublicKey: string, encryptionPublicKey: string, name: string, recoverKeys = false) {
    if (!deviceId) {
      if (recoverKeys) {
        // Opt-in recovery is checked by a device-private-key proof at the HTTP
        // boundary. Never adopt a browser or silently recreate revoked keys.
        const matching = this.db.prepare("SELECT * FROM devices WHERE account_id=? AND (signing_public_key=? OR encryption_public_key=?)")
          .all(accountId, signingPublicKey, encryptionPublicKey) as any[];
        if (matching.length) {
          const existing = matching.length === 1 ? matching[0] : undefined;
          if (!existing || existing.status === "revoked" || existing.signing_public_key !== signingPublicKey || existing.encryption_public_key !== encryptionPublicKey ||
              this.db.prepare("SELECT 1 FROM web_devices WHERE device_id=?").get(existing.id)) throw new RelayError("AUTH_FAILED", "设备密钥不匹配、已撤销或属于浏览器");
          this.db.prepare("UPDATE devices SET name=? WHERE id=? AND account_id=?").run(name, existing.id, accountId);
          return this.deviceById(accountId, existing.id)!;
        }
      }
      return this.createDevice({ accountId, name, signingPublicKey, encryptionPublicKey, approved: false });
    }
    const existing = this.deviceById(accountId, deviceId);
    if (!existing || existing.status === "revoked") throw new RelayError("AUTH_FAILED", "设备不存在或已撤销");
    if (existing.signing_public_key !== signingPublicKey || existing.encryption_public_key !== encryptionPublicKey) {
      throw new RelayError("AUTH_FAILED", "设备密钥不匹配");
    }
    this.db.prepare("UPDATE devices SET name=? WHERE id=? AND account_id=?").run(name, deviceId, accountId);
    return this.deviceById(accountId, deviceId)!;
  }

  findWebDeviceForLogin(accountId: string, deviceId: string | undefined, signingPublicKey: string, encryptionPublicKey: string, name: string) {
    if (!deviceId) {
      const created = this.createDevice({ accountId, name, signingPublicKey, encryptionPublicKey, approved: false });
      // Once password/TOTP have passed, the browser device may be recorded as
      // a pending web device. It remains blocked from sessions and channels
      // until proof/approval, while old Android APIs can still reject it by
      // the web_devices mapping.
      this.registerWebDevice(created.id, accountId);
      return created;
    }
    if (!this.db.prepare("SELECT 1 FROM web_devices WHERE device_id=? AND account_id=?").get(deviceId, accountId)) {
      throw new RelayError("FORBIDDEN", "网页必须使用独立的浏览器设备，不能复用 Android 设备");
    }
    const existing = this.deviceById(accountId, deviceId);
    if (!existing || existing.status === "revoked") throw new RelayError("AUTH_FAILED", "设备不存在或已撤销");
    if (existing.signing_public_key !== signingPublicKey || existing.encryption_public_key !== encryptionPublicKey) {
      throw new RelayError("AUTH_FAILED", "设备密钥不匹配");
    }
    this.db.prepare("UPDATE devices SET name=? WHERE id=? AND account_id=?").run(name, deviceId, accountId);
    return this.deviceById(accountId, deviceId)!;
  }

  deviceById(accountId: string, deviceId: string) {
    return this.db.prepare("SELECT * FROM devices WHERE account_id=? AND id=?").get(accountId, deviceId) as any | undefined;
  }

  listDevices(accountId: string) {
    return this.db.prepare("SELECT id,name,status,signing_public_key,encryption_public_key,created_at,approved_at,revoked_at FROM devices WHERE account_id=? ORDER BY created_at")
      .all(accountId) as any[];
  }

  approveDevice(accountId: string, deviceId: string, keyPackage: string, actorId: string) {
    const changed = this.db.prepare("UPDATE devices SET status='approved',key_package=?,approved_at=? WHERE id=? AND account_id=? AND status='pending'")
      .run(keyPackage, now(), deviceId, accountId);
    if (!changed.changes) throw new RelayError("NOT_FOUND", "待批准设备不存在");
    this.audit(accountId, "device", actorId, "device.approve", "device", deviceId);
  }

  approveWebDevice(accountId: string, deviceId: string, keyPackage: string, actorId: string) {
    const changed = this.db.prepare(`UPDATE devices SET status='approved',key_package=?,approved_at=?
      WHERE id=? AND account_id=? AND status!='revoked'`).run(keyPackage, now(), deviceId, accountId);
    if (!changed.changes) throw new RelayError("NOT_FOUND", "网页设备不存在或已撤销");
    this.registerWebDevice(deviceId, accountId);
    this.audit(accountId, "device", actorId, "web.device.approve", "device", deviceId);
  }

  completeWebMigration(accountId: string, deviceId: string, packageJson: string, expectedVersion: number, actorId: string,
    operationId?: string, fingerprint?: string,
    buildResponse?: (result: { version: number; credentialVersion: number }, tokens: ReturnType<RelayStore["createWebSession"]>) => unknown) {
    return this.transaction(() => {
      if (operationId && fingerprint) {
        const previous = this.webOperation(accountId, operationId, fingerprint);
        if (previous) return { version: Number(this.webKeyPackage(accountId)?.version || 0), credentialVersion: Number(this.ensureWebSecurity(accountId).credential_version), response: previous, replay: true };
      }
      const security = this.ensureWebSecurity(accountId);
      const current = this.webKeyPackage(accountId);
      const currentVersion = current ? Number(current.version) : 0;
      if (currentVersion !== expectedVersion) throw new RelayError("VERSION_CONFLICT", "网页密钥包版本已经变化", { version: currentVersion });
      if (current && !current.stale) throw new RelayError("CONFLICT", "网页迁移已经完成");
      const version = currentVersion + 1;
      this.db.prepare(`INSERT INTO web_key_packages(account_id,version,credential_version,package_json,stale)
        VALUES(?,?,?,?,0) ON CONFLICT(account_id) DO UPDATE SET version=excluded.version,
        credential_version=excluded.credential_version,package_json=excluded.package_json,stale=0`)
        .run(accountId, version, security.credential_version, packageJson);
      this.approveWebDevice(accountId, deviceId, packageJson, actorId);
      const result = { version, credentialVersion: Number(security.credential_version) };
      const tokens = this.createWebSession(accountId, deviceId);
      const response = buildResponse?.(result, tokens);
      if (operationId && fingerprint && response !== undefined) this.saveWebOperation(accountId, operationId, fingerprint, operationReceipt(response));
      return { ...result, response, replay: false };
    });
  }

  recoveryBundle(accountId: string, deviceId: string) {
    const account = this.db.prepare(`SELECT id,username,status,signing_public_key,encryption_public_key,escrow_ciphertext
      FROM accounts WHERE id=?`).get(accountId) as any;
    const device = this.db.prepare(`SELECT id,name,status,encryption_public_key FROM devices
      WHERE account_id=? AND id=?`).get(accountId, deviceId) as any;
    if (!account || account.status !== "active") throw new RelayError("NOT_FOUND", "可恢复用户不存在或已停用");
    if (!device || device.status !== "pending") throw new RelayError("NOT_FOUND", "待恢复设备不存在");
    return {
      accountId: account.id,
      username: account.username,
      accountSigningPublicKey: account.signing_public_key,
      accountEncryptionPublicKey: account.encryption_public_key,
      escrowCiphertext: account.escrow_ciphertext,
      recoveryPublicKey: this.meta("recoveryPublicKey"),
      deviceId: device.id,
      deviceName: device.name,
      deviceEncryptionPublicKey: device.encryption_public_key,
    };
  }

  recoverDevice(accountId: string, deviceId: string, keyPackage: string, actorId: string) {
    const changed = this.db.prepare(`UPDATE devices SET status='approved',key_package=?,approved_at=?
      WHERE id=? AND account_id=? AND status='pending'`).run(keyPackage, now(), deviceId, accountId);
    if (!changed.changes) throw new RelayError("NOT_FOUND", "待恢复设备不存在");
    this.audit(accountId, "web", actorId, "device.recover", "device", deviceId, { method: "offline-recovery-key" });
  }

  revokeDevice(accountId: string, deviceId: string, actorId: string) {
    const changed = this.db.prepare("UPDATE devices SET status='revoked',revoked_at=? WHERE id=? AND account_id=? AND status!='revoked'")
      .run(now(), deviceId, accountId);
    if (!changed.changes) throw new RelayError("NOT_FOUND", "设备不存在");
    this.db.prepare("UPDATE sessions SET revoked_at=? WHERE account_id=? AND principal_kind='device' AND principal_id=? AND revoked_at IS NULL")
      .run(now(), accountId, deviceId);
    this.audit(accountId, "device", actorId, "device.revoke", "device", deviceId);
  }

  revokeSession(sessionId: string) {
    this.db.prepare("UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now(), sessionId);
  }

  revokeRefreshToken(refreshToken: string) {
    this.db.prepare("UPDATE sessions SET revoked_at=? WHERE refresh_hash=? AND revoked_at IS NULL")
      .run(now(), tokenHash(refreshToken));
  }

  createSession(accountId: string, kind: PrincipalKind, principalId: string, withRefresh = true) {
    const accessToken = token();
    const refreshToken = withRefresh ? token() : undefined;
    const createdAt = now();
    const sessionId = id();
    this.db.prepare(`INSERT INTO sessions(
      id,account_id,principal_kind,principal_id,access_hash,refresh_hash,access_expires_at,refresh_expires_at,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      sessionId, accountId, kind, principalId, tokenHash(accessToken), refreshToken ? tokenHash(refreshToken) : null,
      createdAt + ACCESS_TOKEN_TTL_MS, refreshToken ? createdAt + REFRESH_TOKEN_TTL_MS : null, createdAt,
    );
    return { sessionId, accessToken, refreshToken, accessExpiresAt: createdAt + ACCESS_TOKEN_TTL_MS, refreshExpiresAt: refreshToken ? createdAt + REFRESH_TOKEN_TTL_MS : undefined };
  }

  ensureWebSecurity(accountId: string) {
    this.db.prepare("INSERT INTO web_security(account_id) VALUES(?) ON CONFLICT(account_id) DO NOTHING").run(accountId);
    return this.db.prepare("SELECT * FROM web_security WHERE account_id=?").get(accountId) as any;
  }

  webKeyPackage(accountId: string) {
    return this.db.prepare("SELECT * FROM web_key_packages WHERE account_id=?").get(accountId) as any | undefined;
  }

  webOperation(accountId: string, operationId: string, fingerprint: string) {
    const row = this.db.prepare("SELECT * FROM web_operations WHERE account_id=? AND operation_id=?")
      .get(accountId, operationId) as any | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new RelayError("CONFLICT", "operationId 已被不同请求占用");
    return JSON.parse(String(row.result_json));
  }

  webOperationById(accountId: string, operationId: string) {
    const row = this.db.prepare("SELECT result_json FROM web_operations WHERE account_id=? AND operation_id=?")
      .get(accountId, operationId) as { result_json?: string } | undefined;
    return row?.result_json ? JSON.parse(row.result_json) : undefined;
  }

  saveWebOperation(accountId: string, operationId: string, fingerprint: string, result: unknown) {
    this.db.prepare(`INSERT INTO web_operations(account_id,operation_id,fingerprint,result_json,created_at)
      VALUES(?,?,?,?,?) ON CONFLICT(account_id,operation_id) DO NOTHING`)
      .run(accountId, operationId, fingerprint, JSON.stringify(result), now());
    const row = this.db.prepare("SELECT fingerprint,result_json FROM web_operations WHERE account_id=? AND operation_id=?")
      .get(accountId, operationId) as any;
    if (row.fingerprint !== fingerprint) throw new RelayError("CONFLICT", "operationId 已被不同请求占用");
    return JSON.parse(String(row.result_json));
  }

  webLoginByToken(tokenValue: string) {
    const row = this.db.prepare(`SELECT l.*,a.status AS account_status,s.credential_version AS current_credential_version,
      s.totp_version AS current_totp_version,d.status AS device_status
      FROM web_logins l JOIN accounts a ON a.id=l.account_id
      JOIN web_security s ON s.account_id=l.account_id
      LEFT JOIN devices d ON d.id=l.device_id
      WHERE l.token_hash=? AND l.expires_at>=?`).get(tokenHash(tokenValue), now()) as any | undefined;
    if (!row || row.account_status !== "active" || row.device_status === "revoked"
      || Number(row.credential_version) !== Number(row.current_credential_version)
      || Number(row.totp_version) !== Number(row.current_totp_version)) return undefined;
    return row;
  }

  createWebLogin(input: {
    accountId: string; deviceId?: string; deviceName?: string; deviceSigningPublicKey?: string; deviceEncryptionPublicKey?: string;
    credentialVersion: number; totpVersion: number;
    verified: boolean; signingChallenge: string; boxNonce: string; trusted: boolean;
    enrollmentSecret?: string;
  }) {
    const loginToken = token();
    this.db.prepare(`INSERT INTO web_logins(
      token_hash,account_id,expires_at,credential_version,totp_version,verified,device_id,device_name,
      device_signing_public_key,device_encryption_public_key,signing_challenge,box_nonce,trusted,enrollment_secret
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      tokenHash(loginToken), input.accountId, now() + 5 * 60_000, input.credentialVersion,
      input.totpVersion, input.verified ? 1 : 0, input.deviceId || null, input.deviceName || null,
      input.deviceSigningPublicKey || null, input.deviceEncryptionPublicKey || null, input.signingChallenge,
      input.boxNonce, input.trusted ? 1 : 0, input.enrollmentSecret || null,
    );
    return loginToken;
  }

  materializeWebLoginDevice(tokenValue: string) {
    return this.transaction(() => {
      const login = this.webLoginByToken(tokenValue);
      if (!login) throw new RelayError("AUTH_FAILED", "登录事务已过期");
      if (login.device_id) {
        if (!this.db.prepare("SELECT 1 FROM web_devices WHERE device_id=? AND account_id=?").get(login.device_id, login.account_id)) {
          throw new RelayError("FORBIDDEN", "网页必须使用独立的浏览器设备，不能复用 Android 设备");
        }
        const existing = this.deviceById(login.account_id, login.device_id);
        if (!existing || existing.status === "revoked") throw new RelayError("AUTH_FAILED", "网页设备已撤销");
        return existing;
      }
      if (!login.device_name || !login.device_signing_public_key || !login.device_encryption_public_key) {
        throw new RelayError("AUTH_FAILED", "网页设备信息不完整");
      }
      const device = this.findWebDeviceForLogin(login.account_id, undefined,
        login.device_signing_public_key, login.device_encryption_public_key, login.device_name);
      this.db.prepare("UPDATE web_logins SET device_id=? WHERE token_hash=? AND device_id IS NULL")
        .run(device.id, tokenHash(tokenValue));
      return device;
    });
  }

  updateWebLogin(tokenValue: string, values: { verified?: boolean; proof?: boolean }) {
    const fields: string[] = [];
    const args: unknown[] = [];
    if (values.verified !== undefined) { fields.push("verified=?"); args.push(values.verified ? 1 : 0); }
    if (values.proof !== undefined) { fields.push("proof=?"); args.push(values.proof ? 1 : 0); }
    if (!fields.length) return;
    args.push(tokenHash(tokenValue));
    this.db.prepare(`UPDATE web_logins SET ${fields.join(",")} WHERE token_hash=?`).run(...args as any[]);
  }

  deleteWebLogin(tokenValue: string) {
    this.db.prepare("DELETE FROM web_logins WHERE token_hash=?").run(tokenHash(tokenValue));
  }

  saveWebKeyPackageWithOperation(accountId: string, packageJson: string, expectedVersion: number, credentialVersion: number,
    operationId?: string, fingerprint?: string, buildResponse?: (saved: any) => unknown) {
    return this.transaction(() => {
      if (operationId && fingerprint) {
        const previous = this.webOperation(accountId, operationId, fingerprint);
        if (previous) return { saved: this.webKeyPackage(accountId), response: previous, replay: true };
      }
      const current = this.webKeyPackage(accountId);
      const currentVersion = current ? Number(current.version) : 0;
      if (currentVersion !== expectedVersion) throw new RelayError("VERSION_CONFLICT", "网页密钥包版本已经变化", { version: currentVersion });
      const version = currentVersion + 1;
      this.db.prepare(`INSERT INTO web_key_packages(account_id,version,credential_version,package_json,stale)
        VALUES(?,?,?,?,0) ON CONFLICT(account_id) DO UPDATE SET version=excluded.version,
        credential_version=excluded.credential_version,package_json=excluded.package_json,stale=0`)
        .run(accountId, version, credentialVersion, packageJson);
      this.ensureWebSecurity(accountId);
      const saved = this.webKeyPackage(accountId)!;
      const response = buildResponse?.(saved);
      if (operationId && fingerprint && response !== undefined) this.saveWebOperation(accountId, operationId, fingerprint, operationReceipt(response));
      return { saved, response, replay: false };
    });
  }

  saveWebKeyPackage(accountId: string, packageJson: string, expectedVersion: number, credentialVersion: number) {
    return this.saveWebKeyPackageWithOperation(accountId, packageJson, expectedVersion, credentialVersion).saved;
  }

  changeWebPassword(accountId: string, passwordHash: string, packageJson: string, expectedVersion: number, actorId: string, keepSessionId: string,
    operationId?: string, fingerprint?: string, buildResponse?: (result: { credentialVersion: number; version: number }) => unknown) {
    return this.transaction(() => {
      if (operationId && fingerprint) {
        const previous = this.webOperation(accountId, operationId, fingerprint);
        if (previous) return { credentialVersion: Number(this.ensureWebSecurity(accountId).credential_version), version: Number(this.webKeyPackage(accountId)?.version || 0), response: previous, replay: true };
      }
      const security = this.ensureWebSecurity(accountId);
      const current = this.webKeyPackage(accountId);
      const currentVersion = current ? Number(current.version) : 0;
      if (currentVersion !== expectedVersion) throw new RelayError("VERSION_CONFLICT", "网页密钥包版本已经变化", { version: currentVersion });
      const nextCredentialVersion = Number(security.credential_version) + 1;
      this.db.prepare("UPDATE accounts SET password_hash=? WHERE id=? AND status='active'").run(passwordHash, accountId);
      const nextPackageVersion = currentVersion + 1;
      this.db.prepare(`INSERT INTO web_key_packages(account_id,version,credential_version,package_json,stale)
        VALUES(?,?,?,?,0) ON CONFLICT(account_id) DO UPDATE SET version=excluded.version,
        credential_version=excluded.credential_version,package_json=excluded.package_json,stale=0`)
        .run(accountId, nextPackageVersion, nextCredentialVersion, packageJson);
      this.db.prepare("UPDATE web_security SET credential_version=? WHERE account_id=?").run(nextCredentialVersion, accountId);
      this.db.prepare("UPDATE sessions SET revoked_at=? WHERE account_id=? AND id<>? AND revoked_at IS NULL").run(now(), accountId, keepSessionId);
      this.db.prepare("UPDATE web_sessions SET credential_version=? WHERE session_id=?").run(nextCredentialVersion, keepSessionId);
      this.db.prepare("DELETE FROM web_tickets WHERE account_id=?").run(accountId);
      this.audit(accountId, "device", actorId, "web.password.change", "account", accountId, { packageVersion: nextPackageVersion });
      const result = { credentialVersion: nextCredentialVersion, version: nextPackageVersion };
      const response = buildResponse?.(result);
      if (operationId && fingerprint && response !== undefined) this.saveWebOperation(accountId, operationId, fingerprint, operationReceipt(response));
      return { ...result, response, replay: false };
    });
  }

  registerWebDevice(deviceId: string, accountId: string) {
    this.db.prepare("INSERT INTO web_devices(device_id,account_id) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET account_id=excluded.account_id")
      .run(deviceId, accountId);
  }

  createWebSession(accountId: string, deviceId: string) {
    const security = this.ensureWebSecurity(accountId);
    const session = this.createSession(accountId, "device", deviceId, true);
    this.db.prepare("INSERT INTO web_sessions(session_id,account_id,credential_version,totp_version) VALUES(?,?,?,?)")
      .run(session.sessionId, accountId, security.credential_version, security.totp_version);
    return session;
  }

  webSessionById(sessionId: string) {
    const row = this.db.prepare(`SELECT s.*,a.role,a.status AS account_status,d.status AS device_status,
      w.credential_version,w.totp_version,sec.credential_version AS current_credential_version,
      sec.totp_version AS current_totp_version
      FROM sessions s JOIN accounts a ON a.id=s.account_id JOIN web_sessions w ON w.session_id=s.id
      JOIN web_security sec ON sec.account_id=s.account_id LEFT JOIN devices d ON d.id=s.principal_id
      WHERE s.id=? AND s.principal_kind='device' AND s.revoked_at IS NULL AND s.access_expires_at>=?`).get(sessionId, now()) as any | undefined;
    if (!row || row.account_status !== "active" || row.device_status !== "approved"
      || row.credential_version !== row.current_credential_version || row.totp_version !== row.current_totp_version) return undefined;
    return row;
  }

  consumeWebTicket(ticketValue: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM web_tickets WHERE token_hash=? AND expires_at>=? AND used_at IS NULL")
        .get(tokenHash(ticketValue), now()) as any | undefined;
      if (!row) throw new RelayError("AUTH_FAILED", "WebSocket 票据无效或已使用");
      const changed = this.db.prepare("UPDATE web_tickets SET used_at=? WHERE token_hash=? AND used_at IS NULL")
        .run(now(), tokenHash(ticketValue));
      if (!changed.changes) throw new RelayError("AUTH_FAILED", "WebSocket 票据无效或已使用");
      const session = this.webSessionById(row.session_id);
      if (!session || session.account_id !== row.account_id || session.principal_id !== row.device_id) {
        throw new RelayError("AUTH_FAILED", "网页会话已失效");
      }
      return { ...row, session };
    });
  }

  createWebTicket(sessionId: string, accountId: string, deviceId: string) {
    const value = token(24);
    this.db.prepare("INSERT INTO web_tickets(token_hash,session_id,account_id,device_id,expires_at) VALUES(?,?,?,?,?)")
      .run(tokenHash(value), sessionId, accountId, deviceId, now() + 60_000);
    return { ticket: value, expiresAt: now() + 60_000 };
  }

  refreshWebSession(refreshToken: string) {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT s.*,w.credential_version,w.totp_version,sec.credential_version AS current_credential_version,
        sec.totp_version AS current_totp_version,a.status AS account_status,d.status AS device_status
        FROM sessions s JOIN web_sessions w ON w.session_id=s.id JOIN web_security sec ON sec.account_id=s.account_id
        JOIN accounts a ON a.id=s.account_id JOIN devices d ON d.id=s.principal_id
        WHERE s.refresh_hash=? AND s.principal_kind='device' AND s.revoked_at IS NULL AND s.refresh_expires_at>=?`)
        .get(tokenHash(refreshToken), now()) as any | undefined;
      if (!row || row.account_status !== "active" || row.device_status !== "approved"
        || row.credential_version !== row.current_credential_version || row.totp_version !== row.current_totp_version) {
        throw new RelayError("AUTH_FAILED", "网页刷新令牌无效");
      }
      this.db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(now(), row.id);
      return this.createWebSession(row.account_id, row.principal_id);
    });
  }

  setTotpRequired(accountId: string, required: boolean) {
    return this.transaction(() => {
      const current = this.ensureWebSecurity(accountId);
      const nextVersion = Number(current.totp_version) + 1;
      this.db.prepare(`UPDATE web_security SET totp_required=?,totp_version=?,totp_secret=NULL,
        recovery_hashes='[]',totp_last_step=-1 WHERE account_id=?`).run(required ? 1 : 0, nextVersion, accountId);
      this.db.prepare("UPDATE sessions SET revoked_at=? WHERE account_id=? AND principal_kind='device' AND principal_id IN (SELECT device_id FROM web_devices) AND revoked_at IS NULL")
        .run(now(), accountId);
      this.db.prepare("DELETE FROM web_logins WHERE account_id=?").run(accountId);
      this.db.prepare("DELETE FROM web_tickets WHERE account_id=?").run(accountId);
      return this.ensureWebSecurity(accountId);
    });
  }

  setTotpSecret(accountId: string, secret: string, recoveryHashes: string[], loginToken: string) {
    return this.transaction(() => {
      const security = this.ensureWebSecurity(accountId);
      const pending = this.webLoginByToken(loginToken);
      if (!pending || pending.account_id !== accountId || pending.enrollment_secret !== secret || pending.verified
        || !security.totp_required || security.totp_secret) throw new RelayError("VERSION_CONFLICT", "TOTP 绑定事务已经完成或已失效");
      const version = Number(security.totp_version) + 1;
      const updated = this.db.prepare(`UPDATE web_security SET totp_secret=?,recovery_hashes=?,totp_version=?,totp_last_step=-1
        WHERE account_id=? AND totp_required=1 AND totp_secret IS NULL AND totp_version=? AND credential_version=?`)
        .run(secret, JSON.stringify(recoveryHashes), version, accountId, pending.totp_version, pending.credential_version);
      if (!updated.changes) throw new RelayError("VERSION_CONFLICT", "验证码绑定状态已经变化，请重新登录");
        const changed = this.db.prepare("UPDATE web_logins SET totp_version=?,enrollment_secret=NULL,verified=1 WHERE token_hash=? AND account_id=? AND enrollment_secret IS NOT NULL")
          .run(version, tokenHash(loginToken), accountId);
        if (!changed.changes) throw new RelayError("CONFLICT", "TOTP 绑定事务已经完成或已失效");
      this.db.prepare("DELETE FROM web_logins WHERE account_id=? AND token_hash<>?").run(accountId, tokenHash(loginToken));
      return version;
    });
  }

  recordTotpStep(accountId: string, step: number) {
    this.db.prepare("UPDATE web_security SET totp_last_step=? WHERE account_id=? AND totp_last_step<?").run(step, accountId, step);
  }

  consumeRecoveryHash(accountId: string, hash: string) {
    return this.transaction(() => {
      const security = this.ensureWebSecurity(accountId);
      const hashes = JSON.parse(String(security.recovery_hashes || "[]")) as string[];
      const index = hashes.indexOf(hash);
      if (index < 0) return false;
      hashes.splice(index, 1);
      this.db.prepare("UPDATE web_security SET recovery_hashes=? WHERE account_id=?").run(JSON.stringify(hashes), accountId);
      return true;
    });
  }

  authenticateAccess(accessToken: string, allowPendingDevice = false) {
    const row = this.db.prepare(`SELECT s.*,a.role,a.status AS account_status,d.status AS device_status
      FROM sessions s JOIN accounts a ON a.id=s.account_id
      LEFT JOIN devices d ON s.principal_kind='device' AND d.id=s.principal_id
      WHERE s.access_hash=? AND s.revoked_at IS NULL AND s.access_expires_at>=?`).get(tokenHash(accessToken), now()) as any;
    if (!row || row.account_status !== "active") return undefined;
    if (row.principal_kind === "device" && this.db.prepare('SELECT 1 FROM web_devices WHERE device_id=?').get(row.principal_id)) {
      const verified = this.db.prepare(`SELECT 1 FROM web_sessions w JOIN web_security a ON a.account_id=w.account_id
        WHERE w.session_id=? AND w.credential_version=a.credential_version AND w.totp_version=a.totp_version`).get(row.id);
      if (!verified) return undefined;
    }
    if (row.principal_kind === "device" && row.device_status !== "approved" && !(allowPendingDevice && row.device_status === "pending")) return undefined;
    return row;
  }

  refreshSession(refreshToken: string, allowPendingDevice = false) {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT s.*,a.status AS account_status,d.status AS device_status FROM sessions s
        JOIN accounts a ON a.id=s.account_id LEFT JOIN devices d ON s.principal_kind='device' AND d.id=s.principal_id
        WHERE s.refresh_hash=? AND s.revoked_at IS NULL AND s.refresh_expires_at>=?`).get(tokenHash(refreshToken), now()) as any;
      if (!row || row.account_status !== "active"
        || (row.principal_kind === "device" && row.device_status !== "approved" && !(allowPendingDevice && row.device_status === "pending"))) {
        throw new RelayError("AUTH_FAILED", "刷新令牌无效");
      }
      if (this.db.prepare('SELECT 1 FROM web_devices WHERE device_id=?').get(row.principal_id)) {
        throw new RelayError('AUTH_FAILED', '网页设备必须使用网页刷新接口');
      }
      this.db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(now(), row.id);
      return this.createSession(row.account_id, row.principal_kind, row.principal_id, true);
    });
  }

  rateLimitGet(key: string) {
    return this.db.prepare(`SELECT failure_count AS count,last_failure_at AS lastFailureAt,blocked_until AS blockedUntil
      FROM auth_rate_limits WHERE key_hash=?`).get(tokenHash(key)) as {
        count: number;
        lastFailureAt: number;
        blockedUntil: number;
      } | undefined;
  }

  rateLimitSet(key: string, value: { count: number; lastFailureAt: number; blockedUntil: number }) {
    this.db.prepare(`INSERT INTO auth_rate_limits(key_hash,failure_count,last_failure_at,blocked_until)
      VALUES(?,?,?,?) ON CONFLICT(key_hash) DO UPDATE SET failure_count=excluded.failure_count,
      last_failure_at=excluded.last_failure_at,blocked_until=excluded.blocked_until`)
      .run(tokenHash(key), value.count, value.lastFailureAt, value.blockedUntil);
  }

  rateLimitDelete(key: string) {
    this.db.prepare("DELETE FROM auth_rate_limits WHERE key_hash=?").run(tokenHash(key));
  }

  rateLimitPrune(before: number, maxEntries: number) {
    this.db.prepare("DELETE FROM auth_rate_limits WHERE last_failure_at<?").run(before);
    const count = this.rateLimitSize();
    if (count < maxEntries) return;
    this.db.prepare(`DELETE FROM auth_rate_limits WHERE key_hash IN (
      SELECT key_hash FROM auth_rate_limits ORDER BY last_failure_at ASC LIMIT ?
    )`).run(count - maxEntries + 1);
  }

  rateLimitSize() {
    return Number((this.db.prepare("SELECT count(*) AS value FROM auth_rate_limits").get() as any).value);
  }

  publishUpdate(input: UpdateReleaseInput) {
    const latest = this.latestUpdate(input.platform);
    if (latest && latest.version !== input.version && compareReleaseVersions(input.version, latest.version) <= 0) {
      throw new RelayError("CONFLICT", "不能发布低于当前版本的更新");
    }
    this.db.prepare(`INSERT INTO update_releases(
      platform,version,version_code,manifest_json,manifest_signature,asset_name,asset_path,asset_size,
      asset_sha256,asset_signature,published_at,created_by
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(platform,version) DO UPDATE SET
      version_code=excluded.version_code,manifest_json=excluded.manifest_json,
      manifest_signature=excluded.manifest_signature,asset_name=excluded.asset_name,
      asset_path=excluded.asset_path,asset_size=excluded.asset_size,asset_sha256=excluded.asset_sha256,
      asset_signature=excluded.asset_signature,published_at=excluded.published_at,created_by=excluded.created_by`).run(
      input.platform, input.version, input.versionCode ?? null, input.manifestJson, input.manifestSignature,
      input.assetName, input.assetPath, input.assetSize, input.assetSha256, input.assetSignature ?? null,
      now(), input.createdBy,
    );
    this.audit(null, "system", input.createdBy, "update.publish", "update_release", `${input.platform}:${input.version}`);
    return this.updateRelease(input.platform, input.version)!;
  }

  latestUpdate(platform: UpdatePlatform) {
    return (this.db.prepare("SELECT * FROM update_releases WHERE platform=?").all(platform) as any[])
      .sort((left, right) => compareReleaseVersions(right.version, left.version))[0];
  }

  updateRelease(platform: UpdatePlatform, version: string) {
    return this.db.prepare("SELECT * FROM update_releases WHERE platform=? AND version=?")
      .get(platform, version) as any | undefined;
  }

  startHostEnrollment(name: string, signingPublicKey: string, encryptionPublicKey: string, ttlMs = ENROLLMENT_TTL_MS) {
    return this.transaction(() => {
      const at = now();
      this.db.prepare("DELETE FROM host_enrollments WHERE (completed_at IS NULL AND expires_at<?) OR completed_at<?").run(at, at - 24 * 60 * 60_000);
      const pending = this.db.prepare("SELECT COUNT(*) AS count FROM host_enrollments WHERE completed_at IS NULL").get() as { count: number };
      if (pending.count >= MAX_PENDING_HOST_ENROLLMENTS) throw new RelayError("RATE_LIMITED", "主机绑定请求数量已达上限");
      const enrollment = { id: id(), secret: token(24), expiresAt: at + ttlMs };
      this.db.prepare(`INSERT INTO host_enrollments(
        id,secret_hash,requested_name,signing_public_key,encryption_public_key,expires_at,created_at
      ) VALUES(?,?,?,?,?,?,?)`).run(enrollment.id, tokenHash(enrollment.secret), name, signingPublicKey, encryptionPublicKey, enrollment.expiresAt, at);
      this.audit(null, "system", "anonymous", "host.enroll.start", "host_enrollment", enrollment.id);
      return enrollment;
    });
  }

  hostEnrollment(enrollmentId: string, secret: string) {
    const row = this.db.prepare(`SELECT id,requested_name,signing_public_key,encryption_public_key,expires_at,
      approved_account_id,approved_name,completed_at
      FROM host_enrollments WHERE id=? AND secret_hash=?`).get(enrollmentId, tokenHash(secret)) as any;
    if (!row || (!row.completed_at && row.expires_at < now())) throw new RelayError("AUTH_FAILED", "主机绑定二维码无效或已过期");
    return row;
  }

  approveHostEnrollment(accountId: string, deviceId: string, enrollmentId: string, secret: string, name: string, keyPackage: string) {
    this.transaction(() => {
      const approver = this.db.prepare("SELECT id FROM devices WHERE id=? AND account_id=? AND status='approved'")
        .get(deviceId, accountId);
      if (!approver) throw new RelayError("AUTH_FAILED", "只有已批准设备可以绑定主机");
      const row = this.db.prepare("SELECT * FROM host_enrollments WHERE id=?").get(enrollmentId) as any;
      if (!row || row.completed_at || row.expires_at < now() || row.secret_hash !== tokenHash(secret)) {
        throw new RelayError("AUTH_FAILED", "主机绑定二维码无效或已过期");
      }
      if (row.approved_account_id) throw new RelayError("CONFLICT", "主机绑定已经被批准，请查询连接状态");
      if (this.db.prepare("SELECT 1 FROM hosts WHERE account_id=? AND name=?").get(accountId, name)
        || this.db.prepare("SELECT 1 FROM host_enrollments WHERE approved_account_id=? AND approved_name=? AND completed_at IS NULL AND expires_at>=? AND id<>?").get(accountId, name, now(), enrollmentId)) {
        throw new RelayError("CONFLICT", "此账号已有同名电脑，请修改显示名称再确认");
      }
      const changed = this.db.prepare(`UPDATE host_enrollments SET approved_by=?,approved_account_id=?,approved_name=?,key_package=?
        WHERE id=? AND approved_account_id IS NULL`).run(deviceId, accountId, name, keyPackage, enrollmentId);
      if (!changed.changes) throw new RelayError("CONFLICT", "主机绑定已经被其他账户批准");
      this.audit(accountId, "device", deviceId, "host.enroll.approve", "host_enrollment", enrollmentId);
    });
  }

  completeHostEnrollment(enrollmentId: string, secret: string, proposedHostToken?: string) {
    return this.transaction(() => {
      if (proposedHostToken !== undefined && !/^[A-Za-z0-9_-]{32,128}$/.test(proposedHostToken)) throw new RelayError("INVALID_REQUEST", "Host token 格式无效");
      const row = this.db.prepare("SELECT * FROM host_enrollments WHERE id=?").get(enrollmentId) as any;
      if (!row || (!row.completed_at && row.expires_at < now()) || row.secret_hash !== tokenHash(secret) || !row.approved_account_id) {
        throw new RelayError("AUTH_FAILED", "主机绑定尚未批准或已经失效");
      }
      const account = this.accountById(row.approved_account_id);
      if (!account || account.status !== "active") throw new RelayError("AUTH_FAILED", "绑定账号不可用");
      if (row.completed_at) {
        if (!proposedHostToken) throw new RelayError("AUTH_FAILED", "旧客户端主机绑定事务已完成");
        const host = this.db.prepare(`SELECT * FROM hosts WHERE account_id=? AND name=? AND signing_public_key=? AND encryption_public_key=? AND token_hash=? AND revoked_at IS NULL`)
          .get(account.id, row.approved_name || row.requested_name, row.signing_public_key, row.encryption_public_key, tokenHash(proposedHostToken)) as any;
        if (!host) throw new RelayError("CONFLICT", "主机绑定重试材料不一致或已被撤销");
        return { host, hostToken: proposedHostToken, keyPackage: row.key_package, account: { id: account.id, signingPublicKey: account.signing_public_key, encryptionPublicKey: account.encryption_public_key } };
      }
      const hostId = id();
      const hostToken = proposedHostToken || token();
      if (this.db.prepare("SELECT 1 FROM hosts WHERE account_id=? AND name=?").get(account.id, row.approved_name || row.requested_name)) throw new RelayError("CONFLICT", "同名电脑已存在，请重新配对并修改显示名称");
      this.db.prepare(`INSERT INTO hosts(
        id,account_id,name,signing_public_key,encryption_public_key,token_hash,created_at,last_seen_at
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        hostId, row.approved_account_id, row.approved_name || row.requested_name,
        row.signing_public_key, row.encryption_public_key, tokenHash(hostToken), now(), now(),
      );
      this.db.prepare("UPDATE host_enrollments SET completed_at=? WHERE id=?").run(now(), enrollmentId);
      this.audit(account.id, "host", hostId, "host.enroll.complete", "host", hostId);
      return {
        host: this.hostById(account.id, hostId), hostToken,
        keyPackage: row.key_package,
        account: { id: account.id, signingPublicKey: account.signing_public_key, encryptionPublicKey: account.encryption_public_key },
      };
    });
  }

  authenticateHost(hostToken: string) {
    return this.db.prepare(`SELECT h.*,a.status AS account_status,a.signing_public_key AS account_signing_public_key,
      a.encryption_public_key AS account_encryption_public_key FROM hosts h JOIN accounts a ON a.id=h.account_id
      WHERE h.token_hash=? AND h.revoked_at IS NULL AND a.status='active'`).get(tokenHash(hostToken)) as any | undefined;
  }

  hostById(accountId: string, hostId: string) {
    return this.db.prepare("SELECT * FROM hosts WHERE account_id=? AND id=?").get(accountId, hostId) as any | undefined;
  }

  listHosts(accountId: string) {
    return this.db.prepare("SELECT id,name,signing_public_key,encryption_public_key,created_at,last_seen_at,revoked_at FROM hosts WHERE account_id=? AND revoked_at IS NULL ORDER BY name")
      .all(accountId) as any[];
  }

  touchHost(accountId: string, hostId: string) {
    this.db.prepare("UPDATE hosts SET last_seen_at=? WHERE account_id=? AND id=? AND revoked_at IS NULL").run(now(), accountId, hostId);
  }

  revokeHost(accountId: string, hostId: string, actorId: string) {
    const changed = this.db.prepare("UPDATE hosts SET revoked_at=? WHERE id=? AND account_id=? AND revoked_at IS NULL")
      .run(now(), hostId, accountId);
    if (!changed.changes) throw new RelayError("NOT_FOUND", "主机不存在");
    this.audit(accountId, "device", actorId, "host.revoke", "host", hostId);
  }

  putSnapshot(envelope: CipherEnvelope) {
    this.requireHost(envelope.accountId, envelope.hostId);
    const revision = envelope.counter;
    this.db.prepare(`INSERT INTO encrypted_snapshots(account_id,host_id,device_id,channel_id,revision,kind,ciphertext,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id,host_id) DO UPDATE SET
      device_id=excluded.device_id,channel_id=excluded.channel_id,revision=excluded.revision,
      kind=excluded.kind,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at
      WHERE excluded.revision > encrypted_snapshots.revision`).run(
      envelope.accountId, envelope.hostId, envelope.deviceId, envelope.channelId,
      revision, envelope.kind, envelope.ciphertext, now(),
    );
  }

  snapshot(accountId: string, hostId: string) {
    this.requireHost(accountId, hostId);
    const row = this.db.prepare(`SELECT host_id,device_id,channel_id,revision,kind,ciphertext,updated_at
      FROM encrypted_snapshots WHERE account_id=? AND host_id=?`)
      .get(accountId, hostId) as any | undefined;
    if (!row) return undefined;
    return {
      updatedAt: row.updated_at,
      envelope: {
        accountId,
        hostId: row.host_id,
        deviceId: row.device_id,
        channelId: row.channel_id,
        counter: row.revision,
        kind: row.kind,
        ciphertext: row.ciphertext,
      } satisfies CipherEnvelope,
    };
  }

  storedEvent(accountId: string, hostId: string, eventId: string) {
    this.requireHost(accountId, hostId);
    return this.eventRow(accountId, hostId, eventId);
  }

  appendEvent(envelope: CipherEnvelope) {
    if (!envelope.eventId || !envelope.eventType) throw new RelayError("INVALID_REQUEST", "事件信封缺少 eventId 或 eventType");
    this.requireHost(envelope.accountId, envelope.hostId);
    const nextSeq = Number((this.db.prepare(`SELECT coalesce(max(host_seq),0)+1 AS value FROM encrypted_events
      WHERE account_id=? AND host_id=?`).get(envelope.accountId, envelope.hostId) as any).value);
    const result = this.db.prepare(`INSERT OR IGNORE INTO encrypted_events(
      account_id,host_id,host_seq,device_id,channel_id,counter,kind,event_id,event_type,ciphertext,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      envelope.accountId, envelope.hostId, nextSeq, envelope.deviceId, envelope.channelId,
      envelope.counter, envelope.kind, envelope.eventId, envelope.eventType, envelope.ciphertext, now(),
    );
    this.pruneEvents(envelope.accountId, envelope.hostId);
    if (!result.changes) return undefined;
    return this.eventRow(envelope.accountId, envelope.hostId, envelope.eventId);
  }

  eventsAfter(accountId: string, hostId: string, lastSeq: number, limit?: number) {
    this.requireHost(accountId, hostId);
    const bounds = this.db.prepare("SELECT min(host_seq) AS min_seq,max(host_seq) AS max_seq FROM encrypted_events WHERE account_id=? AND host_id=?")
      .get(accountId, hostId) as any;
    if (bounds?.min_seq && lastSeq > 0 && lastSeq < Number(bounds.min_seq) - 1) {
      throw new RelayError("EVENT_GAP", "事件游标已经过期", { minSeq: bounds.min_seq, maxSeq: bounds.max_seq });
    }
    if (limit !== undefined) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new RelayError("INVALID_REQUEST", "回放分页大小无效");
      const page: ReturnType<RelayStore["mapStoredEvent"]>[] = []; let bytes = 0;
      const rows = this.db.prepare(`SELECT host_seq AS seq,host_id,device_id,channel_id,counter,kind,event_id,event_type,ciphertext,created_at
        FROM encrypted_events WHERE account_id=? AND host_id=? AND host_seq>? ORDER BY host_seq ASC LIMIT ?`).iterate(accountId, hostId, lastSeq, limit);
      for (const row of rows) {
        const mapped = this.mapStoredEvent(row, accountId), size = Buffer.byteLength(JSON.stringify(mapped));
        if (page.length && bytes + size > 1024 * 1024) break;
        page.push(mapped); bytes += size;
      }
      return page;
    }
    return (this.db.prepare(`SELECT host_seq AS seq,host_id,device_id,channel_id,counter,kind,event_id,event_type,ciphertext,created_at
      FROM encrypted_events WHERE account_id=? AND host_id=? AND host_seq>? ORDER BY host_seq ASC`)
      .all(accountId, hostId, lastSeq) as any[]).map((row) => this.mapStoredEvent(row, accountId));
  }

  pruneEvents(accountId: string, hostId: string) {
    this.db.prepare("DELETE FROM encrypted_events WHERE account_id=? AND host_id=? AND created_at<?")
      .run(accountId, hostId, now() - EVENT_MAX_AGE_MS);
    this.db.prepare(`DELETE FROM encrypted_events WHERE account_id=? AND host_id=? AND host_seq NOT IN (
      SELECT host_seq FROM encrypted_events WHERE account_id=? AND host_id=? ORDER BY host_seq DESC LIMIT ?
    )`).run(accountId, hostId, accountId, hostId, EVENT_MAX_ROWS_PER_HOST);
  }

  registerPush(accountId: string, deviceId: string, installationId: string, fcmToken: string) {
    const device = this.db.prepare("SELECT id FROM devices WHERE id=? AND account_id=? AND status='approved'").get(deviceId, accountId);
    if (!device) throw new RelayError("AUTH_FAILED", "设备不存在或尚未批准");
    this.db.prepare(`INSERT INTO push_tokens(id,account_id,device_id,installation_id,fcm_token,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(device_id,installation_id) DO UPDATE SET
      fcm_token=excluded.fcm_token,updated_at=excluded.updated_at,revoked_at=NULL`).run(
      id(), accountId, deviceId, installationId, fcmToken, now(),
    );
  }

  pushTokens(accountId: string) {
    return (this.db.prepare(`SELECT p.fcm_token FROM push_tokens p JOIN devices d ON d.id=p.device_id
      WHERE p.account_id=? AND p.revoked_at IS NULL AND d.status='approved'`).all(accountId) as any[])
      .map((row) => row.fcm_token as string);
  }

  allPushTokens() {
    return (this.db.prepare(`SELECT DISTINCT p.fcm_token FROM push_tokens p
      JOIN devices d ON d.id=p.device_id JOIN accounts a ON a.id=p.account_id
      WHERE p.revoked_at IS NULL AND d.status='approved' AND a.status='active'`).all() as any[])
      .map((row) => row.fcm_token as string);
  }

  advanceCounter(accountId: string, kind: "device" | "host", principalId: string, stream: string, counter: number) {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT counter FROM message_counters
        WHERE account_id=? AND principal_kind=? AND principal_id=? AND stream=?`)
        .get(accountId, kind, principalId, stream) as { counter: number } | undefined;
      const expected = row ? Number(row.counter) + 1 : 0;
      if (counter !== expected) throw new RelayError("COUNTER_REJECTED", "消息计数器重复或乱序", { expected, received: counter });
      this.db.prepare(`INSERT INTO message_counters(account_id,principal_kind,principal_id,stream,counter,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,principal_kind,principal_id,stream) DO UPDATE SET
        counter=excluded.counter,updated_at=excluded.updated_at`).run(accountId, kind, principalId, stream, counter, now());
    });
  }

  private eventRow(accountId: string, hostId: string, eventId: string) {
    const row = this.db.prepare(`SELECT host_seq AS seq,host_id,device_id,channel_id,counter,kind,event_id,event_type,ciphertext,created_at
      FROM encrypted_events WHERE account_id=? AND host_id=? AND event_id=?`).get(accountId, hostId, eventId) as any;
    return row ? this.mapStoredEvent(row, accountId) : undefined;
  }

  private mapStoredEvent(row: any, accountId: string) {
    return {
      seq: row.seq,
      createdAt: row.created_at,
      envelope: {
        accountId,
        hostId: row.host_id,
        deviceId: row.device_id,
        channelId: row.channel_id,
        counter: row.counter,
        kind: row.kind,
        ciphertext: row.ciphertext,
        eventId: row.event_id,
        eventType: row.event_type,
      } satisfies CipherEnvelope,
    };
  }

  requireHost(accountId: string, hostId: string) {
    const host = this.db.prepare("SELECT id FROM hosts WHERE id=? AND account_id=? AND revoked_at IS NULL").get(hostId, accountId);
    if (!host) throw new RelayError("NOT_FOUND", "主机不存在");
  }

  audit(accountId: string | null, actorKind: string, actorId: string, action: string, targetKind?: string, targetId?: string, detail: unknown = {}) {
    this.db.prepare(`INSERT INTO audit_log(account_id,actor_kind,actor_id,action,target_kind,target_id,detail_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(accountId, actorKind, actorId, action, targetKind || null, targetId || null, JSON.stringify(detail), now());
  }

  auditRows(limit = 200) {
    return this.db.prepare("SELECT id,account_id,actor_kind,actor_id,action,target_kind,target_id,detail_json,created_at FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as any[];
  }
}
