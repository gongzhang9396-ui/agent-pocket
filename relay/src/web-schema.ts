// Additive v3 migration: legacy account/device/Host wire formats remain v2.
export const WEB_SCHEMA = `
CREATE TABLE IF NOT EXISTS web_security (
 account_id TEXT PRIMARY KEY, credential_version INTEGER NOT NULL DEFAULT 0,
 totp_version INTEGER NOT NULL DEFAULT 0, totp_required INTEGER NOT NULL DEFAULT 0,
 totp_secret TEXT, totp_last_step INTEGER NOT NULL DEFAULT -1, recovery_hashes TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS web_key_packages (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id), version INTEGER NOT NULL,
 credential_version INTEGER NOT NULL, package_json TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS web_devices (
 device_id TEXT PRIMARY KEY REFERENCES devices(id), account_id TEXT NOT NULL REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS web_logins (
 token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 credential_version INTEGER NOT NULL, totp_version INTEGER NOT NULL,
 verified INTEGER NOT NULL DEFAULT 0, enrollment_secret TEXT,
 device_id TEXT, device_name TEXT, device_signing_public_key TEXT, device_encryption_public_key TEXT,
 signing_challenge TEXT, box_nonce TEXT, trusted INTEGER NOT NULL DEFAULT 1,
 proof INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS web_sessions (
 session_id TEXT PRIMARY KEY REFERENCES sessions(id), account_id TEXT NOT NULL REFERENCES accounts(id),
 credential_version INTEGER NOT NULL, totp_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS web_tickets (
 token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
 account_id TEXT NOT NULL REFERENCES accounts(id), device_id TEXT NOT NULL REFERENCES devices(id),
 expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS web_operations (
 account_id TEXT NOT NULL REFERENCES accounts(id), operation_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(account_id, operation_id)
);
`;

// Called inside the same transaction as a legacy password update/reset.
export function invalidateWebCredentials(db: import('node:sqlite').DatabaseSync, accountId: string) {
 db.prepare(`INSERT INTO web_security(account_id,credential_version) VALUES(?,1)
 ON CONFLICT(account_id) DO UPDATE SET credential_version=credential_version+1`).run(accountId);
 db.prepare('UPDATE web_key_packages SET stale=1 WHERE account_id=?').run(accountId);
 db.prepare(`UPDATE sessions SET revoked_at=? WHERE account_id=?
  AND principal_kind='device' AND principal_id IN (SELECT device_id FROM web_devices)
  AND revoked_at IS NULL`).run(Date.now(), accountId);
 db.prepare('DELETE FROM web_logins WHERE account_id=?').run(accountId);
 db.prepare('DELETE FROM web_tickets WHERE account_id=?').run(accountId);
}
