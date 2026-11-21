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

export type OperationStatus = "pending" | "succeeded" | "failed" | "unknown";

export type OperationRecord = {
  operationId: string;
  method: string;
  fingerprint: string;
  clientMessageId?: string;
  threadId?: string;
  backend?: string;
  owner?: string;
  agent?: string;
  status: OperationStatus;
  /** Alias retained for callers that describe the value as a state. */
  state: OperationStatus;
  result?: unknown;
  error?: unknown;
  createdAt: number;
  updatedAt: number;
};

type OperationInput = {
  operationId: string;
  method: string;
  fingerprint: string;
  clientMessageId?: string;
  threadId?: string;
  backend?: string;
  owner?: string;
  agent?: string;
};

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
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        client_message_id TEXT,
        thread_id TEXT,
        backend TEXT,
        owner TEXT,
        agent TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','unknown')),
        result_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operations_updated ON operations(updated_at);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
    `);
    const operationColumns = new Set((this.db.prepare("PRAGMA table_info(operations)").all() as any[]).map((column) => String(column.name)));
    for (const [name, definition] of [["client_message_id", "TEXT"], ["thread_id", "TEXT"], ["backend", "TEXT"], ["owner", "TEXT"], ["agent", "TEXT"]] as const) {
      if (!operationColumns.has(name)) this.db.exec(`ALTER TABLE operations ADD COLUMN ${name} ${definition}`);
    }
    // A pending mutation cannot be known to have completed after a process
    // restart. Fail closed so a retry can inspect the durable unknown state
    // instead of sending the mutation a second time.
    const restartError = JSON.stringify({ name: "OPERATION_UNKNOWN", detail: "Bridge 在操作完成前重启，结果尚不确定" });
    this.db.prepare("UPDATE operations SET status='unknown',error_json=?,updated_at=? WHERE status='pending'")
      .run(restartError, this.now());
  }

  operationRow(row: any): OperationRecord {
    const status = row.status as OperationStatus;
    return {
      operationId: String(row.operation_id), method: String(row.method),
      fingerprint: String(row.fingerprint), status, state: status,
      ...(row.client_message_id ? { clientMessageId: String(row.client_message_id) } : {}),
      ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
      ...(row.backend ? { backend: String(row.backend) } : {}),
      ...(row.owner ? { owner: String(row.owner) } : {}),
      ...(row.agent ? { agent: String(row.agent) } : {}),
      result: row.result_json === null || row.result_json === undefined ? undefined : JSON.parse(row.result_json),
      error: row.error_json === null || row.error_json === undefined ? undefined : JSON.parse(row.error_json),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }

  getOperation(operationId: string) {
    const row = this.db.prepare("SELECT * FROM operations WHERE operation_id=?").get(operationId) as any;
    return row ? this.operationRow(row) : undefined;
  }

  /**
   * Atomically records a new operation. Existing records are returned unchanged;
   * the dispatch layer compares their fingerprint before deciding whether to
   * replay, reject, or surface an uncertain result.
   */
  recordOperation(input: OperationInput): OperationRecord & { created: boolean };
  recordOperation(operationId: string, method: string, fingerprint: string): OperationRecord & { created: boolean };
  recordOperation(inputOrId: OperationInput | string, methodArg?: string, fingerprintArg?: string) {
    const input = typeof inputOrId === "string"
      ? { operationId: inputOrId, method: methodArg!, fingerprint: fingerprintArg! }
      : inputOrId;
    if (!input || !input.operationId || !input.method || !input.fingerprint) {
      throw new RpcError(ErrorName.INVALID_REQUEST, "操作记录参数无效");
    }
    this.db.exec("BEGIN IMMEDIATE");
    let created = false;
    try {
      let row = this.db.prepare("SELECT * FROM operations WHERE operation_id=?").get(input.operationId) as any;
      if (!row) {
        const at = this.now();
        this.db.prepare(`INSERT INTO operations(operation_id,method,fingerprint,client_message_id,thread_id,backend,owner,agent,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`).run(
          input.operationId, input.method, input.fingerprint, input.clientMessageId || null, input.threadId || null,
          input.backend || null, input.owner || null, input.agent || null, at, at,
        );
        row = this.db.prepare("SELECT * FROM operations WHERE operation_id=?").get(input.operationId) as any;
        created = true;
      } else if (row.method !== input.method || row.fingerprint !== input.fingerprint) {
        throw new RpcError("CONFLICT", "操作标识已用于不同请求", { operationId: input.operationId, method: input.method });
      }
      this.db.exec("COMMIT");
      return { ...this.operationRow(row), created };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateOperation(operationId: string, status: OperationStatus, value?: unknown): OperationRecord;
  updateOperation(operationId: string, update: { status?: OperationStatus; state?: OperationStatus; result?: unknown; response?: unknown; error?: unknown }): OperationRecord;
  updateOperation(operationId: string, statusOrUpdate: OperationStatus | { status?: OperationStatus; state?: OperationStatus; result?: unknown; response?: unknown; error?: unknown }, value?: unknown) {
    const current = this.getOperation(operationId);
    if (!current) throw new RpcError(ErrorName.NOT_FOUND, "操作记录不存在或已过期");
    const status = typeof statusOrUpdate === "string"
      ? statusOrUpdate
      : statusOrUpdate.status || statusOrUpdate.state;
    if (status !== "pending" && status !== "succeeded" && status !== "failed" && status !== "unknown") {
      throw new RpcError(ErrorName.INVALID_REQUEST, "操作状态无效");
    }
    const payload = typeof statusOrUpdate === "string" ? value
      : status === "succeeded" ? (statusOrUpdate.result ?? statusOrUpdate.response)
        : (statusOrUpdate.error ?? statusOrUpdate.result ?? statusOrUpdate.response);
    const resultJson = status === "succeeded" && payload !== undefined ? JSON.stringify(payload) : null;
    const errorJson = (status === "failed" || status === "unknown") && payload !== undefined ? JSON.stringify(payload) : null;
    // A terminal state wins over late duplicate completions. This also makes
    // retries after a process restart safe when two writers race to settle it.
    this.db.prepare(`UPDATE operations SET status=?,result_json=?,error_json=?,updated_at=?
      WHERE operation_id=? AND status='pending'`).run(status, resultJson, errorJson, this.now(), operationId);
    return this.getOperation(operationId)!;
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

  eventsForThread(threadId: string, type: string) {
    return this.db.prepare(`SELECT * FROM events
      WHERE thread_id=? AND type=? ORDER BY seq ASC`).all(threadId, type).map((row: any) => ({
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

  addPending(codexId: string | number, method: string, params: unknown, requestId = randomUUID()) {
    // Native approval and async question identities are durable: pruning one
    // could re-enable an already handled interaction after event retention.
    this.db.prepare(`DELETE FROM pending_requests WHERE created_at < ?
      AND method != 'desktop/asyncQuestion'
      AND (COALESCE(json_extract(params_json,'$.source'),'')!='desktop'
        OR json_type(params_json,'$.nativeApproval') IS NULL)`).run(this.now() - EVENT_MAX_AGE_MS);
    this.db.prepare(`INSERT OR IGNORE INTO pending_requests(request_id,codex_id,method,params_json,created_at)
      VALUES(?,?,?,?,?)`).run(requestId, String(codexId), method, JSON.stringify(params ?? {}), this.now());
    return requestId;
  }

  interactionsForThread(threadId: string, includeRequestIds: string[] = []) {
    const recent = this.db.prepare(`SELECT * FROM pending_requests WHERE json_extract(params_json,'$.threadId')=?
      AND (created_at>=? OR (resolved_at IS NULL AND json_extract(params_json,'$.source')='desktop'
        AND json_type(params_json,'$.nativeApproval')='object') OR (resolved_at IS NULL AND method='desktop/asyncQuestion'))
      ORDER BY created_at DESC LIMIT 100`).all(threadId, this.now() - EVENT_MAX_AGE_MS) as any[];
    const rows = new Map(recent.map((row) => [row.request_id, row]));
    // Fetch old resolved questions only when they appear on the current page;
    // keep the normal interaction snapshot bounded rather than replaying all history.
    const byId = this.db.prepare(`SELECT * FROM pending_requests WHERE request_id=?
      AND method='desktop/asyncQuestion' AND json_extract(params_json,'$.threadId')=?`);
    for (const id of new Set(includeRequestIds)) {
      if (!rows.has(id)) {
        const row = byId.get(id, threadId) as any;
        if (row) rows.set(id, row);
      }
    }
    return [...rows.values()].sort((a, b) => a.created_at - b.created_at)
      .map((row) => ({ ...row, params: JSON.parse(row.params_json), response: row.response_json ? JSON.parse(row.response_json) : undefined }));
  }

  pending(requestId: string) {
    const row = this.db.prepare("SELECT * FROM pending_requests WHERE request_id=?").get(requestId) as any;
    if (!row) throw new RpcError(ErrorName.NOT_FOUND, "请求不存在或已过期");
    return { ...row, params: JSON.parse(row.params_json), response: row.response_json ? JSON.parse(row.response_json) : undefined };
  }

  /** Reserve the native request itself, independently of the caller's operationId.
   * Persist BEFORE IPC: a crash leaves it unavailable, including after restart. */
  reserveDesktopApproval(requestId: string, decision: string) {
    const pending = this.pending(requestId);
    if (pending.params.source !== "desktop" || !pending.params.nativeApproval) {
      throw new RpcError(ErrorName.INVALID_REQUEST, "不是 Desktop 审批");
    }
    const response = { desktopApprovalState: "submitting", attemptedDecision: decision };
    const changed = this.db.prepare(`UPDATE pending_requests SET response_json=?
      WHERE request_id=? AND resolved_at IS NULL AND response_json IS NULL`).run(JSON.stringify(response), requestId);
    return { reserved: Number(changed.changes) === 1, pending: this.pending(requestId) };
  }

  activeDesktopApproval(threadId: string, nativeId: string | number) {
    const row = this.db.prepare(`SELECT request_id FROM pending_requests
      WHERE json_extract(params_json,'$.source')='desktop'
      AND json_extract(params_json,'$.threadId')=?
      AND json_extract(params_json,'$.nativeApproval.requestId')=?
      AND json_type(params_json,'$.nativeApproval.requestId')=?
      AND COALESCE(json_extract(params_json,'$.nativeAbsent'),0)!=1
      ORDER BY created_at DESC LIMIT 1`).get(threadId, nativeId, typeof nativeId === "string" ? "text" : "integer") as any;
    return row ? this.pending(row.request_id) : undefined;
  }

  markDesktopApprovalAbsent(requestId: string) {
    // CAS against submission: a concurrent refresh can never replace a
    // submitting/unknown result, including when two processes share this DB.
    this.db.prepare(`UPDATE pending_requests
      SET params_json=json_set(params_json,'$.nativeAbsent',1),
          resolved_at=COALESCE(resolved_at,?),
          response_json=COALESCE(response_json,'{"desktopApprovalState":"resolved_elsewhere"}')
      WHERE request_id=? AND json_extract(params_json,'$.source')='desktop'
      AND (response_json IS NULL OR json_extract(response_json,'$.desktopApprovalState') IN ('succeeded','resolved_elsewhere'))`)
      .run(this.now(), requestId);
  }

  settleDesktopApproval(requestId: string, state: "unknown" | "not_sent" | "succeeded", decision: string) {
    const row = this.pending(requestId);
    if (row.params.source !== "desktop" || row.response?.desktopApprovalState !== "submitting"
      || row.response?.attemptedDecision !== decision || row.resolved_at) return;
    const response = state === "not_sent" ? null : JSON.stringify(state === "succeeded"
      ? { desktopApprovalState: "succeeded", _pocketDecision: decision }
      : { desktopApprovalState: "unknown", attemptedDecision: decision });
    this.db.prepare(`UPDATE pending_requests SET response_json=?,resolved_at=?
      WHERE request_id=? AND resolved_at IS NULL AND response_json=?`)
      .run(response, state === "succeeded" ? this.now() : null, requestId, row.response_json);
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
