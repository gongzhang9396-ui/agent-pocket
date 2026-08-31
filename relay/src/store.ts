import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const SCHEMA_VERSION = 1;

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
    if (schemaVersion === SCHEMA_VERSION) return;

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
      this.setMeta("schemaVersion", String(SCHEMA_VERSION));
    });
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

  createAccount(input: AccountInput) {
    const accountId = id();
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

  listAccounts() {
    return this.db.prepare(`SELECT id,username,display_name,role,status,created_at,disabled_at,
      (SELECT count(*) FROM devices d WHERE d.account_id=accounts.id AND d.status='approved') AS device_count,
      (SELECT count(*) FROM hosts h WHERE h.account_id=accounts.id AND h.revoked_at IS NULL) AS host_count
      FROM accounts ORDER BY created_at ASC`).all() as any[];
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

  findDeviceForLogin(accountId: string, deviceId: string | undefined, signingPublicKey: string, encryptionPublicKey: string, name: string) {
    if (!deviceId) {
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

  authenticateAccess(accessToken: string, allowPendingDevice = false) {
    const row = this.db.prepare(`SELECT s.*,a.role,a.status AS account_status,d.status AS device_status
      FROM sessions s JOIN accounts a ON a.id=s.account_id
      LEFT JOIN devices d ON s.principal_kind='device' AND d.id=s.principal_id
      WHERE s.access_hash=? AND s.revoked_at IS NULL AND s.access_expires_at>=?`).get(tokenHash(accessToken), now()) as any;
    if (!row || row.account_status !== "active") return undefined;
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
      this.db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(now(), row.id);
      return this.createSession(row.account_id, row.principal_kind, row.principal_id, true);
    });
  }

  startHostEnrollment(name: string, signingPublicKey: string, encryptionPublicKey: string, ttlMs = ENROLLMENT_TTL_MS) {
    const enrollment = { id: id(), secret: token(24), expiresAt: now() + ttlMs };
    this.db.prepare(`INSERT INTO host_enrollments(
      id,secret_hash,requested_name,signing_public_key,encryption_public_key,expires_at,created_at
    ) VALUES(?,?,?,?,?,?,?)`).run(enrollment.id, tokenHash(enrollment.secret), name, signingPublicKey, encryptionPublicKey, enrollment.expiresAt, now());
    return enrollment;
  }

  hostEnrollment(enrollmentId: string, secret: string) {
    const row = this.db.prepare(`SELECT id,requested_name,signing_public_key,encryption_public_key,expires_at,
      approved_account_id,approved_name,completed_at
      FROM host_enrollments WHERE id=? AND secret_hash=?`).get(enrollmentId, tokenHash(secret)) as any;
    if (!row || row.expires_at < now()) throw new RelayError("AUTH_FAILED", "主机绑定二维码无效或已过期");
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
      const changed = this.db.prepare(`UPDATE host_enrollments SET approved_by=?,approved_account_id=?,approved_name=?,key_package=?
        WHERE id=? AND approved_account_id IS NULL`).run(deviceId, accountId, name, keyPackage, enrollmentId);
      if (!changed.changes) throw new RelayError("CONFLICT", "主机绑定已经被其他账户批准");
      this.audit(accountId, "device", deviceId, "host.enroll.approve", "host_enrollment", enrollmentId);
    });
  }

  completeHostEnrollment(enrollmentId: string, secret: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM host_enrollments WHERE id=?").get(enrollmentId) as any;
      if (!row || row.completed_at || row.expires_at < now() || row.secret_hash !== tokenHash(secret) || !row.approved_account_id) {
        throw new RelayError("AUTH_FAILED", "主机绑定尚未批准或已经失效");
      }
      const hostId = id();
      const hostToken = token();
      this.db.prepare(`INSERT INTO hosts(
        id,account_id,name,signing_public_key,encryption_public_key,token_hash,created_at,last_seen_at
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        hostId, row.approved_account_id, row.approved_name || row.requested_name,
        row.signing_public_key, row.encryption_public_key, tokenHash(hostToken), now(), now(),
      );
      this.db.prepare("UPDATE host_enrollments SET completed_at=? WHERE id=?").run(now(), enrollmentId);
      const account = this.accountById(row.approved_account_id)!;
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

  eventsAfter(accountId: string, hostId: string, lastSeq: number) {
    this.requireHost(accountId, hostId);
    const bounds = this.db.prepare("SELECT min(host_seq) AS min_seq,max(host_seq) AS max_seq FROM encrypted_events WHERE account_id=? AND host_id=?")
      .get(accountId, hostId) as any;
    if (bounds?.min_seq && lastSeq > 0 && lastSeq < Number(bounds.min_seq) - 1) {
      throw new RelayError("EVENT_GAP", "事件游标已经过期", { minSeq: bounds.min_seq, maxSeq: bounds.max_seq });
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
