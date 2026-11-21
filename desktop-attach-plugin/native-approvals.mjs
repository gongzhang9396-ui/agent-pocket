import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

// Internal Desktop follower protocol, independently implemented from the public
// wire contract. No app-server, UI automation, or writer acquisition is used.
export const DESKTOP_APPROVAL_CAPABILITY = "desktop-approval-v1";
const METHODS = new Map([
  ["item/commandExecution/requestApproval", "thread-follower-command-approval-decision"],
  ["item/fileChange/requestApproval", "thread-follower-file-approval-decision"],
]);
const DECISIONS = { allowOnce: "accept", deny: "decline", cancel: "cancel" };
// The supported local v1 command/file response contract has these three safe
// enum choices when the optional availableDecisions field is omitted. This is
// a version-pinned protocol default, not a fallback for unknown formats. Never
// infer session/persistent scope. FollowerConnection rejects other state versions.
const V11_LOCAL_V1_DEFAULTS = new Map([...METHODS.keys()].map((method) => [method, ["accept", "decline", "cancel"]]));
const MAX_FRAME = 16 * 1024 * 1024;
const MAX_APPROVAL_BYTES = 128 * 1024;
const FALLBACK = "此审批暂不能远程处理，请在 Desktop 完成审批";

export class NativeApprovalError extends Error {
  constructor(code, message, delivery = "not_sent") {
    super(message);
    this.code = code;
    this.delivery = delivery;
  }
}

function fail(code, message = FALLBACK) { throw new NativeApprovalError(code, message); }
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
function identifier(value) { return typeof value === "string" && value.length > 0 && value.length <= 128; }
function requestId(value) { return identifier(value) || (Number.isSafeInteger(value) && value >= 0); }
function pathKey(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("PATH_DENIED");
  try {
    const value = normalize(realpathSync.native(path)).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? value.toLowerCase() : value;
  } catch { fail("PATH_DENIED"); }
}

function orderedEntries(value) {
  if (Array.isArray(value)) return value;
  if (value?.entitiesByKey && Array.isArray(value.islands)) return value.islands.flatMap((island) =>
    (island.entries || []).flatMap((entry) => Object.hasOwn(value.entitiesByKey, entry.value) ? [value.entitiesByKey[entry.value]] : []));
  return Array.isArray(value?.items) ? value.items : [];
}
function relatedItem(state, id) {
  if (!id) return undefined;
  // Desktop's live turns can be an ordered array or a keyed collection.
  const turns = state.turnHistory?.kind === "canonical" ? orderedEntries(state.turnHistory.history) : orderedEntries(state.turns);
  for (const turn of turns) {
    const items = orderedEntries(turn?.items);
    const item = items.find((entry) => entry?.id === id);
    if (item) return { item, turnId: turn.turnId || turn.id };
  }
}

export function approvalSnapshot(state, ownerClientId, expectedThreadId, expectedCwd) {
  if (!state || state.id !== expectedThreadId || !identifier(ownerClientId)
    || pathKey(state.cwd) !== pathKey(expectedCwd) || !Array.isArray(state.requests)
    || state.requests.length > 100) fail("DESKTOP_STATE_UNAVAILABLE");
  const seen = new Set();
  const requests = state.requests.flatMap((raw) => {
    if (!raw || !requestId(raw.id) || typeof raw.method !== "string") fail("DESKTOP_STATE_UNAVAILABLE");
    // Other native interactions are outside this capability, not approvals.
    if (!raw.method.endsWith("/requestApproval")) return [];
    const identity = stable(raw.id);
    if (seen.has(identity)) fail("DESKTOP_STATE_UNAVAILABLE");
    seen.add(identity);
    const p = raw.params;
    if (!p || typeof p !== "object" || Array.isArray(p)) fail("DESKTOP_STATE_UNAVAILABLE");
    if ((p.threadId !== undefined && p.threadId !== expectedThreadId)
      || (p.conversationId !== undefined && p.conversationId !== expectedThreadId)) fail("DESKTOP_STATE_UNAVAILABLE");
    const related = relatedItem(state, p.itemId);
    const turnId = p.turnId || related?.turnId;
    const params = { threadId: expectedThreadId, turnId, itemId: p.itemId,
      reason: typeof p.reason === "string" ? p.reason : undefined, cwd: typeof p.cwd === "string" ? p.cwd : state.cwd, command: p.command || related?.item?.command,
      changes: p.changes || related?.item?.changes, grantRoot: typeof p.grantRoot === "string" ? p.grantRoot : undefined,
      networkApprovalContext: p.networkApprovalContext };
    // Never forward identity challenges or silently discard approval scopes.
    const verification = /userVerification/i.test(JSON.stringify(p)) || (p._meta != null && Object.keys(p._meta).length > 0);
    const decisions = p.availableDecisions === undefined ? V11_LOCAL_V1_DEFAULTS.get(raw.method) : p.availableDecisions;
    const allowedDecisions = Object.keys(DECISIONS).filter((key) => Array.isArray(decisions) && decisions.includes(DECISIONS[key]));
    const command = typeof params.command === "string" ? params.command.trim()
      : Array.isArray(params.command) && params.command.every((item) => typeof item === "string") ? params.command.join(" ").trim() : "";
    const complete = raw.method === "item/commandExecution/requestApproval" ? !!command
      : Array.isArray(params.changes) && params.changes.length > 0;
    const available = METHODS.has(raw.method) && !verification && identifier(turnId) && complete
      && allowedDecisions.length > 0 && Buffer.byteLength(JSON.stringify(params), "utf8") <= MAX_APPROVAL_BYTES;
    const fingerprint = createHash("sha256").update(stable({ ownerClientId, threadId: expectedThreadId,
      raw, related: related || null })).digest("hex");
    return [{ id: raw.id, method: raw.method, fingerprint, available,
      allowedDecisions: available ? allowedDecisions : [],
      params: available ? params : { threadId: expectedThreadId, reason: FALLBACK },
      ...(!available ? { unavailableReason: FALLBACK } : {}) }];
  });
  return { threadId: expectedThreadId, cwd: expectedCwd, ownerClientId, available: true, requests };
}

class FollowerConnection {
  constructor(path, timeoutMs) {
    this.path = path;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.clientId = null;
    this.sentDecision = false;
  }
  async connect() {
    await new Promise((resolve, reject) => {
      const socket = this.socket = net.createConnection(this.path);
      const timer = setTimeout(() => { socket.destroy(); reject(new NativeApprovalError("DESKTOP_UNAVAILABLE")); }, this.timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(new NativeApprovalError("DESKTOP_UNAVAILABLE")); });
      socket.on("data", (chunk) => this.data(chunk));
      socket.on("error", () => this.disconnect());
      socket.on("close", () => this.disconnect());
    });
    const response = await this.request("initialize", 0, { clientType: "agent-pocket" });
    if (!identifier(response.result?.clientId)) fail("DESKTOP_PROTOCOL_UNSUPPORTED");
    this.clientId = response.result.clientId;
  }
  send(message) {
    if (!this.socket || this.socket.destroyed) fail("DESKTOP_UNAVAILABLE");
    const payload = Buffer.from(JSON.stringify(message));
    if (!payload.length || payload.length > MAX_FRAME) fail("DESKTOP_PROTOCOL_UNSUPPORTED");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    this.socket.write(Buffer.concat([header, payload]));
  }
  request(method, version, params, targetClientId, mutation = false) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeApprovalError("DESKTOP_TIMEOUT", mutation ? "审批结果待确认，请刷新任务；不要重复提交" : FALLBACK, mutation ? "unknown" : "not_sent"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, targetClientId, mutation });
      try {
        if (mutation) this.sentDecision = true;
        this.send({ type: "request", requestId: id, sourceClientId: this.clientId, method, version, params,
          timeoutMs: this.timeoutMs, ...(targetClientId ? { targetClientId } : {}) });
      } catch (error) {
        clearTimeout(timer); this.pending.delete(id);
        reject(new NativeApprovalError(error.code || "DESKTOP_UNAVAILABLE", error.message, mutation ? "unknown" : "not_sent"));
      }
    });
  }
  data(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (!size || size > MAX_FRAME) fail("DESKTOP_PROTOCOL_UNSUPPORTED");
        if (this.buffer.length < size + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, size + 4).toString("utf8"));
        this.buffer = this.buffer.subarray(size + 4);
        if (message.type === "response") {
          const pending = this.pending.get(message.requestId);
          if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(message.requestId);
          if (message.resultType !== "success" || (pending.targetClientId && message.handledByClientId !== pending.targetClientId)) {
            pending.reject(new NativeApprovalError("DESKTOP_REJECTED", FALLBACK, pending.mutation ? "unknown" : "not_sent"));
          } else pending.resolve(message);
        } else if (message.type === "client-discovery-request") {
          this.send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
        } else if (message.type === "broadcast" && (!message.targetClientIds || message.targetClientIds.includes(this.clientId))) {
          this.event?.(message);
        }
      }
    } catch { this.disconnect(); this.socket?.destroy(); }
  }
  disconnect() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new NativeApprovalError("DESKTOP_DISCONNECTED", FALLBACK, pending.mutation ? "unknown" : "not_sent"));
    }
    this.pending.clear();
    this.rejectSnapshot?.(new NativeApprovalError("DESKTOP_DISCONNECTED", FALLBACK));
    this.valid = false;
  }
  follow(enabled) {
    this.send({ type: "broadcast", sourceClientId: this.clientId, method: "thread-stream-following-changed", version: 1,
      targetClientIds: [this.owner], params: { hostId: "local", conversationId: this.threadId, following: enabled } });
  }
  async snapshot(threadId, expectedCwd) {
    this.threadId = threadId;
    const discovery = await this.request("thread-owner-discovery", 1, { hostId: "local", conversationId: threadId });
    if (!identifier(discovery.handledByClientId)) fail("DESKTOP_STATE_UNAVAILABLE");
    this.owner = discovery.handledByClientId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new NativeApprovalError("DESKTOP_STATE_UNAVAILABLE")), this.timeoutMs);
      const finish = (error, value) => { clearTimeout(timer); this.rejectSnapshot = undefined; error ? reject(error) : resolve(value); };
      this.rejectSnapshot = (error) => finish(error);
      this.event = (message) => {
        if (message.method === "client-status-changed" && message.params?.clientId === this.owner && message.params?.status === "disconnected") {
          this.valid = false; finish(new NativeApprovalError("DESKTOP_STATE_UNAVAILABLE")); return;
        }
        if (message.method !== "thread-stream-state-changed" || message.sourceClientId !== this.owner
          || message.params?.hostId !== "local" || message.params?.conversationId !== threadId) return;
        // Each call requests a new snapshot. A patch invalidates it; never act
        // on a partially applied or stale native view. The next read resyncs.
        const change = message.params.change;
        if (message.version !== 11 || change?.type !== "snapshot" || !Number.isSafeInteger(change.revision)) {
          this.valid = false; finish(new NativeApprovalError("DESKTOP_STATE_UNAVAILABLE")); return;
        }
        try {
          this.current = approvalSnapshot(change.conversationState, this.owner, threadId, expectedCwd);
          this.valid = true; finish(undefined, this.current);
        } catch (error) { this.valid = false; finish(error); }
      };
      try { this.follow(true); } catch (error) { finish(error); }
    });
  }
  close() {
    if (this.owner && this.socket && !this.socket.destroyed) { try { this.follow(false); } catch {} }
    this.event = undefined;
    this.disconnect();
    this.socket?.destroy();
    this.current = undefined;
  }
}

export class DesktopNativeApprovals {
  constructor({ pipePath, timeoutMs = 2500 } = {}) {
    // Overrides are dependency injection for isolated tests, never remote RPC input.
    this.pipePath = pipePath || (process.platform === "win32" ? "\\\\.\\pipe\\codex-ipc" : undefined);
    this.timeoutMs = timeoutMs;
  }
  async withConnection(action) {
    if (!this.pipePath) fail("DESKTOP_UNAVAILABLE");
    const connection = new FollowerConnection(this.pipePath, this.timeoutMs);
    try { await connection.connect(); return await action(connection); }
    catch (error) {
      throw new NativeApprovalError(error instanceof NativeApprovalError ? error.code : "DESKTOP_UNAVAILABLE",
        error instanceof NativeApprovalError ? error.message : FALLBACK, connection.sentDecision ? "unknown" : "not_sent");
    }
    finally { connection.close(); }
  }
  probe() {
    return this.withConnection(async () => ({ connected: true, approvalVerified: false }));
  }
  read(threadId, cwd) {
    if (!identifier(threadId)) fail("INVALID_REQUEST");
    return this.withConnection(async (connection) => {
      await connection.snapshot(threadId, cwd);
      if (!connection.valid) fail("DESKTOP_STATE_UNAVAILABLE");
      return connection.current;
    });
  }
  async respond({ threadId, cwd, ownerClientId, requestId: id, fingerprint, decision }) {
    if (!identifier(threadId) || !identifier(ownerClientId) || !requestId(id)
      || !/^[a-f0-9]{64}$/.test(fingerprint || "") || !Object.hasOwn(DECISIONS, decision)) fail("INVALID_REQUEST");
    return this.withConnection(async (connection) => {
      await connection.snapshot(threadId, cwd);
      if (!connection.valid || connection.owner !== ownerClientId) fail("DESKTOP_APPROVAL_STALE", "任务归属或审批状态已变化，请刷新后确认");
      const request = connection.current.requests.find((entry) => entry.id === id);
      if (!request || request.fingerprint !== fingerprint) fail("DESKTOP_APPROVAL_STALE", "审批已处理、过期或内容变化，请刷新任务");
      if (!request.available || !request.allowedDecisions.includes(decision)) fail("DESKTOP_APPROVAL_UNSUPPORTED");
      await connection.request(METHODS.get(request.method), 1, { conversationId: threadId, requestId: id, decision: DECISIONS[decision] }, ownerClientId, true);
      return { ok: true, decision };
    });
  }
}
