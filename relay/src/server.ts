import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { isIP } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import sodium from "libsodium-wrappers-sumo";
import { hashPassword, passwordOperationFingerprint, validatePassword, verifyPassword } from "./auth.js";
import type { RelayConfig } from "./config.js";
import { FcmNotifier } from "./fcm.js";
import {
  MAX_CIPHERTEXT_CHARS,
  MAX_KEY_PACKAGE_CHARS,
  RELAY_PROTOCOL_VERSION,
  RelayError,
  normalizeUsername,
  requiredString,
  token,
  tokenHash,
  validateEnvelope,
  validatePublicKey,
  type AccountRole,
  type CipherEnvelope,
} from "./protocol.js";
import { LoginThrottle } from "./rate-limit.js";
import { RelayStore, type UpdatePlatform } from "./store.js";
import { createRecoveryCodes, otpauthUri, randomTotpSecret, recoveryCodeHash, verifyTotp } from "./totp.js";
import { WebActivationService } from "./web-activation.js";

type RpcId = string | number;
type RpcRequest = { jsonrpc: "2.0"; id: RpcId; method: string; params?: unknown };
type DeviceSocket = {
  socket: WebSocket;
  accessToken?: string;
  webSessionId?: string;
  accountId: string;
  deviceId: string;
  hello: boolean;
};
type HostSocket = {
  socket: WebSocket;
  hostToken: string;
  accountId: string;
  hostId: string;
  hello: boolean;
};
type Channel = {
  accountId: string;
  hostId: string;
  deviceId: string;
  deviceCounter: number;
  hostCounter: number;
  createdAt: number;
  confirmed: boolean;
};

const JSON_LIMIT = 256 * 1024;
const WS_LIMIT = MAX_CIPHERTEXT_CHARS + 32 * 1024;
const CHANNEL_OPEN_TIMEOUT_MS = 30_000;
const MAX_CHANNELS = 10_000;
const MAX_CHANNELS_PER_DEVICE = 8;
const MAX_CHANNELS_PER_HOST = 64;
const MAX_DEVICE_WS_CONNECTIONS = 2_000;
const MAX_DEVICE_WS_CONNECTIONS_PER_DEVICE = 4;
const MAX_HOST_WS_CONNECTIONS = 2_000;
const MAX_WS_ATTEMPTS_PER_MINUTE = 120;
const MAX_WS_ATTEMPT_SOURCES = 5_000;
const UPDATE_MANIFEST_LIMIT = 16 * 1024;
const UPDATE_MAX_BYTES: Record<UpdatePlatform, number> = {
  android: 250 * 1024 * 1024,
  host: 512 * 1024 * 1024,
};
const UPDATE_VERSION = /^\d+\.\d+\.\d+$/;
const UPDATE_SHA256 = /^[0-9a-f]{64}$/;
const WEB_LOGIN_MAX = 64 * 1024;

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayError("INVALID_REQUEST", "请求参数必须是对象");
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, name: string, min = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < min) throw new RelayError("INVALID_REQUEST", `${name} 无效`);
  return Number(value);
}

function optionalString(value: unknown, name: string, max: number) {
  return value === undefined || value === null ? undefined : requiredString(value, name, max);
}

function parseCookies(req: IncomingMessage) {
  const result: Record<string, string> = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* Ignore malformed cookies. */ }
  }
  return result;
}

function bearer(req: IncomingMessage) {
  const header = req.headers.authorization;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header || "");
  return match?.[1];
}

function clientAddress(req: IncomingMessage) {
  const remote = (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
  const trustedLoopback = remote === "127.0.0.1" || remote === "::1";
  const forwarded = trustedLoopback
    ? (Array.isArray(req.headers["x-forwarded-for"]) ? req.headers["x-forwarded-for"][0] : req.headers["x-forwarded-for"])
    : undefined;
  const first = forwarded?.split(",", 1)[0]?.trim().replace(/^::ffff:/, "");
  return first && isIP(first) ? first : remote;
}

function equalText(left: string | undefined, right: string | undefined) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function base64Bytes(value: unknown, name: string) {
  const text = requiredString(value, name, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new RelayError("INVALID_REQUEST", `${name} 格式无效`);
  try { return sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING); }
  catch { throw new RelayError("INVALID_REQUEST", `${name} 格式无效`); }
}

function webPackage(value: unknown) {
  const text = requiredString(value, "packageJson", MAX_KEY_PACKAGE_CHARS);
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { throw new RelayError("INVALID_REQUEST", "网页密钥包 JSON 无效"); }
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1
    || typeof parsed.ciphertext !== "string" || typeof parsed.salt !== "string"
    || typeof parsed.nonce !== "string" || typeof parsed.accountPublicKeyFingerprint !== "string"
    || typeof parsed.kdf !== "object" || !Number.isSafeInteger(parsed.kdf.opsLimit)
    || !Number.isSafeInteger(parsed.kdf.memLimit) || !Number.isSafeInteger(parsed.kdf.algorithm)
    || parsed.algorithm !== "argon2id+xchacha20poly1305"
    || !/^[A-Za-z0-9_-]+$/.test(parsed.ciphertext) || !/^[A-Za-z0-9_-]+$/.test(parsed.salt)
    || !/^[A-Za-z0-9_-]+$/.test(parsed.nonce) || !/^[A-Za-z0-9_-]+$/.test(parsed.accountPublicKeyFingerprint)) {
    throw new RelayError("INVALID_REQUEST", "网页密钥包字段无效");
  }
  if (parsed.kdf.opsLimit < 1 || parsed.kdf.opsLimit > 10 || parsed.kdf.memLimit < 8 * 1024 * 1024 || parsed.kdf.memLimit > 256 * 1024 * 1024) {
    throw new RelayError("INVALID_REQUEST", "网页密钥包 KDF 参数超出允许范围");
  }
  return text;
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function readJson(req: IncomingMessage) {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > JSON_LIMIT) throw new RelayError("PAYLOAD_TOO_LARGE", "请求正文过大");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RelayError("INVALID_REQUEST", "JSON 格式无效"); }
}

function statusFor(error: RelayError) {
  if (error.nameCode === "AUTH_FAILED" || error.nameCode === "TOTP_REQUIRED") return 401;
  if (error.nameCode === "TOTP_ENROLLMENT_REQUIRED" || error.nameCode === "KEY_MIGRATION_REQUIRED") return 409;
  if (error.nameCode === "FORBIDDEN") return 403;
  if (error.nameCode === "NOT_FOUND") return 404;
  if (error.nameCode === "CONFLICT") return 409;
  if (error.nameCode === "ACCOUNT_ACTIVATION_REQUIRED") return 409;
  if (error.nameCode === "RATE_LIMITED") return 429;
  if (error.nameCode === "PAYLOAD_TOO_LARGE") return 413;
  return 400;
}

function webOrigin(req: IncomingMessage, publicUrl: string) {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  // Browsers commonly omit Origin on same-origin GETs. Read endpoints are bearer
  // authenticated and do not mutate state, so an absent Origin is acceptable only
  // for GET/HEAD; every state-changing web request remains origin-bound.
  if (!origin) {
    if (req.method === "GET" || req.method === "HEAD") return undefined;
    throw new RelayError("FORBIDDEN", "请求来源不受信任");
  }
  if (origin !== new URL(publicUrl).origin) throw new RelayError("FORBIDDEN", "请求来源不受信任");
  return origin;
}

function requireJsonContentType(req: IncomingMessage) {
  const value = Array.isArray(req.headers["content-type"]) ? req.headers["content-type"][0] : req.headers["content-type"];
  if (req.method === "POST" && value?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new RelayError("INVALID_REQUEST", "网页 API 只接受 application/json");
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(payload);
}

function rpcRequest(data: RawData): RpcRequest {
  let value: unknown;
  try { value = JSON.parse(data.toString()); }
  catch { throw new RelayError("INVALID_REQUEST", "JSON-RPC 格式无效"); }
  const raw = asObject(value);
  if (raw.jsonrpc !== "2.0" || (typeof raw.id !== "string" && typeof raw.id !== "number") || typeof raw.method !== "string") {
    throw new RelayError("INVALID_REQUEST", "JSON-RPC 请求无效");
  }
  return raw as RpcRequest;
}

function send(socket: WebSocket, value: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function result(socket: WebSocket, id: RpcId, value: unknown) {
  send(socket, { jsonrpc: "2.0", id, result: value });
}

function failure(socket: WebSocket, id: RpcId | null, error: unknown) {
  const relayError = error instanceof RelayError ? error : new RelayError("INTERNAL_ERROR", "Relay 内部错误");
  send(socket, { jsonrpc: "2.0", id, error: { code: relayError.nameCode, message: relayError.message, data: relayError.data } });
}

function notification(socket: WebSocket, method: string, params: unknown) {
  send(socket, { jsonrpc: "2.0", method, params });
}

export class RelayServer {
  private readonly http = createServer((req, res) => void this.onHttp(req, res));
  private readonly deviceWss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_LIMIT,
    handleProtocols: (protocols) => protocols.has("agentpocket.device.v1") ? "agentpocket.device.v1" : false,
  });
  private readonly hostWss = new WebSocketServer({ noServer: true, maxPayload: WS_LIMIT });
  private readonly devices = new Map<string, Set<DeviceSocket>>();
  private readonly hosts = new Map<string, HostSocket>();
  private readonly channels = new Map<string, Channel>();
  private readonly throttle: LoginThrottle;
  private readonly accountThrottle: LoginThrottle;
  private readonly sourceThrottle: LoginThrottle;
  private readonly enrollmentThrottle: LoginThrottle;
  private readonly webTotpThrottle: LoginThrottle;
  private readonly webTotpAttempts = new Map<string, { startedAt: number; count: number }>();
  private readonly webPasswordChanges = new Set<string>();
  private readonly webActivation: WebActivationService;
  private readonly wsAttempts = new Map<string, { startedAt: number; count: number }>();
  private updateDownloadCount = 0;
  private readonly updateDownloadsByPrincipal = new Map<string, number>();
  private readonly updateDownloadAttempts = new Map<string, { startedAt: number; count: number }>();
  private readonly updateVerificationCache = new Map<string, { fingerprint: string; sha256: string }>();
  private readonly updateVerificationsInFlight = new Map<string, Promise<string>>();
  private updateReleaseTimer?: NodeJS.Timeout;
  private readonly knownUpdateVersions = new Map<UpdatePlatform, string>();
  private stopping = false;
  private stopPromise?: Promise<void>;

  constructor(
    readonly config: RelayConfig,
    readonly store: RelayStore,
    readonly fcm = new FcmNotifier(config.firebaseServiceAccount),
  ) {
    this.throttle = new LoginThrottle({ persistent: store });
    this.accountThrottle = new LoginThrottle({ maxEntries: 10_000, freeFailures: 10, persistent: store });
    this.sourceThrottle = new LoginThrottle({ maxEntries: 5_000, freeFailures: 30, persistent: store });
    this.enrollmentThrottle = new LoginThrottle({ maxEntries: 5_000, freeFailures: 10, persistent: store });
    this.webTotpThrottle = new LoginThrottle({ maxEntries: 10_000, freeFailures: 5, persistent: store });
    this.webActivation = new WebActivationService(store, new URL(config.publicUrl).origin, webPackage);
    this.http.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
    this.deviceWss.on("connection", (socket: WebSocket, request: IncomingMessage, principal: DeviceSocket) => this.onDeviceConnected(socket, request, principal));
    this.hostWss.on("connection", (socket: WebSocket, request: IncomingMessage, principal: HostSocket) => this.onHostConnected(socket, request, principal));
  }

  async start() {
    if (this.stopping) throw new Error("RelayServer instances cannot be restarted after stop");
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.config.port, this.config.bindHost, () => {
        this.http.off("error", reject);
        resolve();
      });
    });
    for (const platform of ["android", "host"] as const) {
      const current = this.store.latestUpdate(platform);
      if (current) this.knownUpdateVersions.set(platform, current.version);
    }
    this.updateReleaseTimer = setInterval(() => this.checkPublishedUpdates(), 30_000);
    this.updateReleaseTimer.unref();
  }

  address() {
    const address = this.http.address();
    if (!address || typeof address === "string") return undefined;
    return { host: address.address, port: address.port };
  }

  stop() {
    this.stopPromise ||= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce() {
    this.stopping = true;
    if (this.updateReleaseTimer) clearInterval(this.updateReleaseTimer);
    this.updateReleaseTimer = undefined;
    for (const sessions of this.devices.values()) for (const session of sessions) session.socket.close(1001, "Relay stopping");
    for (const session of this.hosts.values()) session.socket.close(1001, "Relay stopping");
    const websocketServersClosed = Promise.all([
      new Promise<void>((resolve) => this.deviceWss.close(() => resolve())),
      new Promise<void>((resolve) => this.hostWss.close(() => resolve())),
    ]);

    const terminateConnections = () => {
      for (const socket of this.deviceWss.clients) socket.terminate();
      for (const socket of this.hostWss.clients) socket.terminate();
      this.http.closeIdleConnections();
      this.http.closeAllConnections();
    };
    const httpClosed = new Promise<void>((resolve, reject) => {
      this.http.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
    });
    const forceTimer = setTimeout(terminateConnections, 1_000);
    forceTimer.unref();
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(() => {
        terminateConnections();
        resolve();
      }, 5_000);
    });
    try {
      await Promise.race([Promise.all([httpClosed, websocketServersClosed]), deadline]);
    } finally {
      clearTimeout(forceTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      terminateConnections();
    }
  }

  private onUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) {
    if (this.stopping) {
      socket.destroy();
      return;
    }
    try {
      this.consumeWebSocketAttempt(req);
      const pathname = new URL(req.url || "/", this.config.publicUrl).pathname;
      const authToken = bearer(req);
      if (pathname === "/ws/device") {
        let principal: any;
        let webSessionId: string | undefined;
        if (authToken) {
          principal = this.store.authenticateAccess(authToken);
          if (!principal || principal.principal_kind !== "device") throw new RelayError("AUTH_FAILED", "设备令牌无效");
          // Browser devices must establish their WebSocket through a short-lived
          // ticket. Keeping bearer-authenticated sockets for legacy Android
          // devices only makes the web session binding explicit and ensures
          // account/session revocation can close every browser connection.
          if (this.store.db.prepare("SELECT 1 FROM web_devices WHERE device_id=?").get(principal.principal_id)) {
            throw new RelayError("FORBIDDEN", "网页设备必须使用一次性 WebSocket 票据");
          }
        } else {
          const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
          if (origin !== new URL(this.config.publicUrl).origin) throw new RelayError("FORBIDDEN", "网页 WebSocket 来源不受信任");
          const protocols = String(req.headers["sec-websocket-protocol"] || "").split(",").map((value) => value.trim()).filter(Boolean);
          if (!protocols.includes("agentpocket.device.v1")) throw new RelayError("AUTH_FAILED", "缺少网页 WebSocket 票据");
          const ticket = protocols.find((value) => value !== "agentpocket.device.v1");
          if (!ticket) throw new RelayError("AUTH_FAILED", "网页 WebSocket 票据无效");
          const consumed = this.store.consumeWebTicket(ticket);
          principal = consumed.session;
          webSessionId = consumed.session.id;
        }
        const deviceConnectionCount = [...this.devices.values()].reduce((total, sessions) => total + sessions.size, 0);
        if (deviceConnectionCount >= MAX_DEVICE_WS_CONNECTIONS
          || (this.devices.get(principal.principal_id)?.size || 0) >= MAX_DEVICE_WS_CONNECTIONS_PER_DEVICE) {
          throw new RelayError("CAPACITY_EXCEEDED", "设备连接数量已达上限");
        }
        const session: DeviceSocket = {
          socket: undefined as unknown as WebSocket,
          accessToken: authToken,
          webSessionId,
          accountId: principal.account_id,
          deviceId: principal.principal_id,
          hello: false,
        };
        this.deviceWss.handleUpgrade(req, socket, head, (ws) => {
          session.socket = ws;
          this.deviceWss.emit("connection", ws, req, session);
        });
        return;
      }
      if (pathname === "/ws/host") {
        if (!authToken) throw new RelayError("AUTH_FAILED", "缺少访问令牌");
        const principal = this.store.authenticateHost(authToken);
        if (!principal) throw new RelayError("AUTH_FAILED", "主机令牌无效");
        if (!this.hosts.has(principal.id) && this.hosts.size >= MAX_HOST_WS_CONNECTIONS) {
          throw new RelayError("CAPACITY_EXCEEDED", "主机连接数量已达上限");
        }
        const session: HostSocket = {
          socket: undefined as unknown as WebSocket,
          hostToken: authToken,
          accountId: principal.account_id,
          hostId: principal.id,
          hello: false,
        };
        this.hostWss.handleUpgrade(req, socket, head, (ws) => {
          session.socket = ws;
          this.hostWss.emit("connection", ws, req, session);
        });
        return;
      }
      throw new RelayError("NOT_FOUND", "WebSocket 路径不存在");
    } catch (error) {
      const relayError = error instanceof RelayError ? error : new RelayError("AUTH_FAILED", "WebSocket 连接失败");
      const status = relayError.nameCode === "RATE_LIMITED" ? "429 Too Many Requests"
        : relayError.nameCode === "CAPACITY_EXCEEDED" ? "503 Service Unavailable"
          : "401 Unauthorized";
      const retryAfter = relayError.nameCode === "RATE_LIMITED" ? "Retry-After: 60\r\n" : "";
      socket.write(`HTTP/1.1 ${status}\r\n${retryAfter}Connection: close\r\n\r\n`);
      socket.destroy();
    }
  }

  private consumeWebSocketAttempt(req: IncomingMessage) {
    const at = Date.now();
    const source = clientAddress(req);
    const current = this.wsAttempts.get(source);
    if (!current || at - current.startedAt >= 60_000) {
      this.wsAttempts.set(source, { startedAt: at, count: 1 });
    } else {
      if (current.count >= MAX_WS_ATTEMPTS_PER_MINUTE) throw new RelayError("RATE_LIMITED", "WebSocket 连接尝试过于频繁");
      current.count += 1;
    }
    if (this.wsAttempts.size > MAX_WS_ATTEMPT_SOURCES) {
      for (const [key, value] of this.wsAttempts) {
        if (at - value.startedAt >= 60_000) this.wsAttempts.delete(key);
        if (this.wsAttempts.size <= MAX_WS_ATTEMPT_SOURCES) break;
      }
    }
  }

  private onDeviceConnected(socket: WebSocket, _request: IncomingMessage, session: DeviceSocket) {
    const sessions = this.devices.get(session.deviceId) || new Set<DeviceSocket>();
    sessions.add(session);
    this.devices.set(session.deviceId, sessions);
    this.store.audit(session.accountId, "device", session.deviceId, "ws.connect", "device", session.deviceId);
    socket.on("message", (data) => void this.onDeviceMessage(session, data));
    socket.on("close", () => {
      sessions.delete(session);
      if (!sessions.size) this.devices.delete(session.deviceId);
      this.closeChannelsForDevice(session.deviceId);
    });
  }

  private onHostConnected(socket: WebSocket, _request: IncomingMessage, session: HostSocket) {
    const previous = this.hosts.get(session.hostId);
    if (previous) {
      // Channel crypto state belongs to the old Host connection. Its close
      // callback cannot clean these after the replacement occupies hosts[],
      // so drain them before swapping sessions to avoid exhausting quotas.
      this.closeChannelsForHost(session.hostId);
      previous.socket.close(4001, "Host reconnected");
    }
    this.hosts.set(session.hostId, session);
    this.store.touchHost(session.accountId, session.hostId);
    this.store.audit(session.accountId, "host", session.hostId, "ws.connect", "host", session.hostId);
    socket.on("message", (data) => void this.onHostMessage(session, data));
    socket.on("close", () => {
      if (this.hosts.get(session.hostId) === session) {
        this.hosts.delete(session.hostId);
        this.closeChannelsForHost(session.hostId);
        this.broadcastHostStatus(session.accountId, session.hostId, false);
      }
    });
  }

  private async onDeviceMessage(session: DeviceSocket, data: RawData) {
    let request: RpcRequest | undefined;
    try {
      request = rpcRequest(data);
      const principal = session.webSessionId
        ? this.store.webSessionById(session.webSessionId)
        : session.accessToken ? this.store.authenticateAccess(session.accessToken) : undefined;
      if (!principal || principal.account_id !== session.accountId || principal.principal_id !== session.deviceId) {
        session.socket.close(4003, "Device access expired or revoked");
        return;
      }
      if (!session.hello && request.method !== "relay/hello") throw new RelayError("HELLO_REQUIRED", "请先发送 relay/hello");
      result(session.socket, request.id, await this.dispatchDevice(session, request.method, request.params));
    } catch (error) {
      failure(session.socket, request?.id ?? null, error);
    }
  }

  private async onHostMessage(session: HostSocket, data: RawData) {
    let request: RpcRequest | undefined;
    try {
      request = rpcRequest(data);
      const principal = this.store.authenticateHost(session.hostToken);
      if (!principal || principal.account_id !== session.accountId || principal.id !== session.hostId) {
        session.socket.close(4003, "Host revoked");
        return;
      }
      if (this.hosts.get(session.hostId) !== session) {
        session.socket.close(4001, "Host connection replaced");
        return;
      }
      if (!session.hello && request.method !== "relay/hello") throw new RelayError("HELLO_REQUIRED", "请先发送 relay/hello");
      result(session.socket, request.id, await this.dispatchHost(session, request.method, request.params));
    } catch (error) {
      failure(session.socket, request?.id ?? null, error);
    }
  }

  private async dispatchDevice(session: DeviceSocket, method: string, value: unknown) {
    const params = asObject(value || {});
    if (method === "relay/hello") {
      if (integer(params.protocolVersion, "protocolVersion") !== RELAY_PROTOCOL_VERSION) {
        throw new RelayError("VERSION_UNSUPPORTED", "Relay 协议版本不兼容");
      }
      session.hello = true;
      return { protocolVersion: RELAY_PROTOCOL_VERSION, accountId: session.accountId, deviceId: session.deviceId, capabilities: ["event-replay-paged-v1"] };
    }
    if (method === "host/list") {
      return this.store.listHosts(session.accountId).map((host) => ({
        id: host.id,
        name: host.name,
        signingPublicKey: host.signing_public_key,
        encryptionPublicKey: host.encryption_public_key,
        createdAt: host.created_at,
        lastSeenAt: host.last_seen_at,
        online: this.hosts.get(host.id)?.hello === true,
      }));
    }
    if (method === "host/enroll/approve") {
      this.store.approveHostEnrollment(
        session.accountId,
        session.deviceId,
        requiredString(params.enrollmentId, "enrollmentId", 64),
        requiredString(params.secret, "secret", 128),
        requiredString(params.name, "name", 80),
        requiredString(params.keyPackage, "keyPackage", MAX_KEY_PACKAGE_CHARS),
      );
      return { approved: true };
    }
    if (method === "host/enroll/inspect") {
      return this.store.hostEnrollment(
        requiredString(params.enrollmentId, "enrollmentId", 64),
        requiredString(params.secret, "secret", 128),
      );
    }
    if (method === "device/list") return this.store.listDevices(session.accountId);
    if (method === "device/approve") {
      this.store.approveDevice(
        session.accountId,
        requiredString(params.deviceId, "deviceId", 64),
        requiredString(params.keyPackage, "keyPackage", MAX_KEY_PACKAGE_CHARS),
        session.deviceId,
      );
      return { approved: true };
    }
    if (method === "device/revoke") {
      const deviceId = requiredString(params.deviceId, "deviceId", 64);
      this.store.revokeDevice(session.accountId, deviceId, session.deviceId);
      this.closeDeviceSockets(deviceId, "Device revoked");
      return { revoked: true };
    }
    if (method === "host/revoke") {
      const hostId = requiredString(params.hostId, "hostId", 64);
      this.store.revokeHost(session.accountId, hostId, session.deviceId);
      this.hosts.get(hostId)?.socket.close(4003, "Host revoked");
      return { revoked: true };
    }
    if (method === "push/register") {
      this.store.registerPush(
        session.accountId,
        session.deviceId,
        requiredString(params.installationId, "installationId", 128),
        requiredString(params.fcmToken, "fcmToken", 4096),
      );
      return { registered: true };
    }
    if (method === "snapshot/get") {
      return this.store.snapshot(session.accountId, requiredString(params.hostId, "hostId", 64)) ?? null;
    }
    if (method === "event/replay") {
      return this.store.eventsAfter(
        session.accountId,
        requiredString(params.hostId, "hostId", 64),
        integer(params.lastSeq ?? 0, "lastSeq"),
        params.limit === undefined ? undefined : integer(params.limit, "limit", 1),
      );
    }
    if (method === "event/get") {
      return this.store.storedEvent(
        session.accountId,
        requiredString(params.hostId, "hostId", 64),
        requiredString(params.eventId, "eventId", 128),
      ) ?? null;
    }
    if (method === "channel/open" || method === "channel/data" || method === "channel/close") {
      return this.routeDeviceEnvelope(session, method, validateEnvelope(params.envelope));
    }
    throw new RelayError("METHOD_NOT_FOUND", `未知方法: ${method}`);
  }

  private async dispatchHost(session: HostSocket, method: string, value: unknown) {
    const params = asObject(value || {});
    if (method === "relay/hello") {
      if (integer(params.protocolVersion, "protocolVersion") !== RELAY_PROTOCOL_VERSION) {
        throw new RelayError("VERSION_UNSUPPORTED", "Relay 协议版本不兼容");
      }
      const hostId = optionalString(params.hostId, "hostId", 64);
      if (hostId && hostId !== session.hostId) throw new RelayError("FORBIDDEN", "主机身份不匹配");
      session.hello = true;
      this.store.touchHost(session.accountId, session.hostId);
      this.broadcastHostStatus(session.accountId, session.hostId, true);
      return { protocolVersion: RELAY_PROTOCOL_VERSION, accountId: session.accountId, hostId: session.hostId };
    }
    if (method === "snapshot/put") {
      const envelope = validateEnvelope(params.envelope);
      this.requireHostEnvelope(session, envelope, "snapshot.put");
      const existing = this.store.snapshot(session.accountId, session.hostId);
      if (existing?.envelope.counter === envelope.counter && existing.envelope.ciphertext === envelope.ciphertext) {
        return { stored: false, duplicate: true };
      }
      this.store.advanceCounter(session.accountId, "host", session.hostId, "snapshot", envelope.counter);
      this.store.putSnapshot(envelope);
      this.broadcastAccount(session.accountId, "snapshot/updated", {
        hostId: session.hostId,
        revision: envelope.counter,
        at: new Date().toISOString(),
      });
      return { stored: true };
    }
    if (method === "event/append") {
      const envelope = validateEnvelope(params.envelope);
      this.requireHostEnvelope(session, envelope, "event.append");
      const existing = this.store.storedEvent(session.accountId, session.hostId, envelope.eventId!);
      if (existing) {
        if (existing.envelope.counter !== envelope.counter || existing.envelope.ciphertext !== envelope.ciphertext) {
          throw new RelayError("CONFLICT", "eventId 已被不同密文占用");
        }
        return { stored: false, duplicate: true, seq: existing.seq };
      }
      this.store.advanceCounter(session.accountId, "host", session.hostId, "events", envelope.counter);
      const stored = this.store.appendEvent(envelope);
      if (stored) {
        this.broadcastAccount(session.accountId, "relay/event", stored);
        void this.fcm.send(this.store.pushTokens(session.accountId), {
          hostId: session.hostId,
          eventId: envelope.eventId!,
          type: envelope.eventType!,
        }).catch((error) => console.error("FCM send failed", error));
      }
      return { stored: Boolean(stored), seq: stored?.seq };
    }
    if (method === "channel/open" || method === "channel/data" || method === "channel/close") {
      return this.routeHostEnvelope(session, method, validateEnvelope(params.envelope));
    }
    throw new RelayError("METHOD_NOT_FOUND", `未知方法: ${method}`);
  }

  private routeDeviceEnvelope(session: DeviceSocket, method: string, envelope: CipherEnvelope) {
    this.requireEnvelopeIdentity(envelope, session.accountId, session.deviceId);
    const expectedKind = method.replace("/", ".") as CipherEnvelope["kind"];
    if (envelope.kind !== expectedKind) throw new RelayError("INVALID_REQUEST", "方法与信封类型不匹配");
    this.store.requireHost(session.accountId, envelope.hostId);
    const host = this.hosts.get(envelope.hostId);
    if (!host?.hello || host.socket.readyState !== WebSocket.OPEN) throw new RelayError("HOST_OFFLINE", "目标电脑当前离线");
    if (method === "channel/open") {
      this.pruneChannels();
      if (envelope.counter !== 0) throw new RelayError("COUNTER_REJECTED", "新通道 counter 必须从 0 开始");
      if (this.channels.has(envelope.channelId)) throw new RelayError("CONFLICT", "通道已经存在");
      if (this.channels.size >= MAX_CHANNELS
        || [...this.channels.values()].filter((channel) => channel.deviceId === session.deviceId).length >= MAX_CHANNELS_PER_DEVICE
        || [...this.channels.values()].filter((channel) => channel.hostId === envelope.hostId).length >= MAX_CHANNELS_PER_HOST) {
        throw new RelayError("RATE_LIMITED", "加密通道数量已达上限");
      }
      this.channels.set(envelope.channelId, {
        accountId: session.accountId,
        hostId: envelope.hostId,
        deviceId: session.deviceId,
        deviceCounter: 0,
        hostCounter: -1,
        createdAt: Date.now(),
        confirmed: false,
      });
    } else {
      const channel = this.requireChannel(envelope, session.accountId, envelope.hostId, session.deviceId);
      if (method === "channel/data" && !channel.confirmed) throw new RelayError("CONFLICT", "加密通道握手尚未完成");
      const expected = channel.deviceCounter + 1;
      if (envelope.counter !== expected) throw new RelayError("COUNTER_REJECTED", "手机消息重复或乱序", { expected });
      channel.deviceCounter = envelope.counter;
    }
    const peer = this.store.deviceById(session.accountId, session.deviceId);
    if (!peer || peer.status !== "approved") throw new RelayError("AUTH_FAILED", "设备已撤销或不存在");
    notification(host.socket, method, {
      envelope,
      peer: {
        id: peer.id,
        signingPublicKey: peer.signing_public_key,
        encryptionPublicKey: peer.encryption_public_key,
      },
    });
    if (method === "channel/close") this.channels.delete(envelope.channelId);
    return { forwarded: true };
  }

  private routeHostEnvelope(session: HostSocket, method: string, envelope: CipherEnvelope) {
    this.requireHostEnvelope(session, envelope, method.replace("/", ".") as CipherEnvelope["kind"]);
    const channel = this.requireChannel(envelope, session.accountId, session.hostId, envelope.deviceId);
    if (method !== "channel/open" && !channel.confirmed) throw new RelayError("CONFLICT", "加密通道握手尚未完成");
    const targets = this.devices.get(channel.deviceId);
    const readyTargets = targets
      ? [...targets].filter((target) => target.hello && target.socket.readyState === WebSocket.OPEN)
      : [];
    if (!readyTargets.length) throw new RelayError("DEVICE_OFFLINE", "目标手机当前离线");
    const expected = channel.hostCounter + 1;
    if (envelope.counter !== expected) throw new RelayError("COUNTER_REJECTED", "主机消息重复或乱序", { expected });
    channel.hostCounter = envelope.counter;
    if (method === "channel/open") channel.confirmed = true;
    for (const target of readyTargets) notification(target.socket, method, { envelope });
    if (method === "channel/close") this.channels.delete(envelope.channelId);
    return { forwarded: true };
  }

  private requireEnvelopeIdentity(envelope: CipherEnvelope, accountId: string, deviceId: string) {
    if (envelope.accountId !== accountId || envelope.deviceId !== deviceId) {
      throw new RelayError("FORBIDDEN", "加密信封身份与登录设备不匹配");
    }
  }

  private requireHostEnvelope(session: HostSocket, envelope: CipherEnvelope, kind: CipherEnvelope["kind"]) {
    if (envelope.accountId !== session.accountId || envelope.hostId !== session.hostId || envelope.kind !== kind) {
      throw new RelayError("FORBIDDEN", "加密信封身份与登录主机不匹配");
    }
    if ((kind === "snapshot.put" || kind === "event.append") && envelope.deviceId !== session.hostId) {
      throw new RelayError("FORBIDDEN", "Host 广播信封的 deviceId 必须等于 hostId");
    }
  }

  private requireChannel(envelope: CipherEnvelope, accountId: string, hostId: string, deviceId: string) {
    const channel = this.channels.get(envelope.channelId);
    if (!channel || channel.accountId !== accountId || channel.hostId !== hostId || channel.deviceId !== deviceId) {
      throw new RelayError("NOT_FOUND", "加密通道不存在或不属于当前身份");
    }
    return channel;
  }

  private closeChannelsForDevice(deviceId: string) {
    if (this.devices.has(deviceId)) return;
    for (const [channelId, channel] of this.channels) {
      if (channel.deviceId !== deviceId) continue;
      this.channels.delete(channelId);
      const host = this.hosts.get(channel.hostId);
      if (host) notification(host.socket, "channel/close", { channelId, reason: "device_disconnected" });
    }
  }

  private closeChannelsForHost(hostId: string) {
    for (const [channelId, channel] of this.channels) {
      if (channel.hostId !== hostId) continue;
      this.channels.delete(channelId);
      const targets = this.devices.get(channel.deviceId);
      if (targets) for (const target of targets) notification(target.socket, "channel/close", { channelId, reason: "host_disconnected" });
    }
  }

  private pruneChannels(at = Date.now()) {
    for (const [channelId, channel] of this.channels) {
      if (!channel.confirmed && at - channel.createdAt > CHANNEL_OPEN_TIMEOUT_MS) this.channels.delete(channelId);
    }
  }

  private broadcastAccount(accountId: string, method: string, params: unknown) {
    for (const sessions of this.devices.values()) {
      for (const session of sessions) if (session.accountId === accountId && session.hello) notification(session.socket, method, params);
    }
  }

  private closeAccountSockets(accountId: string, reason: string, keepWebSessionId?: string, webOnly = false) {
    for (const sessions of this.devices.values()) {
      for (const session of sessions) {
        if (session.accountId !== accountId) continue;
        if (webOnly && !session.webSessionId) continue;
        if (keepWebSessionId && session.webSessionId === keepWebSessionId) continue;
        session.socket.close(4003, reason);
      }
    }
  }

  private closeDeviceSockets(deviceId: string, reason: string) {
    const sessions = this.devices.get(deviceId);
    if (sessions) for (const session of sessions) session.socket.close(4003, reason);
  }

  private assertWebTotpAttempt(loginToken: string) {
    const now = Date.now();
    const current = this.webTotpAttempts.get(loginToken);
    if (!current || now - current.startedAt >= 5 * 60_000) { this.webTotpAttempts.set(loginToken, { startedAt: now, count: 0 }); return; }
    if (current.count >= 8) throw new RelayError("RATE_LIMITED", "验证码尝试次数过多，请重新登录", { retryAfterMs: Math.max(1, 5 * 60_000 - (now - current.startedAt)) });
  }

  private failedWebTotp(loginToken: string) {
    const current = this.webTotpAttempts.get(loginToken) || { startedAt: Date.now(), count: 0 };
    current.count += 1; this.webTotpAttempts.set(loginToken, current);
  }

  private succeededWebTotp(loginToken: string) { this.webTotpAttempts.delete(loginToken); }

  private broadcastHostStatus(accountId: string, hostId: string, online: boolean) {
    this.broadcastAccount(accountId, "host/status", { hostId, online, at: new Date().toISOString() });
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url || "/", this.config.publicUrl);
      if (url.pathname === "/health") {
        json(res, 200, { ok: true, protocolVersion: RELAY_PROTOCOL_VERSION });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        await this.onApi(req, res, url);
        return;
      }
      if (url.pathname === "/invite") {
        // Keep the legacy Android invitation surface available while /app is optional.
        this.serveAdmin(res, url.pathname);
        return;
      }
      if (!this.config.webEnabled && (url.pathname === "/app" || url.pathname.startsWith("/app/"))) {
        throw new RelayError("NOT_FOUND", "网页端尚未启用");
      }
      if (this.config.webEnabled && (url.pathname === "/app" || url.pathname.startsWith("/app/"))) {
        this.serveWeb(res, url.pathname);
        return;
      }
      this.serveAdmin(res, url.pathname);
    } catch (error) {
      const relayError = error instanceof RelayError ? error : new RelayError("INTERNAL_ERROR", "Relay 内部错误");
      if (!(error instanceof RelayError)) console.error(error);
      const retryAfterMs = relayError.nameCode === "RATE_LIMITED"
        ? Number((relayError.data as { retryAfterMs?: unknown } | undefined)?.retryAfterMs || 0)
        : 0;
      json(
        res,
        statusFor(relayError),
        { error: { code: relayError.nameCode, message: relayError.message, data: relayError.data } },
        retryAfterMs > 0 ? { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } : {},
      );
    }
  }

  private async onApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method || "GET";
    if (url.pathname.startsWith("/api/web/")) {
      if (!this.config.webEnabled) throw new RelayError("NOT_FOUND", "网页端尚未启用");
      webOrigin(req, this.config.publicUrl);
      requireJsonContentType(req);
    }
    if (method === "GET" && url.pathname === "/api/bootstrap/status") {
      json(res, 200, { required: this.store.accountCount() === 0 });
      return;
    }
    if (method === "GET" && url.pathname === "/api/public/config") {
      json(res, 200, {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        recoveryPublicKey: this.store.meta("recoveryPublicKey") || null,
        deviceLoginRecovery: 1,
      });
      return;
    }
    if (method === "POST" && url.pathname === "/api/bootstrap/claim") {
      const body = asObject(await readJson(req));
      const username = normalizeUsername(body.username);
      const passwordHash = await hashPassword(validatePassword(body.password));
      const account = this.accountInput(body, username, passwordHash, "admin");
      const claimed = this.store.claimBootstrap(
        requiredString(body.bootstrapId, "bootstrapId", 64),
        requiredString(body.secret, "secret", 128),
        account,
        this.deviceInput(body),
        validatePublicKey(body.recoveryPublicKey, "recoveryPublicKey"),
      );
      const tokens = this.store.createSession(claimed.account.id, "device", claimed.device.id);
      json(res, 201, this.loginResult(claimed.account, claimed.device, tokens));
      return;
    }
    if (method === "POST" && url.pathname === "/api/invites/claim") {
      const body = asObject(await readJson(req));
      const username = normalizeUsername(body.username);
      const passwordHash = await hashPassword(validatePassword(body.password));
      const account = this.accountInput(body, username, passwordHash, "user");
      const claimed = this.store.claimInvite(
        requiredString(body.inviteId, "inviteId", 64),
        requiredString(body.secret, "secret", 128),
        account,
        this.deviceInput(body),
      );
      const tokens = this.store.createSession(claimed.account.id, "device", claimed.device.id);
      json(res, 201, this.loginResult(claimed.account, claimed.device, tokens));
      return;
    }
    if (method === "POST" && (url.pathname === "/api/web/activate/start" || url.pathname === "/api/web/activate/complete")) {
      const body = asObject(await readJson(req));
      const result = url.pathname.endsWith("/start") ? await this.webActivation.start(body, clientAddress(req)) : await this.webActivation.complete(body, clientAddress(req));
      json(res, 200, result); return;
    }
    if (method === "POST" && url.pathname === "/api/web/login") {
      await sodium.ready;
      const body = asObject(await readJson(req));
      const username = normalizeUsername(body.username);
      const sourceKey = `web-source:${clientAddress(req)}`;
      const accountKey = `web-username:${username}`;
      const key = `web-account-source:${username}:${clientAddress(req)}`;
      this.sourceThrottle.assertAllowed(sourceKey);
      this.accountThrottle.assertAllowed(accountKey);
      this.throttle.assertAllowed(key);
      const password = String(body.password || "");
      const account = this.store.accountByUsername(username);
      if (!account) {
        const provision = this.store.accountProvisionByUsername(username);
        if (provision && this.store.meta(`webActivationMode:${provision.id}`) === "web-only" && await verifyPassword(password, provision.password_hash)) {
          this.throttle.succeeded(key); this.accountThrottle.succeeded(accountKey); this.sourceThrottle.succeeded(sourceKey);
          throw new RelayError("ACCOUNT_ACTIVATION_REQUIRED", "首次使用，请在网页激活这个账号");
        }
      }
      if (!account || account.status !== "active" || !await verifyPassword(password, account.password_hash)) {
        const sourceDelay = this.sourceThrottle.failed(sourceKey);
        const retryAfterMs = Math.max(sourceDelay, this.accountThrottle.failed(accountKey), this.throttle.failed(key));
        throw new RelayError(retryAfterMs ? "RATE_LIMITED" : "AUTH_FAILED", "用户名或密码错误", retryAfterMs ? { retryAfterMs } : undefined);
      }
      this.throttle.succeeded(key); this.accountThrottle.succeeded(accountKey); this.sourceThrottle.succeeded(sourceKey);
      const requestedDeviceId = optionalString(body.deviceId, "deviceId", 64);
      const deviceSigningPublicKey = validatePublicKey(body.deviceSigningPublicKey, "deviceSigningPublicKey");
      const deviceEncryptionPublicKey = validatePublicKey(body.deviceEncryptionPublicKey, "deviceEncryptionPublicKey");
      const deviceName = requiredString(body.deviceName, "deviceName", 80);
      const security = this.store.ensureWebSecurity(account.id);
      const packageRow = this.store.webKeyPackage(account.id);
      const totpSecret = security.totp_secret as string | null;
      const requiredTotp = Boolean(security.totp_required);
      const suppliedTotp = body.totpCode;
      let verified = !requiredTotp;
      if (requiredTotp && totpSecret) {
        const totpRateKey = `web-totp:${account.id}:${clientAddress(req)}`;
        this.webTotpThrottle.assertAllowed(totpRateKey);
        const step = verifyTotp(totpSecret, suppliedTotp, Number(security.totp_last_step));
        if (step === undefined) {
          this.webTotpThrottle.failed(totpRateKey);
          const challenge = this.store.createWebLogin({
            accountId: account.id, deviceId: requestedDeviceId, deviceName, deviceSigningPublicKey, deviceEncryptionPublicKey,
            credentialVersion: Number(security.credential_version),
            totpVersion: Number(security.totp_version), verified: false, signingChallenge: token(32),
            boxNonce: sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.URLSAFE_NO_PADDING), trusted: body.trustBrowser !== false,
          });
          throw new RelayError("TOTP_REQUIRED", "请输入 FreeOTP+ 中的 6 位验证码", { loginToken: challenge });
        }
        this.webTotpThrottle.succeeded(totpRateKey);
        this.store.recordTotpStep(account.id, step);
        verified = true;
      }
      const enrollmentSecret = requiredTotp && !totpSecret ? randomTotpSecret() : undefined;
      // Do not create or touch a browser device until password and TOTP have
      // both succeeded. A pending login stores only the public device data;
      // materializeWebLoginDevice attaches it after the second factor.
      const device = enrollmentSecret ? undefined : this.store.findWebDeviceForLogin(
        account.id, requestedDeviceId, deviceSigningPublicKey, deviceEncryptionPublicKey, deviceName,
      );
      const signingChallenge = token(32);
      const boxNonce = sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.URLSAFE_NO_PADDING);
      const loginToken = this.store.createWebLogin({
        accountId: account.id, deviceId: device?.id, deviceName, deviceSigningPublicKey, deviceEncryptionPublicKey,
        credentialVersion: Number(security.credential_version),
        totpVersion: Number(security.totp_version), verified, signingChallenge, boxNonce,
        trusted: body.trustBrowser !== false, enrollmentSecret,
      });
      if (enrollmentSecret) {
        throw new RelayError("TOTP_ENROLLMENT_REQUIRED", "此账号需要先绑定验证器", {
          loginToken, secret: enrollmentSecret, otpauthUri: otpauthUri("Agent Pocket", account.username, enrollmentSecret),
        });
      }
      if (!device) throw new RelayError("AUTH_FAILED", "网页设备验证事务无效");
      const encryptedChallenge = sodium.crypto_box_seal(sodium.from_base64(boxNonce, sodium.base64_variants.URLSAFE_NO_PADDING), base64Bytes(device.encryption_public_key, "deviceEncryptionPublicKey"));
      json(res, 200, {
        state: "device_proof_pending", loginToken, account: this.publicAccount(account),
        device: { id: device.id, name: device.name, status: device.status },
        challenge: { signingMessage: signingChallenge, boxChallenge: sodium.to_base64(encryptedChallenge, sodium.base64_variants.URLSAFE_NO_PADDING) },
        // A stale package still occupies its version slot. The migration
        // endpoint uses this value for its compare-and-swap check.
        keyPackageVersion: packageRow ? Number(packageRow.version) : 0,
      });
      return;
    }
    if (method === "POST" && url.pathname === "/api/auth/web-package") {
      const principal = this.devicePrincipal(req);
      if (this.store.db.prepare("SELECT 1 FROM web_devices WHERE device_id=?").get(principal.principal_id)) {
        throw new RelayError("FORBIDDEN", "网页设备不能代替可信 Android 迁移账户密钥");
      }
      const body = asObject(await readJson(req));
      const packageJson = webPackage(body.packageJson);
      const security = this.store.ensureWebSecurity(principal.account_id);
      const current = this.store.webKeyPackage(principal.account_id);
      const expectedVersion = integer(body.expectedVersion ?? (current ? Number(current.version) : 0), "expectedVersion");
      const operationId = optionalString(body.operationId, "operationId", 128);
      const fingerprint = createHash("sha256").update(JSON.stringify({ packageJson, expectedVersion, accountId: principal.account_id })).digest("hex");
      const previous = operationId && this.store.webOperation(principal.account_id, operationId, fingerprint);
      if (previous) { json(res, 200, previous); return; }
      const result = this.store.saveWebKeyPackageWithOperation(
        principal.account_id,
        packageJson,
        expectedVersion,
        Number(security.credential_version),
        operationId,
        fingerprint,
        (saved) => ({ migrated: true, keyPackageVersion: Number(saved.version) }),
      );
      const response = result.response || { migrated: true, keyPackageVersion: Number(result.saved?.version || 0) };
      if (!result.replay) this.store.audit(principal.account_id, "device", principal.principal_id, "web.package.android-migrate", "account", principal.account_id, { version: Number(result.saved?.version || 0) });
      json(res, 200, response);
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/totp/enroll/start") {
      const body = asObject(await readJson(req));
      const login = this.store.webLoginByToken(requiredString(body.loginToken, "loginToken", 256));
      if (!login) throw new RelayError("AUTH_FAILED", "登录事务已过期");
      const account = this.store.accountById(login.account_id);
      const security = this.store.ensureWebSecurity(login.account_id);
      if (!account || !security.totp_required) throw new RelayError("FORBIDDEN", "当前账号不需要绑定 TOTP");
      if (!login.enrollment_secret) throw new RelayError("CONFLICT", "TOTP 绑定事务不存在");
      json(res, 200, { secret: login.enrollment_secret, otpauthUri: otpauthUri("Agent Pocket", account.username, login.enrollment_secret) });
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/totp/enroll/finish") {
      const body = asObject(await readJson(req));
      const loginToken = requiredString(body.loginToken, "loginToken", 256);
      this.assertWebTotpAttempt(loginToken);
      const login = this.store.webLoginByToken(loginToken);
      if (!login || !login.enrollment_secret) throw new RelayError("AUTH_FAILED", "TOTP 绑定事务已过期");
      const totpRateKey = `web-totp:${login.account_id}:${clientAddress(req)}`;
      this.webTotpThrottle.assertAllowed(totpRateKey);
      const step = verifyTotp(login.enrollment_secret, body.code);
      if (step === undefined) { this.webTotpThrottle.failed(totpRateKey); this.failedWebTotp(loginToken); throw new RelayError("AUTH_FAILED", "TOTP 验证码无效"); }
      this.webTotpThrottle.succeeded(totpRateKey);
      this.succeededWebTotp(loginToken);
      const codes = createRecoveryCodes(10);
      this.store.setTotpSecret(login.account_id, login.enrollment_secret, codes.hashes, loginToken);
      this.store.recordTotpStep(login.account_id, step);
      this.store.updateWebLogin(loginToken, { verified: true });
      this.store.materializeWebLoginDevice(loginToken);
      json(res, 200, { state: "device_proof_pending", recoveryCodes: codes.codes, loginToken });
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/totp/recovery") {
      const body = asObject(await readJson(req));
      const loginToken = requiredString(body.loginToken, "loginToken", 256);
      this.assertWebTotpAttempt(loginToken);
      const login = this.store.webLoginByToken(loginToken);
      if (!login) throw new RelayError("AUTH_FAILED", "登录事务已过期");
      const totpRateKey = `web-totp:${login.account_id}:${clientAddress(req)}`;
      this.webTotpThrottle.assertAllowed(totpRateKey);
      if (!this.store.consumeRecoveryHash(login.account_id, recoveryCodeHash(requiredString(body.code, "code", 32)))) { this.webTotpThrottle.failed(totpRateKey); this.failedWebTotp(loginToken); throw new RelayError("AUTH_FAILED", "恢复码无效或已经使用"); }
      this.webTotpThrottle.succeeded(totpRateKey);
      this.succeededWebTotp(loginToken);
      this.store.updateWebLogin(loginToken, { verified: true });
      this.store.materializeWebLoginDevice(loginToken);
      json(res, 200, { state: "device_proof_pending", loginToken });
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/totp/verify") {
      const body = asObject(await readJson(req));
      const loginToken = requiredString(body.loginToken, "loginToken", 256);
      this.assertWebTotpAttempt(loginToken);
      const login = this.store.webLoginByToken(loginToken);
      if (!login) throw new RelayError("AUTH_FAILED", "登录事务已过期");
      const security = this.store.ensureWebSecurity(login.account_id);
      const totpRateKey = `web-totp:${login.account_id}:${clientAddress(req)}`;
      this.webTotpThrottle.assertAllowed(totpRateKey);
      const step = verifyTotp(String(security.totp_secret || ""), body.code, Number(security.totp_last_step));
      if (step === undefined) { this.webTotpThrottle.failed(totpRateKey); this.failedWebTotp(loginToken); throw new RelayError("AUTH_FAILED", "TOTP 验证码无效"); }
      this.webTotpThrottle.succeeded(totpRateKey);
      this.succeededWebTotp(loginToken);
      this.store.recordTotpStep(login.account_id, step);
      this.store.updateWebLogin(loginToken, { verified: true });
      this.store.materializeWebLoginDevice(loginToken);
      json(res, 200, { state: "device_proof_pending", loginToken });
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/device/complete") {
      const body = asObject(await readJson(req));
      const loginToken = requiredString(body.loginToken, "loginToken", 256);
      const login = this.store.webLoginByToken(loginToken);
      if (!login || !login.verified || login.proof) throw new RelayError("AUTH_FAILED", "设备证明事务已完成或已失效");
      this.store.materializeWebLoginDevice(loginToken);
      const materializedLogin = this.store.webLoginByToken(loginToken);
      if (!materializedLogin) throw new RelayError("AUTH_FAILED", "登录事务已过期");
      const account = this.store.accountById(login.account_id);
      const device = account && this.store.deviceById(account.id, materializedLogin.device_id);
      if (!account || !device) throw new RelayError("AUTH_FAILED", "网页设备不存在");
      await this.verifyWebProof(login, device, body);
      // Approval, session creation, and consumption of the proof transaction
      // must commit together. Otherwise a crash after session creation could
      // let a retry of the same loginToken create another web session.
      const result = this.store.transaction(() => {
        const current = this.store.webLoginByToken(loginToken);
        if (!current?.verified || current.proof || current.account_id !== account.id || current.device_id !== device.id
          || current.signing_challenge !== login.signing_challenge || current.box_nonce !== login.box_nonce) throw new RelayError("AUTH_FAILED", "设备证明事务已完成或已失效");
        const consumed = this.store.db.prepare("UPDATE web_logins SET proof=1 WHERE token_hash=? AND verified=1 AND proof=0")
          .run(tokenHash(loginToken));
        if (consumed.changes !== 1) throw new RelayError("CONFLICT", "设备证明已经被使用");
        const packageRow = this.store.webKeyPackage(account.id);
        if (!packageRow || packageRow.stale) return { state: "key_migration_required", loginToken, account: this.publicAccount(account), device: { id: device.id, name: device.name, status: device.status }, keyPackageVersion: packageRow ? Number(packageRow.version) : 0 };
        this.store.approveWebDevice(account.id, device.id, packageRow.package_json, device.id);
        const tokens = this.store.createWebSession(account.id, device.id);
        this.store.deleteWebLogin(loginToken);
        return { state: "ready", account: this.publicAccount(account), device: { id: device.id, name: device.name, status: "approved" }, tokens, keyPackage: packageRow.package_json, keyPackageVersion: Number(packageRow.version) };
      });
      json(res, 200, result);
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/device/challenge") {
      const body = asObject(await readJson(req));
      const loginToken = requiredString(body.loginToken, "loginToken", 256);
      const login = this.store.webLoginByToken(loginToken);
      if (!login || !login.verified) throw new RelayError("AUTH_FAILED", "网页二次验证尚未完成");
      this.store.materializeWebLoginDevice(loginToken);
      const materializedLogin = this.store.webLoginByToken(loginToken);
      if (!materializedLogin) throw new RelayError("AUTH_FAILED", "登录事务已过期");
      const device = this.store.deviceById(materializedLogin.account_id, materializedLogin.device_id);
      if (!device || device.status === "revoked") throw new RelayError("AUTH_FAILED", "网页设备已撤销");
      await sodium.ready;
      const encrypted = sodium.crypto_box_seal(sodium.from_base64(materializedLogin.box_nonce, sodium.base64_variants.URLSAFE_NO_PADDING), base64Bytes(device.encryption_public_key, "deviceEncryptionPublicKey"));
      json(res, 200, { signingMessage: materializedLogin.signing_challenge, boxChallenge: sodium.to_base64(encrypted, sodium.base64_variants.URLSAFE_NO_PADDING) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/web/key-migration/status") {
      const principal = this.webPrincipal(req);
      const security = this.store.ensureWebSecurity(principal.account_id);
      const row = this.store.webKeyPackage(principal.account_id);
      json(res, 200, { state: !row || row.stale ? "key_migration_required" : "ready", keyPackageVersion: row ? Number(row.version) : 0, credentialVersion: Number(security.credential_version) });
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/key-migration/start") {
      const principal = this.webPrincipal(req);
      const security = this.store.ensureWebSecurity(principal.account_id);
      const row = this.store.webKeyPackage(principal.account_id);
      json(res, 200, { state: !row || row.stale ? "key_migration_required" : "ready", expectedVersion: row ? Number(row.version) : 0, credentialVersion: Number(security.credential_version) });
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/key-migration/package") {
      const body = asObject(await readJson(req));
      const login = this.store.webLoginByToken(requiredString(body.loginToken, "loginToken", 256));
      if (!login?.verified || !login.proof || !login.device_id
        || !this.store.db.prepare("SELECT 1 FROM web_devices WHERE device_id=? AND account_id=?").get(login.device_id, login.account_id)) {
        throw new RelayError("AUTH_FAILED", "网页二次验证和设备证明尚未完成");
      }
      const current = this.store.webKeyPackage(login.account_id);
      if (current && !current.stale) throw new RelayError("CONFLICT", "网页迁移已完成，请重新登录");
      const device = this.store.deviceById(login.account_id, login.device_id);
      if (!device || device.status === "revoked") throw new RelayError("AUTH_FAILED", "网页设备不存在或已撤销");
      if (device.status !== "approved" || !device.key_package) { json(res, 200, { state: "pending" }); return; }
      // Legacy Android approves only the sealed device package. It does not
      // grant a web session or mark the password-wrapped package migrated.
      if (device.key_package.trim().startsWith("{")) throw new RelayError("CONFLICT", "旧网页密钥已失效，请使用临时浏览器模式重新登录并由手机批准");
      json(res, 200, { state: "approved", sealedKeyPackage: device.key_package });
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/key-migration/complete") {
      const body = asObject(await readJson(req));
      const loginToken = requiredString(body.loginToken, "loginToken", 256);
      const login = this.store.webLoginByToken(loginToken);
      if (!login || !login.verified || !login.proof) throw new RelayError("AUTH_FAILED", "设备证明尚未完成");
      const packageJson = webPackage(body.packageJson);
      const account = this.store.accountById(login.account_id);
      if (!account) throw new RelayError("NOT_FOUND", "用户不存在");
      const expectedVersion = Number(body.expectedVersion ?? 0);
      const operationId = optionalString(body.operationId, "operationId", 128);
      const fingerprint = createHash("sha256").update(JSON.stringify({ packageJson, expectedVersion, deviceId: login.device_id })).digest("hex");
      const previous = operationId && this.store.webOperation(account.id, operationId, fingerprint);
      if (previous) {
        // Tokens are intentionally removed from the durable receipt. A retry
        // with the same operationId can still recover a usable session without
        // repeating the migration or generating a second key package.
        if (previous.state === "ready" && login.device_id) {
          const device = this.store.deviceById(account.id, login.device_id);
          if (device?.status === "approved") {
            const tokens = this.store.createWebSession(account.id, device.id);
            this.store.deleteWebLogin(loginToken);
            json(res, 200, { ...previous, tokens });
            return;
          }
        }
        json(res, 200, previous);
        return;
      }
      const device = this.store.deviceById(account.id, login.device_id);
      const currentPackage = this.store.webKeyPackage(account.id);
      if (!device || device.status === "revoked"
        || !this.store.db.prepare("SELECT 1 FROM web_devices WHERE device_id=? AND account_id=?").get(device.id, account.id)
        || (currentPackage && !currentPackage.stale)) throw new RelayError("AUTH_FAILED", "网页迁移事务已经完成，请重新登录");
      const result = this.store.completeWebMigration(account.id, login.device_id, packageJson, expectedVersion, login.device_id,
        operationId, fingerprint, (completed, tokens) => ({ state: "ready", account: this.publicAccount(account), device: { id: login.device_id, status: "approved" }, tokens, keyPackage: packageJson, keyPackageVersion: completed.version }));
      const response = result.response || { state: "ready", account: this.publicAccount(account), device: { id: login.device_id, status: "approved" }, keyPackage: packageJson, keyPackageVersion: result.version };
      if (!operationId) this.store.deleteWebLogin(loginToken);
      json(res, 200, response);
      return;
    }
    if (method === "GET" && url.pathname === "/api/web/session") {
      const principal = this.webPrincipal(req);
      const account = this.store.accountById(principal.account_id)!;
      const security = this.store.ensureWebSecurity(principal.account_id);
      const packageRow = this.store.webKeyPackage(principal.account_id);
      json(res, 200, { state: "ready", account: this.publicAccount(account), device: { id: principal.principal_id, status: principal.device_status }, totp: { required: Boolean(security.totp_required), configured: Boolean(security.totp_secret) }, keyPackageVersion: packageRow && !packageRow.stale ? Number(packageRow.version) : 0 });
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/refresh") {
      const body = asObject(await readJson(req));
      const tokens = this.store.refreshWebSession(requiredString(body.refreshToken, "refreshToken", 256));
      json(res, 200, tokens);
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/logout") {
      const principal = this.webPrincipal(req);
      this.store.revokeSession(principal.id);
      this.closeAccountSockets(principal.account_id, "Web session logged out", principal.id, true);
      const body = asObject(await readJson(req));
      if (body.refreshToken) {
        const refreshToken = requiredString(body.refreshToken, "refreshToken", 256);
        const row = this.store.db.prepare("SELECT s.id,s.account_id,s.principal_id FROM sessions s JOIN web_sessions w ON w.session_id=s.id WHERE s.refresh_hash=? AND s.principal_kind='device'").get(tokenHash(refreshToken)) as any;
        if (!row || row.account_id !== principal.account_id || row.principal_id !== principal.principal_id) throw new RelayError("AUTH_FAILED", "网页刷新令牌无效");
        this.store.revokeRefreshToken(refreshToken);
        this.closeDeviceSockets(row.principal_id, "Web session logged out");
      }
      json(res, 200, { loggedOut: true });
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/device/forget") {
      const principal = this.webPrincipal(req);
      this.store.revokeDevice(principal.account_id, principal.principal_id, principal.principal_id);
      this.closeDeviceSockets(principal.principal_id, "Device forgotten");
      json(res, 200, { forgotten: true });
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/ws-ticket") {
      const principal = this.webPrincipal(req);
      const ticket = this.store.createWebTicket(principal.id, principal.account_id, principal.principal_id);
      json(res, 200, ticket);
      return;
    }
    const webOperationMatch = /^\/api\/web\/operations\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && webOperationMatch) {
      const principal = this.webPrincipal(req);
      const operationId = decodeURIComponent(webOperationMatch[1]);
      const result = this.store.webOperationById(principal.account_id, operationId);
      if (result === undefined) throw new RelayError("NOT_FOUND", "操作记录不存在或已过期");
      json(res, 200, { operationId, result });
      return;
    }
    if (method === "POST" && url.pathname === "/api/web/password") {
      const principal = this.webPrincipal(req);
      const body = asObject(await readJson(req));
      const packageJson = webPackage(body.packageJson);
      const expectedVersion = Number(body.expectedVersion ?? 0);
      const operationId = optionalString(body.operationId, "operationId", 128);
      const newPassword = validatePassword(body.newPassword);
      if (this.webPasswordChanges.has(principal.account_id) || this.webPasswordChanges.size >= 2) throw new RelayError("RATE_LIMITED", "密码更新正在处理中，请稍后查询或重试");
      this.webPasswordChanges.add(principal.account_id);
      try {
      const fingerprint = await passwordOperationFingerprint(newPassword, [principal.account_id, operationId ?? null, expectedVersion, packageJson, principal.id]);
      this.webPrincipal(req);
      const previous = operationId && this.store.webOperation(principal.account_id, operationId, fingerprint);
      if (previous) { json(res, 200, previous); return; }
      const account = this.store.accountById(principal.account_id)!;
      if (!await verifyPassword(String(body.currentPassword || ""), account.password_hash)) throw new RelayError("AUTH_FAILED", "当前密码错误");
      const security = this.store.ensureWebSecurity(principal.account_id);
      if (security.totp_required) {
        const step = verifyTotp(String(security.totp_secret || ""), body.totpCode, Number(security.totp_last_step));
        if (step === undefined) throw new RelayError("TOTP_REQUIRED", "请输入 TOTP 验证码");
        this.store.recordTotpStep(principal.account_id, step);
      }
      const passwordHash = await hashPassword(newPassword);
      // KDF work yields to resets/revocations. Revalidate immediately before
      // the synchronous transaction so an obsolete session cannot change keys.
      this.webPrincipal(req);
      if (this.store.accountById(principal.account_id)?.password_hash !== account.password_hash) throw new RelayError("VERSION_CONFLICT", "账户凭据已变化，请重新登录");
      const result = this.store.changeWebPassword(principal.account_id, passwordHash, packageJson, expectedVersion, principal.principal_id, principal.id,
        operationId, fingerprint, value => ({ changed: true, ...value }));
      const response = result.response || { changed: true, credentialVersion: result.credentialVersion, version: result.version };
      this.closeAccountSockets(principal.account_id, "Web credentials changed", principal.id);
      json(res, 200, response);
      return;
      } finally { this.webPasswordChanges.delete(principal.account_id); }
    }
    if (method === "POST" && url.pathname === "/api/auth/activate") {
      const body = asObject(await readJson(req));
      const username = normalizeUsername(body.username);
      const sourceKey = `device-source:${clientAddress(req)}`;
      const accountKey = `device-username:${username}`;
      const key = `device-account-source:${username}:${clientAddress(req)}`;
      this.sourceThrottle.assertAllowed(sourceKey);
      this.accountThrottle.assertAllowed(accountKey);
      this.throttle.assertAllowed(key);
      const provision = this.store.accountProvisionByUsername(username);
      if (!provision || !await verifyPassword(String(body.password || ""), provision.password_hash)) {
        const sourceDelay = this.sourceThrottle.failed(sourceKey);
        const retryAfterMs = Math.max(sourceDelay, this.accountThrottle.failed(accountKey), this.throttle.failed(key));
        throw new RelayError(retryAfterMs ? "RATE_LIMITED" : "AUTH_FAILED", "用户名或密码错误", retryAfterMs ? { retryAfterMs } : undefined);
      }
      const account = this.accountInput({ ...body, displayName: provision.display_name }, username, provision.password_hash, "user");
      const claimed = this.store.activateAccountProvision(provision.id, account, this.deviceInput(body));
      const tokens = this.store.createSession(claimed.account.id, "device", claimed.device.id);
      this.throttle.succeeded(key);
      this.accountThrottle.succeeded(accountKey);
      this.sourceThrottle.succeeded(sourceKey);
      json(res, 201, this.loginResult(claimed.account, claimed.device, tokens));
      return;
    }
    if (method === "POST" && url.pathname === "/api/auth/login") {
      const body = asObject(await readJson(req));
      const username = normalizeUsername(body.username);
      const sourceKey = `device-source:${clientAddress(req)}`;
      const accountKey = `device-username:${username}`;
      const key = `device-account-source:${username}:${clientAddress(req)}`;
      this.sourceThrottle.assertAllowed(sourceKey);
      this.accountThrottle.assertAllowed(accountKey);
      this.throttle.assertAllowed(key);
      const password = String(body.password || "");
      const account = this.store.accountByUsername(username);
      if (!account) {
        const provision = this.store.accountProvisionByUsername(username);
        if (provision && await verifyPassword(password, provision.password_hash)) {
          this.throttle.succeeded(key);
          this.accountThrottle.succeeded(accountKey);
          this.sourceThrottle.succeeded(sourceKey);
          throw new RelayError("ACCOUNT_ACTIVATION_REQUIRED", "账号等待首次激活");
        }
      }
      if (!account || account.status !== "active" || !await verifyPassword(password, account.password_hash)) {
        const sourceDelay = this.sourceThrottle.failed(sourceKey);
        const retryAfterMs = Math.max(sourceDelay, this.accountThrottle.failed(accountKey), this.throttle.failed(key));
        throw new RelayError(retryAfterMs ? "RATE_LIMITED" : "AUTH_FAILED", "用户名或密码错误", retryAfterMs ? { retryAfterMs } : undefined);
      }
      this.throttle.succeeded(key);
      this.accountThrottle.succeeded(accountKey);
      this.sourceThrottle.succeeded(sourceKey);
      if (body.recoverDeviceKeys === true) {
        const issuedAt = body.deviceProofIssuedAt;
        const signing = validatePublicKey(body.deviceSigningPublicKey, "deviceSigningPublicKey");
        const encryption = validatePublicKey(body.deviceEncryptionPublicKey, "deviceEncryptionPublicKey");
        const signature = requiredString(body.deviceRecoveryProof, "deviceRecoveryProof", 128);
        await sodium.ready;
        const bytes = Buffer.from(signature, "base64url");
        if (!Number.isSafeInteger(issuedAt) || Math.abs(Date.now() - Number(issuedAt)) > 5 * 60_000 ||
            bytes.toString("base64url") !== signature || bytes.length !== sodium.crypto_sign_BYTES ||
            !sodium.crypto_sign_verify_detached(bytes, Buffer.from(JSON.stringify(["agent-pocket-device-login-recovery-v1", username, signing, encryption, issuedAt])), Buffer.from(signing, "base64url"))) {
          throw new RelayError("AUTH_FAILED", "设备私钥证明无效");
        }
      }
      const device = this.store.findDeviceForLogin(
        account.id,
        optionalString(body.deviceId, "deviceId", 64),
        validatePublicKey(body.deviceSigningPublicKey, "deviceSigningPublicKey"),
        validatePublicKey(body.deviceEncryptionPublicKey, "deviceEncryptionPublicKey"),
        requiredString(body.deviceName, "deviceName", 80),
        body.recoverDeviceKeys === true,
      );
      const tokens = this.store.createSession(account.id, "device", device.id);
      this.store.audit(account.id, "device", device.id, "auth.login", "device", device.id, { status: device.status });
      json(res, 200, this.loginResult(account, device, tokens));
      return;
    }
    if (method === "POST" && url.pathname === "/api/account/password") {
      const principal = this.devicePrincipal(req);
      const body = asObject(await readJson(req));
      const account = this.store.accountById(principal.account_id);
      if (!account || !await verifyPassword(String(body.currentPassword || ""), account.password_hash)) {
        throw new RelayError("AUTH_FAILED", "当前密码错误");
      }
      const passwordHash = await hashPassword(validatePassword(body.newPassword));
      this.store.changeAccountPassword(account.id, passwordHash, principal.principal_id, principal.id);
      json(res, 200, { changed: true });
      return;
    }
    if (method === "POST" && url.pathname === "/api/auth/refresh") {
      const body = asObject(await readJson(req));
      const tokens = this.store.refreshSession(requiredString(body.refreshToken, "refreshToken", 256), true);
      json(res, 200, tokens);
      return;
    }
    if (method === "POST" && url.pathname === "/api/auth/logout") {
      const access = bearer(req);
      const principal = access && this.store.authenticateAccess(access, true);
      if (principal && this.store.db.prepare("SELECT 1 FROM web_devices WHERE device_id=?").get(principal.principal_id)) {
        throw new RelayError("FORBIDDEN", "网页设备必须使用网页退出接口");
      }
      if (principal) this.store.revokeSession(principal.id);
      const body = asObject(await readJson(req));
      if (body.refreshToken) {
        const refreshToken = requiredString(body.refreshToken, "refreshToken", 256);
        if (this.store.db.prepare("SELECT 1 FROM web_sessions w JOIN sessions s ON s.id=w.session_id WHERE s.refresh_hash=?").get(tokenHash(refreshToken))) throw new RelayError("FORBIDDEN", "网页刷新令牌必须使用网页退出接口");
        this.store.revokeRefreshToken(refreshToken);
      }
      json(res, 200, { loggedOut: true });
      return;
    }
    if (method === "GET" && url.pathname === "/api/device/status") {
      const principal = this.devicePrincipal(req, true);
      const account = this.store.accountById(principal.account_id)!;
      const device = this.store.deviceById(principal.account_id, principal.principal_id)!;
      json(res, 200, this.loginResult(account, device));
      return;
    }
    if (method === "POST" && url.pathname === "/api/host/enroll/start") {
      const rateKey = `host-enrollment-start:${clientAddress(req)}`;
      this.enrollmentThrottle.assertAllowed(rateKey);
      this.enrollmentThrottle.failed(rateKey);
      const body = asObject(await readJson(req));
      const enrollment = this.store.startHostEnrollment(
        requiredString(body.name, "name", 80),
        validatePublicKey(body.signingPublicKey, "signingPublicKey"),
        validatePublicKey(body.encryptionPublicKey, "encryptionPublicKey"),
      );
      const pairUri = `agentpocket://relay-host?relay=${encodeURIComponent(this.config.publicUrl)}&enrollmentId=${encodeURIComponent(enrollment.id)}&secret=${encodeURIComponent(enrollment.secret)}`;
      json(res, 201, { ...enrollment, pairUri });
      return;
    }
    if (method === "POST" && url.pathname === "/api/host/enroll/status") {
      const body = asObject(await readJson(req));
      const enrollment = this.store.hostEnrollment(
        requiredString(body.enrollmentId, "enrollmentId", 64),
        requiredString(body.secret, "secret", 128),
      );
      json(res, 200, { approved: Boolean(enrollment.approved_account_id), completed: Boolean(enrollment.completed_at), expiresAt: enrollment.expires_at });
      return;
    }
    if (method === "POST" && url.pathname === "/api/host/enroll/complete") {
      const body = asObject(await readJson(req));
      const completed = this.store.completeHostEnrollment(
        requiredString(body.enrollmentId, "enrollmentId", 64),
        requiredString(body.secret, "secret", 128),
        optionalString(body.proposedHostToken, "proposedHostToken", 128),
      );
      json(res, 201, completed);
      return;
    }
    const updateLatestMatch = /^\/api\/updates\/(android|host)\/latest$/.exec(url.pathname);
    if (method === "GET" && updateLatestMatch) {
      const platform = updateLatestMatch[1] as UpdatePlatform;
      this.updatePrincipal(req, platform);
      const release = this.store.latestUpdate(platform);
      if (!release) throw new RelayError("NOT_FOUND", "当前平台尚未发布更新");
      json(res, 200, {
        manifestJson: release.manifest_json,
        manifestSignature: release.manifest_signature,
        downloadUrl: `${this.config.publicUrl}/api/updates/${platform}/${encodeURIComponent(release.version)}/${encodeURIComponent(release.asset_name)}`,
      });
      return;
    }
    const updateAssetMatch = /^\/api\/updates\/(android|host)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if ((method === "GET" || method === "HEAD") && updateAssetMatch) {
      const platform = updateAssetMatch[1] as UpdatePlatform;
      const principal = this.updatePrincipal(req, platform);
      await this.serveUpdateAsset(req, res, platform, decodeURIComponent(updateAssetMatch[2]), decodeURIComponent(updateAssetMatch[3]), principal);
      return;
    }
    if (url.pathname.startsWith("/api/admin/")) {
      await this.onAdminApi(req, res, url);
      return;
    }
    throw new RelayError("NOT_FOUND", "API 路径不存在");
  }

  private async onAdminApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method || "GET";
    if (method === "POST" && url.pathname === "/api/admin/login") {
      const body = asObject(await readJson(req));
      const username = normalizeUsername(body.username);
      const sourceKey = `admin-source:${clientAddress(req)}`;
      const key = `admin-account:${clientAddress(req)}:${username}`;
      this.sourceThrottle.assertAllowed(sourceKey);
      this.throttle.assertAllowed(key);
      const account = this.store.accountByUsername(username);
      if (!account || account.role !== "admin" || account.status !== "active" || !await verifyPassword(String(body.password || ""), account.password_hash)) {
        const sourceDelay = this.sourceThrottle.failed(sourceKey);
        const retryAfterMs = Math.max(sourceDelay, this.throttle.failed(key));
        throw new RelayError(retryAfterMs ? "RATE_LIMITED" : "AUTH_FAILED", "管理员账号或密码错误", retryAfterMs ? { retryAfterMs } : undefined);
      }
      this.throttle.succeeded(key);
      this.sourceThrottle.succeeded(sourceKey);
      const session = this.store.createSession(account.id, "web", account.id);
      const csrf = token(24);
      this.adminCookies(res, session.accessToken, session.refreshToken!, csrf);
      this.store.audit(account.id, "web", account.id, "admin.login");
      json(res, 200, { account: this.publicAccount(account), csrf });
      return;
    }
    if (method === "POST" && url.pathname === "/api/admin/refresh") {
      this.requireCsrf(req);
      const cookies = parseCookies(req);
      const session = this.store.refreshSession(requiredString(cookies.ap_refresh, "refresh cookie", 256));
      const csrf = token(24);
      this.adminCookies(res, session.accessToken, session.refreshToken!, csrf);
      json(res, 200, { refreshed: true, csrf });
      return;
    }
    if (method === "POST" && url.pathname === "/api/admin/logout") {
      this.requireCsrf(req);
      const cookies = parseCookies(req);
      const principal = cookies.ap_access && this.store.authenticateAccess(cookies.ap_access);
      if (principal) this.store.revokeSession(principal.id);
      if (cookies.ap_refresh) this.store.revokeRefreshToken(cookies.ap_refresh);
      this.clearAdminCookies(res);
      json(res, 200, { loggedOut: true });
      return;
    }
    const principal = this.adminPrincipal(req);
    if (method !== "GET" && method !== "HEAD") this.requireCsrf(req);
    if (method === "GET" && url.pathname === "/api/admin/session") {
      json(res, 200, { account: this.publicAccount(this.store.accountById(principal.account_id)) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/admin/users") {
      json(res, 200, { users: this.store.listAccounts() });
      return;
    }
    if (method === "POST" && url.pathname === "/api/admin/users") {
      const body = asObject(await readJson(req));
      const username = normalizeUsername(body.username);
      const passwordHash = await hashPassword(validatePassword(body.password));
      const provision = this.store.createAccountProvision({
        username,
        displayName: requiredString(body.displayName, "displayName", 80),
        passwordHash,
        createdBy: principal.account_id,
        webOnly: body.webOnly === true,
      });
      json(res, 201, {
        user: {
          id: provision.id,
          username: provision.username,
          display_name: provision.display_name,
          role: provision.role,
          status: "pending_activation",
          device_count: 0,
          host_count: 0,
          created_at: provision.created_at,
        },
      });
      return;
    }
    if (method === "GET" && url.pathname === "/api/admin/invites") {
      json(res, 200, { invites: this.store.listInvites(principal.account_id) });
      return;
    }
    if (method === "POST" && url.pathname === "/api/admin/invites") {
      const body = asObject(await readJson(req));
      const role = body.role === "admin" ? "admin" : body.role === "user" ? "user" : undefined;
      if (!role) throw new RelayError("INVALID_REQUEST", "邀请角色无效");
      const invite = this.store.createInvite(principal.account_id, role);
      const urlValue = `${this.config.publicUrl}/invite#${invite.id}.${invite.secret}`;
      json(res, 201, { ...invite, url: urlValue });
      return;
    }
    if (method === "GET" && url.pathname === "/api/admin/hosts") {
      json(res, 200, { hosts: this.store.listAllHosts().map((host) => ({ ...host, online: this.hosts.get(host.id)?.hello === true })) });
      return;
    }
    const devicesMatch = /^\/api\/admin\/users\/([^/]+)\/devices$/.exec(url.pathname);
    if (method === "GET" && devicesMatch) {
      json(res, 200, { devices: this.store.listDevices(devicesMatch[1]) });
      return;
    }
    const recoveryMatch = /^\/api\/admin\/users\/([^/]+)\/devices\/([^/]+)\/recovery$/.exec(url.pathname);
    if (method === "GET" && recoveryMatch) {
      try {
        const bundle = this.store.recoveryBundle(recoveryMatch[1], recoveryMatch[2]);
        this.store.audit(recoveryMatch[1], "web", principal.account_id, "device.recovery_bundle.read", "device", recoveryMatch[2]);
        json(res, 200, bundle);
      } catch (error) {
        this.store.audit(principal.account_id, "web", principal.account_id, "device.recovery_bundle.read_failed", "device", recoveryMatch[2], {
          targetAccountId: recoveryMatch[1],
          code: error instanceof RelayError ? error.nameCode : "INTERNAL_ERROR",
        });
        throw error;
      }
      return;
    }
    if (method === "POST" && recoveryMatch) {
      const body = asObject(await readJson(req));
      try {
        this.store.recoverDevice(
          recoveryMatch[1],
          recoveryMatch[2],
          requiredString(body.keyPackage, "keyPackage", MAX_KEY_PACKAGE_CHARS),
          principal.account_id,
        );
      } catch (error) {
        this.store.audit(principal.account_id, "web", principal.account_id, "device.recover.failed", "device", recoveryMatch[2], {
          targetAccountId: recoveryMatch[1],
          code: error instanceof RelayError ? error.nameCode : "INTERNAL_ERROR",
        });
        throw error;
      }
      json(res, 200, { recovered: true });
      return;
    }
    const webPackageMatch = /^\/api\/admin\/users\/([^/]+)\/web-package$/.exec(url.pathname);
    if (method === "POST" && webPackageMatch) {
      const target = this.store.accountById(webPackageMatch[1]);
      if (!target || target.role !== "user") throw new RelayError("NOT_FOUND", "普通用户不存在");
      const body = asObject(await readJson(req));
      const packageJson = webPackage(body.packageJson);
      const security = this.store.ensureWebSecurity(target.id);
      const current = this.store.webKeyPackage(target.id);
      const expectedVersion = integer(body.expectedVersion ?? (current ? Number(current.version) : 0), "expectedVersion");
      const operationId = optionalString(body.operationId, "operationId", 128);
      const fingerprint = createHash("sha256").update(JSON.stringify({ packageJson, expectedVersion, accountId: target.id })).digest("hex");
      const previous = operationId && this.store.webOperation(target.id, operationId, fingerprint);
      if (previous) { json(res, 200, previous); return; }
      const result = this.store.saveWebKeyPackageWithOperation(
        target.id,
        packageJson,
        expectedVersion,
        Number(security.credential_version),
        operationId,
        fingerprint,
        (saved) => ({ migrated: true, keyPackageVersion: Number(saved.version) }),
      );
      const response = result.response || { migrated: true, keyPackageVersion: Number(result.saved?.version || 0) };
      if (!result.replay) this.store.audit(target.id, "web", principal.account_id, "web.package.admin-migrate", "account", target.id, { version: Number(result.saved?.version || 0) });
      json(res, 200, response);
      return;
    }
    if (method === "GET" && url.pathname === "/api/admin/audit") {
      json(res, 200, { audit: this.store.auditRows(Math.min(500, integer(url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 200, "limit", 1))) });
      return;
    }
    if (method === "POST" && url.pathname === "/api/admin/updates") {
      const body = asObject(await readJson(req));
      const release = await this.registerUpdate(body, principal.account_id);
      this.broadcastUpdate(release.platform, release.version);
      json(res, 201, { published: true, platform: release.platform, version: release.version });
      return;
    }
    const provisionCancelMatch = /^\/api\/admin\/users\/([^/]+)\/cancel$/.exec(url.pathname);
    if (method === "POST" && provisionCancelMatch) {
      this.store.cancelAccountProvision(provisionCancelMatch[1], principal.account_id);
      json(res, 200, { cancelled: true });
      return;
    }
    const passwordResetMatch = /^\/api\/admin\/users\/([^/]+)\/password$/.exec(url.pathname);
    if (method === "POST" && passwordResetMatch) {
      const target = this.store.accountById(passwordResetMatch[1]);
      if (target?.role === "admin") throw new RelayError("FORBIDDEN", "不能通过用户管理重置管理员密码");
      const body = asObject(await readJson(req));
      const passwordHash = await hashPassword(validatePassword(body.newPassword));
      const status = this.store.resetUserPassword(passwordResetMatch[1], passwordHash, principal.account_id);
      if (status === "active") {
        this.closeAccountSockets(passwordResetMatch[1], "Password reset");
      }
      json(res, 200, { changed: true, status });
      return;
    }
    const totpMatch = /^\/api\/admin\/users\/([^/]+)\/totp$/.exec(url.pathname);
    if (method === "POST" && totpMatch) {
      const target = this.store.accountById(totpMatch[1]);
      if (!target || target.role !== "user") throw new RelayError("NOT_FOUND", "普通用户不存在");
      const body = asObject(await readJson(req));
      const enabled = body.enabled === true;
      const security = this.store.setTotpRequired(target.id, enabled);
      this.closeAccountSockets(target.id, "TOTP policy changed", undefined, true);
      this.store.audit(target.id, "web", principal.account_id, enabled ? "totp.require" : "totp.disable", "account", target.id);
      json(res, 200, { enabled: Boolean(security.totp_required), configured: Boolean(security.totp_secret) });
      return;
    }
    const accountMatch = /^\/api\/admin\/users\/([^/]+)\/(disable|enable)$/.exec(url.pathname);
    if (method === "POST" && accountMatch) {
      this.store.setAccountDisabled(accountMatch[1], accountMatch[2] === "disable", principal.account_id);
      if (accountMatch[2] === "disable") this.closeAccountSockets(accountMatch[1], "Account disabled");
      json(res, 200, { changed: true });
      return;
    }
    const hostMatch = /^\/api\/admin\/users\/([^/]+)\/hosts\/([^/]+)\/revoke$/.exec(url.pathname);
    if (method === "POST" && hostMatch) {
      this.store.revokeHost(hostMatch[1], hostMatch[2], principal.account_id);
      this.hosts.get(hostMatch[2])?.socket.close(4003, "Host revoked");
      json(res, 200, { revoked: true });
      return;
    }
    const deviceMatch = /^\/api\/admin\/users\/([^/]+)\/devices\/([^/]+)\/revoke$/.exec(url.pathname);
    if (method === "POST" && deviceMatch) {
      this.store.revokeDevice(deviceMatch[1], deviceMatch[2], principal.account_id);
      const sessions = this.devices.get(deviceMatch[2]);
      if (sessions) for (const session of sessions) session.socket.close(4003, "Device revoked");
      json(res, 200, { revoked: true });
      return;
    }
    throw new RelayError("NOT_FOUND", "管理 API 路径不存在");
  }

  private updatePrincipal(req: IncomingMessage, platform: UpdatePlatform) {
    if (platform === "android") {
      const principal = this.devicePrincipal(req);
      return { accountId: principal.account_id as string, kind: "device", id: principal.principal_id as string };
    }
    const hostToken = bearer(req);
    const host = hostToken && this.store.authenticateHost(hostToken);
    if (!host) throw new RelayError("AUTH_FAILED", "Host 更新令牌无效");
    return { accountId: host.account_id as string, kind: "host", id: host.id as string };
  }

  private webPrincipal(req: IncomingMessage) {
    const access = bearer(req);
    const principal = access && this.store.authenticateAccess(access);
    if (!principal || principal.principal_kind !== "device") throw new RelayError("AUTH_FAILED", "网页会话无效或已过期");
    const session = this.store.webSessionById(principal.id);
    if (!session) throw new RelayError("AUTH_FAILED", "网页会话无效或已过期");
    return session;
  }

  private async verifyWebProof(login: any, device: any, body: Record<string, unknown>) {
    await sodium.ready;
    const signingPublicKey = base64Bytes(device.signing_public_key, "deviceSigningPublicKey");
    const signature = base64Bytes(body.signature, "signature");
    const response = base64Bytes(body.boxResponse, "boxResponse");
    if (signingPublicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES || signature.length !== sodium.crypto_sign_BYTES) {
      throw new RelayError("INVALID_REQUEST", "设备签名证明格式无效");
    }
    const validSignature = sodium.crypto_sign_verify_detached(signature, Buffer.from(login.signing_challenge, "utf8"), signingPublicKey);
    const expected = base64Bytes(login.box_nonce, "boxNonce");
    if (!validSignature || !sodium.memcmp(response, expected)) throw new RelayError("AUTH_FAILED", "设备密钥持有证明失败");
  }

  private updateFile(relativePath: string) {
    const root = resolve(this.config.updatesDir);
    const file = resolve(root, relativePath);
    if (file !== root && !file.startsWith(`${root}${sep}`)) throw new RelayError("FORBIDDEN", "更新文件路径无效");
    return file;
  }

  private async registerUpdate(body: Record<string, unknown>, createdBy: string) {
    const manifestJson = requiredString(body.manifestJson, "manifestJson", UPDATE_MANIFEST_LIMIT);
    const manifestSignature = requiredString(body.manifestSignature, "manifestSignature", 256);
    let manifest: Record<string, unknown>;
    try { manifest = asObject(JSON.parse(manifestJson)); }
    catch { throw new RelayError("INVALID_REQUEST", "更新清单 JSON 无效"); }
    if (manifest.schemaVersion !== 1 || (manifest.platform !== "android" && manifest.platform !== "host")) {
      throw new RelayError("INVALID_REQUEST", "更新清单版本或平台无效");
    }
    const platform = manifest.platform as UpdatePlatform;
    const version = requiredString(manifest.version, "version", 32);
    if (!UPDATE_VERSION.test(version)) throw new RelayError("INVALID_REQUEST", "更新版本必须使用 x.y.z");
    const versionCode = manifest.versionCode === undefined || manifest.versionCode === null
      ? undefined
      : integer(manifest.versionCode, "versionCode", 1);
    if (platform === "android" && versionCode === undefined) throw new RelayError("INVALID_REQUEST", "Android 更新缺少 versionCode");
    const asset = asObject(manifest.asset);
    const assetName = requiredString(asset.name, "asset.name", 160);
    const expectedName = platform === "android"
      ? `Agent-Pocket-${version}-release.apk`
      : `AgentPocketHost-${version}-windows-x64.exe`;
    if (basename(assetName) !== assetName || assetName !== expectedName) throw new RelayError("INVALID_REQUEST", "更新文件名无效");
    const assetSize = integer(asset.size, "asset.size", 1);
    if (assetSize > UPDATE_MAX_BYTES[platform]) throw new RelayError("PAYLOAD_TOO_LARGE", "更新文件超过大小限制");
    const assetSha256 = requiredString(asset.sha256, "asset.sha256", 64).toLowerCase();
    if (!UPDATE_SHA256.test(assetSha256)) throw new RelayError("INVALID_REQUEST", "更新文件 SHA-256 无效");
    const assetSignature = optionalString(asset.signature, "asset.signature", 256);

    if (!this.config.updatePublicKeySpki) throw new RelayError("CONFIG_INVALID", "Relay 尚未配置更新签名公钥");
    let publicKey;
    let signature: Buffer;
    try {
      publicKey = createPublicKey({ key: Buffer.from(this.config.updatePublicKeySpki, "base64"), format: "der", type: "spki" });
      signature = Buffer.from(manifestSignature, "base64");
    } catch { throw new RelayError("INVALID_REQUEST", "更新签名或公钥格式无效"); }
    if (publicKey.asymmetricKeyType !== "ed25519" || signature.length !== 64
      || !verify(null, Buffer.from(manifestJson, "utf8"), publicKey, signature)) {
      throw new RelayError("FORBIDDEN", "更新清单签名验证失败");
    }

    const assetPath = `${platform}/${version}/${assetName}`;
    const file = this.updateFile(assetPath);
    if (!existsSync(file) || !statSync(file).isFile()) throw new RelayError("NOT_FOUND", "服务器更新文件不存在");
    const stat = statSync(file);
    if (stat.size !== assetSize || await sha256File(file) !== assetSha256) {
      throw new RelayError("CONFLICT", "服务器更新文件与签名清单不一致");
    }
    return this.store.publishUpdate({
      platform,
      version,
      versionCode,
      manifestJson,
      manifestSignature,
      assetName,
      assetPath,
      assetSize,
      assetSha256,
      assetSignature,
      createdBy,
    });
  }

  private async serveUpdateAsset(
    req: IncomingMessage,
    res: ServerResponse,
    platform: UpdatePlatform,
    version: string,
    assetName: string,
    principal: { accountId: string; kind: string; id: string },
  ) {
    if (!UPDATE_VERSION.test(version) || basename(assetName) !== assetName) throw new RelayError("NOT_FOUND", "更新文件不存在");
    const release = this.store.updateRelease(platform, version);
    if (!release || release.asset_name !== assetName) throw new RelayError("NOT_FOUND", "更新文件不存在");
    const principalKey = `${principal.kind}:${principal.id}`;
    this.consumeUpdateDownloadAttempt(principalKey);
    if (this.updateDownloadCount >= 16 || (this.updateDownloadsByPrincipal.get(principalKey) || 0) >= 2) {
      throw new RelayError("RATE_LIMITED", "更新下载繁忙，请稍后重试", { retryAfterMs: 30_000 });
    }
    this.updateDownloadCount += 1;
    this.updateDownloadsByPrincipal.set(principalKey, (this.updateDownloadsByPrincipal.get(principalKey) || 0) + 1);
    let released = false;
    const releaseSlot = () => {
      if (released) return;
      released = true;
      this.updateDownloadCount = Math.max(0, this.updateDownloadCount - 1);
      const next = Math.max(0, (this.updateDownloadsByPrincipal.get(principalKey) || 1) - 1);
      if (next) this.updateDownloadsByPrincipal.set(principalKey, next);
      else this.updateDownloadsByPrincipal.delete(principalKey);
    };
    res.once("finish", releaseSlot);
    res.once("close", releaseSlot);
    const file = this.updateFile(release.asset_path);
    const fileStat = await this.verifyUpdateAsset(file, release.asset_size, release.asset_sha256, UPDATE_MAX_BYTES[platform]);
    this.store.audit(principal.accountId, principal.kind, principal.id, "update.download", "update_release", `${platform}:${version}`, {
      assetName,
      bytes: fileStat.size,
      method: req.method,
    });
    const headers = {
      "content-type": platform === "android" ? "application/vnd.android.package-archive" : "application/vnd.microsoft.portable-executable",
      "content-length": String(fileStat.size),
      "content-disposition": `attachment; filename="${assetName}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-checksum-sha256": release.asset_sha256,
      "accept-ranges": "none",
    };
    res.writeHead(200, headers);
    if (req.method === "HEAD") { res.end(); return; }
    const stream = createReadStream(file);
    stream.once("error", () => res.destroy());
    stream.pipe(res);
  }

  private async verifyUpdateAsset(file: string, expectedSize: number, expectedSha256: string, maxBytes: number) {
    if (!existsSync(file) || !statSync(file).isFile()) throw new RelayError("NOT_FOUND", "服务器更新文件不存在");
    const before = statSync(file);
    if (before.size !== expectedSize || before.size > maxBytes) throw new RelayError("CONFLICT", "服务器更新文件大小异常");
    const fingerprint = [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(":");
    const cached = this.updateVerificationCache.get(file);
    if (cached?.fingerprint === fingerprint && cached.sha256 === expectedSha256) return before;

    let verification = this.updateVerificationsInFlight.get(file);
    if (!verification) {
      verification = sha256File(file);
      this.updateVerificationsInFlight.set(file, verification);
    }
    let actualSha256: string;
    try {
      actualSha256 = await verification;
    } finally {
      if (this.updateVerificationsInFlight.get(file) === verification) this.updateVerificationsInFlight.delete(file);
    }
    const after = statSync(file);
    const afterFingerprint = [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(":");
    if (afterFingerprint !== fingerprint || actualSha256 !== expectedSha256) {
      this.updateVerificationCache.delete(file);
      throw new RelayError("CONFLICT", "服务器更新文件完整性异常");
    }
    this.updateVerificationCache.set(file, { fingerprint, sha256: actualSha256 });
    return after;
  }

  private consumeUpdateDownloadAttempt(principalKey: string) {
    const at = Date.now();
    const current = this.updateDownloadAttempts.get(principalKey);
    if (!current || at - current.startedAt >= 60_000) {
      this.updateDownloadAttempts.set(principalKey, { startedAt: at, count: 1 });
    } else {
      if (current.count >= 10) throw new RelayError("RATE_LIMITED", "更新请求过于频繁", { retryAfterMs: 60_000 - (at - current.startedAt) });
      current.count += 1;
    }
    if (this.updateDownloadAttempts.size > 10_000) {
      for (const [key, value] of this.updateDownloadAttempts) {
        if (at - value.startedAt >= 60_000 || this.updateDownloadAttempts.size > 10_000) this.updateDownloadAttempts.delete(key);
        if (this.updateDownloadAttempts.size <= 10_000) break;
      }
    }
  }

  private broadcastUpdate(platform: UpdatePlatform, version: string) {
    this.knownUpdateVersions.set(platform, version);
    for (const sessions of this.devices.values()) {
      for (const session of sessions) if (session.hello) notification(session.socket, "update_available", { platform, version });
    }
    for (const session of this.hosts.values()) if (session.hello) notification(session.socket, "update_available", { platform, version });
    if (platform === "android") {
      void this.fcm.send(this.store.allPushTokens(), { type: "update_available", platform, version })
        .catch((error) => {
          this.store.audit(null, "system", "relay", "update.notify.failed", "update_release", `${platform}:${version}`, {
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  private checkPublishedUpdates() {
    for (const platform of ["android", "host"] as const) {
      const release = this.store.latestUpdate(platform);
      if (release && this.knownUpdateVersions.get(platform) !== release.version) this.broadcastUpdate(platform, release.version);
    }
  }

  private accountInput(body: Record<string, unknown>, username: string, passwordHash: string, role: AccountRole) {
    return {
      username,
      displayName: requiredString(body.displayName, "displayName", 80),
      passwordHash,
      role,
      signingPublicKey: validatePublicKey(body.accountSigningPublicKey, "accountSigningPublicKey"),
      encryptionPublicKey: validatePublicKey(body.accountEncryptionPublicKey, "accountEncryptionPublicKey"),
      escrowCiphertext: requiredString(body.escrowCiphertext, "escrowCiphertext", MAX_KEY_PACKAGE_CHARS),
    };
  }

  private deviceInput(body: Record<string, unknown>) {
    return {
      name: requiredString(body.deviceName, "deviceName", 80),
      signingPublicKey: validatePublicKey(body.deviceSigningPublicKey, "deviceSigningPublicKey"),
      encryptionPublicKey: validatePublicKey(body.deviceEncryptionPublicKey, "deviceEncryptionPublicKey"),
      keyPackage: optionalString(body.keyPackage, "keyPackage", MAX_KEY_PACKAGE_CHARS),
    };
  }

  private loginResult(account: any, device: any, tokens?: unknown) {
    return {
      account: this.publicAccount(account),
      device: {
        id: device.id,
        name: device.name,
        status: device.status,
        keyPackage: device.key_package || undefined,
      },
      ...(tokens ? { tokens } : {}),
    };
  }

  private publicAccount(account: any) {
    if (!account) throw new RelayError("NOT_FOUND", "用户不存在");
    return {
      id: account.id,
      username: account.username,
      displayName: account.display_name,
      role: account.role,
      signingPublicKey: account.signing_public_key,
      encryptionPublicKey: account.encryption_public_key,
    };
  }

  private devicePrincipal(req: IncomingMessage, allowPending = false) {
    const access = bearer(req);
    const principal = access && this.store.authenticateAccess(access, allowPending);
    if (!principal || principal.principal_kind !== "device") throw new RelayError("AUTH_FAILED", "设备访问令牌无效");
    if (this.store.db.prepare("SELECT 1 FROM web_devices WHERE device_id=?").get(principal.principal_id)) {
      throw new RelayError("FORBIDDEN", "网页设备必须使用网页 API");
    }
    return principal;
  }

  private adminPrincipal(req: IncomingMessage) {
    const access = parseCookies(req).ap_access;
    const principal = access && this.store.authenticateAccess(access);
    if (!principal || principal.principal_kind !== "web" || principal.role !== "admin") {
      throw new RelayError("AUTH_FAILED", "管理员会话无效或已过期");
    }
    return principal;
  }

  private requireCsrf(req: IncomingMessage) {
    const cookies = parseCookies(req);
    const header = Array.isArray(req.headers["x-csrf-token"]) ? req.headers["x-csrf-token"][0] : req.headers["x-csrf-token"];
    if (!equalText(cookies.ap_csrf, header)) throw new RelayError("FORBIDDEN", "CSRF 校验失败");
  }

  private adminCookies(res: ServerResponse, access: string, refresh: string, csrf: string) {
    const secure = this.config.publicUrl.startsWith("https:") ? "; Secure" : "";
    res.setHeader("set-cookie", [
      `ap_access=${encodeURIComponent(access)}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=900${secure}`,
      `ap_refresh=${encodeURIComponent(refresh)}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`,
      `ap_csrf=${encodeURIComponent(csrf)}; Path=/; SameSite=Strict; Max-Age=2592000${secure}`,
    ]);
  }

  private clearAdminCookies(res: ServerResponse) {
    const secure = this.config.publicUrl.startsWith("https:") ? "; Secure" : "";
    res.setHeader("set-cookie", [
      `ap_access=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
      `ap_refresh=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
      `ap_csrf=; Path=/; SameSite=Strict; Max-Age=0${secure}`,
    ]);
  }

  private serveAdmin(res: ServerResponse, pathname: string) {
    this.serveStatic(res, resolve(this.config.adminDir), pathname, false);
  }

  private serveWeb(res: ServerResponse, pathname: string) {
    this.serveStatic(res, resolve(this.config.webDir || "web/dist"), pathname.replace(/^\/app(?=\/|$)/, ""), true);
  }

  private serveStatic(res: ServerResponse, root: string, pathname: string, web: boolean) {
    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    let file = resolve(root, relative || "index.html");
    if ((file !== root && !file.startsWith(`${root}${sep}`)) || !existsSync(file) || statSync(file).isDirectory()) {
      if (web && extname(relative)) throw new RelayError("NOT_FOUND", "网页资源不存在");
      file = join(root, "index.html");
    }
    if (!existsSync(file)) throw new RelayError("NOT_FOUND", "管理后台尚未构建");
    const contentType: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".webmanifest": "application/manifest+json; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".wasm": "application/wasm",
    };
    // Release-directory dates are not content hashes. Only Vite assets may
    // receive immutable caching; index/manifest/SW must always revalidate.
    const isHashedAsset = file.startsWith(`${root}${sep}assets${sep}`) && /-[a-z0-9_-]{8,}\.(?:js|css|wasm)$/i.test(basename(file));
    res.writeHead(200, {
      "content-type": contentType[extname(file)] || "application/octet-stream",
      "cache-control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      "content-security-policy": web
        ? "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:"
        : "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    createReadStream(file).pipe(res);
  }
}
