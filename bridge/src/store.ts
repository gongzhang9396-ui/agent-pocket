import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EVENT_MAX_AGE_MS,
  EVENT_MAX_ROWS,
  ErrorName,
  RpcError,
  type BridgeEvent,
} from "./protocol.ts";

function hashSecret(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function equalHash(left: string, right: string) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export class BridgeStore {
  db: DatabaseSync;
  now: () => number;

  constructor(path: string, now = () => Date.now()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairings (
        id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
        used_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL, thread_id TEXT, turn_id TEXT, at TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_tokens (
        device_id TEXT PRIMARY KEY REFERENCES devices(id), fcm_token TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_requests (
        request_id TEXT PRIMARY KEY, codex_id TEXT NOT NULL, method TEXT NOT NULL,
        params_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        resolved_at INTEGER, response_json TEXT
      );
      CREATE TABLE IF NOT EXISTS thread_owners (
        thread_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL CHECK(owner IN ('desktop','bridge')),
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
    `);
  }

  getMeta(key: string) {
    return this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value as string | undefined;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  hostId() {
    let id = this.getMeta("hostId");
    if (!id) {
      id = randomUUID();
      this.setMeta("hostId", id);
    }
    return id;
  }

  createPairing(ttlMs = 5 * 60 * 1000) {
    const id = randomUUID();
    // The manual fallback is copy/paste. Keeping the QR secret high entropy means
    // pairing is safe without owning a second rate-limit subsystem.
    const secret = randomBytes(16).toString("base64url");
    const expiresAt = this.now() + ttlMs;
    this.db.prepare("INSERT INTO pairings(id,secret_hash,expires_at,created_at) VALUES(?,?,?,?)")
      .run(id, hashSecret(secret), expiresAt, this.now());
    return { id, secret, expiresAt };
  }

  claimPairing(input: { pairingId: string; secret: string; deviceId?: string; deviceName?: string }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM pairings WHERE id=?").get(input.pairingId) as any;
      if (!row || row.used_at || row.expires_at < this.now() || !equalHash(row.secret_hash, hashSecret(input.secret))) {
        throw new RpcError(ErrorName.AUTH_FAILED, "配对码无效、已使用或已过期");
      }
      const token = randomBytes(32).toString("base64url");
      const deviceId = randomUUID();
      const name = (input.deviceName || "Android").slice(0, 100);
      this.db.prepare("INSERT INTO devices(id,name,token_hash,created_at,revoked_at) VALUES(?,?,?,?,NULL)")
        .run(deviceId, name, hashSecret(token), this.now());
      this.db.prepare("UPDATE pairings SET used_at=? WHERE id=? AND used_at IS NULL").run(this.now(), input.pairingId);
      this.db.exec("COMMIT");
      return { deviceId, token };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  authenticate(token: string) {
    if (!token) return undefined;
    return this.db.prepare("SELECT id,name,created_at FROM devices WHERE token_hash=? AND revoked_at IS NULL")
      .get(hashSecret(token)) as any;
  }

  listDevices() {
    return this.db.prepare("SELECT id,name,created_at,revoked_at FROM devices ORDER BY created_at DESC").all();
  }

  isDeviceActive(deviceId: string) {
    return Boolean(this.db.prepare("SELECT 1 ok FROM devices WHERE id=? AND revoked_at IS NULL").get(deviceId));
  }

  revokeDevice(deviceId: string) {
    const result = this.db.prepare("UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(this.now(), deviceId);
    return Number(result.changes) > 0;
  }

  registerPush(deviceId: string, token: string) {
    this.db.prepare(`INSERT INTO push_tokens(device_id,fcm_token,updated_at) VALUES(?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET fcm_token=excluded.fcm_token,updated_at=excluded.updated_at`)
      .run(deviceId, token, this.now());
  }

  pushTokens() {
    return this.db.prepare(`SELECT p.fcm_token FROM push_tokens p JOIN devices d ON d.id=p.device_id
      WHERE d.revoked_at IS NULL`).all().map((row: any) => row.fcm_token as string);
  }

  appendEvent(event: BridgeEvent) {
    const result = this.db.prepare(`INSERT INTO events(event_id,type,thread_id,turn_id,at,payload_json,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(
        event.eventId, event.type, event.threadId ?? null, event.turnId ?? null,
        event.at, JSON.stringify(event.payload ?? {}), this.now(),
      );
    this.pruneEvents();
    return { ...event, seq: Number(result.lastInsertRowid) };
  }

  pruneEvents() {
    this.db.prepare("DELETE FROM events WHERE created_at < ?").run(this.now() - EVENT_MAX_AGE_MS);
    this.db.prepare(`DELETE FROM events WHERE seq NOT IN (
      SELECT seq FROM events ORDER BY seq DESC LIMIT ?
    )`).run(EVENT_MAX_ROWS);
  }

  eventsAfter(lastSeq: number) {
    const bounds = this.db.prepare("SELECT MIN(seq) minSeq, MAX(seq) maxSeq FROM events").get() as any;
    if (bounds.minSeq && lastSeq > 0 && lastSeq < Number(bounds.minSeq) - 1) {
      throw new RpcError(ErrorName.EVENT_GAP, "事件历史已过期，需要完整同步", bounds);
    }
    return this.db.prepare("SELECT * FROM events WHERE seq>? ORDER BY seq ASC").all(lastSeq).map((row: any) => ({
      seq: Number(row.seq), eventId: row.event_id, type: row.type,
      threadId: row.thread_id ?? undefined, turnId: row.turn_id ?? undefined,
      at: row.at, payload: JSON.parse(row.payload_json),
    }));
  }

  latestSeq() {
    return Number((this.db.prepare("SELECT MAX(seq) seq FROM events").get() as any)?.seq || 0);
  }

  threadOwner(threadId: string) {
    return (this.db.prepare("SELECT owner FROM thread_owners WHERE thread_id=?").get(threadId) as any)?.owner as "desktop" | "bridge" | undefined;
  }

  claimThreadOwner(threadId: string, owner: "desktop" | "bridge") {
    this.db.prepare("INSERT OR IGNORE INTO thread_owners(thread_id,owner,updated_at) VALUES(?,?,?)")
      .run(threadId, owner, this.now());
    return this.threadOwner(threadId);
  }

  setThreadOwner(threadId: string, owner: "desktop" | "bridge") {
    this.db.prepare(`INSERT INTO thread_owners(thread_id,owner,updated_at) VALUES(?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET owner=excluded.owner,updated_at=excluded.updated_at`)
      .run(threadId, owner, this.now());
  }

  addPending(codexId: string | number, method: string, params: unknown) {
    this.db.prepare("DELETE FROM pending_requests WHERE created_at < ?").run(this.now() - EVENT_MAX_AGE_MS);
    const requestId = randomUUID();
    this.db.prepare(`INSERT INTO pending_requests(request_id,codex_id,method,params_json,created_at)
      VALUES(?,?,?,?,?)`).run(requestId, String(codexId), method, JSON.stringify(params ?? {}), this.now());
    return requestId;
  }

  pending(requestId: string) {
    const row = this.db.prepare("SELECT * FROM pending_requests WHERE request_id=?").get(requestId) as any;
    if (!row) throw new RpcError(ErrorName.NOT_FOUND, "请求不存在或已过期");
    return { ...row, params: JSON.parse(row.params_json), response: row.response_json ? JSON.parse(row.response_json) : undefined };
  }

  resolvePending(requestId: string, response: unknown) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.pending(requestId);
      if (row.resolved_at) {
        this.db.exec("COMMIT");
        return { duplicate: true, response: row.response };
      }
      const result = this.db.prepare("UPDATE pending_requests SET resolved_at=?,response_json=? WHERE request_id=? AND resolved_at IS NULL")
        .run(this.now(), JSON.stringify(response), requestId);
      this.db.exec("COMMIT");
      return Number(result.changes) === 1 ? { duplicate: false, response } : { duplicate: true, response: this.pending(requestId).response };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() { this.db.close(); }
}
