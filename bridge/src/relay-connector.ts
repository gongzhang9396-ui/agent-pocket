import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { toRpcError, type BridgeEvent } from "./protocol.ts";
import type { BridgeServer } from "./server.ts";
import type { BridgeStore } from "./store.ts";
import {
  HostChannelCrypto,
  applyHostEnrollment,
  createHostIdentity,
  encryptAccountPayload,
  loadHostIdentity,
  saveHostIdentity,
  type HostIdentity,
  type RelayCipherEnvelope,
  type RelayPeer,
} from "./relay-crypto.ts";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

function relayHttpUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname))) {
    throw new Error("Relay 地址必须使用 https://；仅本机测试可用 http://");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed;
}

function relayWsUrl(value: string) {
  const parsed = relayHttpUrl(value);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = `${parsed.pathname}/ws/host`.replace(/\/+/g, "/");
  return parsed.href;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const SNAPSHOT_DEBOUNCE_MS = 1_000;
const SNAPSHOT_RETRY_MS = 15_000;
const SNAPSHOT_REFRESH_MS = 60_000;

function eventType(event: BridgeEvent): "attention" | "completed" | "status" {
  if (event.type === "approval.request" || event.type === "question.request") return "attention";
  if (event.type === "turn.status" && (event.payload as any)?.status === "completed") return "completed";
  return "status";
}

export class RelayConnector extends EventEmitter {
  private socket?: WebSocket;
  private connectingSocket?: WebSocket;
  private stopped = false;
  private connected = false;
  private requestId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly channels = new Map<string, HostChannelCrypto>();
  private loopTask?: Promise<void>;
  private outbound = Promise.resolve();
  private unsubscribeEvents?: () => void;
  private backoffTimer?: NodeJS.Timeout;
  private wakeBackoff?: () => void;
  private snapshotTimer?: NodeJS.Timeout;
  readonly relayUrl: string;
  readonly identityPath: string;
  readonly identity: HostIdentity;
  readonly bridge: BridgeServer;
  readonly store: BridgeStore;

  constructor(
    relayUrl: string,
    identityPath: string,
    identity: HostIdentity,
    bridge: BridgeServer,
    store: BridgeStore,
  ) {
    super();
    this.relayUrl = relayUrl;
    this.identityPath = identityPath;
    this.identity = identity;
    this.bridge = bridge;
    this.store = store;
    if (!identity.hostId || !identity.accountId || !identity.hostToken || !identity.contentKey) {
      throw new Error("Relay Host 尚未完成手机绑定");
    }
  }

  start() {
    if (this.loopTask) return;
    this.unsubscribeEvents = this.bridge.subscribeRelayEvents((event) => this.enqueueEvent(event));
    this.loopTask = this.reconnectLoop();
  }

  async stop() {
    this.stopped = true;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    this.socket?.close(1000, "Host stopping");
    this.connectingSocket?.terminate();
    this.wakeBackoff?.();
    await this.loopTask;
    this.loopTask = undefined;
  }

  private async reconnectLoop() {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        backoff = 1000;
      } catch (error) {
        if (!this.stopped) {
          this.emit("status", { connected: false, error: error instanceof Error ? error.message : String(error) });
          await this.waitForBackoff(backoff + Math.floor(Math.random() * 500));
          backoff = Math.min(30_000, backoff * 2);
        }
      }
    }
  }

  private async connectOnce() {
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const candidate = new WebSocket(relayWsUrl(this.relayUrl), {
        headers: { Authorization: `Bearer ${this.identity.hostToken}` },
        maxPayload: 4 * 1024 * 1024,
      });
      this.connectingSocket = candidate;
      const cleanup = () => {
        candidate.off("error", onError);
        candidate.off("close", onClose);
        if (this.connectingSocket === candidate) this.connectingSocket = undefined;
      };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error("Relay 连接在握手前关闭")); };
      candidate.once("error", onError);
      candidate.once("close", onClose);
      candidate.once("open", () => {
        cleanup();
        resolve(candidate);
      });
    });
    this.socket = socket;
    const closed = new Promise<void>((resolve) => socket.once("close", () => {
      this.rejectPending("Relay 连接已断开");
      resolve();
    }));
    socket.on("message", (raw) => void this.onMessage(raw.toString("utf8")));
    socket.on("error", () => undefined);
    const heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 30_000);
    try {
      await this.request("relay/hello", { protocolVersion: 2, hostId: this.identity.hostId });
      this.connected = true;
      this.outbound = this.outbound.then(async () => {
        await this.syncBacklog();
        await this.sendSnapshot();
      });
      this.emit("status", { connected: true });
      await this.outbound;
      await closed;
    } finally {
      clearInterval(heartbeat);
      if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
      this.snapshotTimer = undefined;
      this.connected = false;
      this.channels.clear();
      if (this.socket === socket) this.socket = undefined;
      this.rejectPending("Relay 连接已断开");
    }
    if (!this.stopped) throw new Error("Relay 连接已断开");
  }

  private request(method: string, params: unknown, timeoutMs = 30_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Relay 当前离线"));
    const id = this.requestId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Relay 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private rejectPending(message: string) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private waitForBackoff(ms: number) {
    return new Promise<void>((resolve) => {
      const finish = () => {
        if (this.backoffTimer) clearTimeout(this.backoffTimer);
        this.backoffTimer = undefined;
        this.wakeBackoff = undefined;
        resolve();
      };
      this.wakeBackoff = finish;
      this.backoffTimer = setTimeout(finish, ms);
      if (this.stopped) finish();
    });
  }

  private async onMessage(raw: string) {
    let message: any;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.id !== undefined) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || "Relay 请求失败"), message.error));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    try {
      if (message.method === "channel/open") await this.openChannel(message.params);
      else if (message.method === "channel/data") await this.handleChannelData(message.params);
      else if (message.method === "channel/close") await this.closeChannel(message.params);
      else if (message.method === "update_available" && message.params?.platform === "host") this.emit("update_available", message.params);
    } catch (error) {
      console.error("Relay channel:", error instanceof Error ? error.message : error);
      const channelId = message.params?.envelope?.channelId;
      if (typeof channelId === "string") this.channels.delete(channelId);
    }
  }

  private async openChannel(params: any) {
    const envelope = params?.envelope as RelayCipherEnvelope;
    const peer = params?.peer as RelayPeer;
    if (!envelope || !peer) throw new Error("Relay 通道握手缺少 peer 或 envelope");
    if (this.channels.has(envelope.channelId)) throw new Error("Relay 通道已经存在");
    const accepted = await HostChannelCrypto.accept(this.identity, envelope, peer);
    saveHostIdentity(this.identityPath, this.identity);
    this.channels.set(envelope.channelId, accepted.channel);
    await this.request("channel/open", { envelope: accepted.response });
  }

  private async handleChannelData(params: any) {
    const envelope = params?.envelope as RelayCipherEnvelope;
    const channel = envelope && this.channels.get(envelope.channelId);
    if (!channel) throw new Error("Relay 通道不存在");
    const request = JSON.parse(channel.decrypt(envelope));
    if (!request || request.jsonrpc !== "2.0" || (typeof request.id !== "string" && typeof request.id !== "number")
      || typeof request.method !== "string" || (request.params !== undefined && (!request.params || typeof request.params !== "object" || Array.isArray(request.params)))) {
      throw new Error("加密通道中的 JSON-RPC 请求无效");
    }
    let response: unknown;
    try {
      response = {
        jsonrpc: "2.0",
        id: request.id,
        result: await this.bridge.dispatchRelay(channel.peer.id, request.method, request.params || {}),
      };
    } catch (error) {
      response = { jsonrpc: "2.0", id: request.id, error: toRpcError(error).toJson() };
    }
    await this.request("channel/data", { envelope: channel.encrypt(JSON.stringify(response)) });
  }

  private async closeChannel(params: any) {
    const envelope = params?.envelope as RelayCipherEnvelope | undefined;
    if (!envelope) return;
    const channel = this.channels.get(envelope.channelId);
    if (!channel) return;
    channel.decrypt(envelope, true);
    this.channels.delete(envelope.channelId);
  }

  private enqueueEvent(event: BridgeEvent & { seq: number }) {
    if (!this.connected || event.seq <= this.identity.lastBridgeSeq) return;
    this.scheduleSnapshot(SNAPSHOT_DEBOUNCE_MS);
    this.outbound = this.outbound.then(() => this.publishEvent(event)).catch((error) => {
      console.error("Relay event upload:", error instanceof Error ? error.message : error);
    });
  }

  /**
   * Keep the Relay snapshot fresh even when Desktop Attach was not ready during
   * the first upload. Event-driven refreshes are debounced; failures retry with
   * a bounded delay, and the periodic refresh also catches archive changes that
   * do not produce an app-server notification on older Codex versions.
   */
  private scheduleSnapshot(delayMs: number) {
    if (this.stopped || !this.connected) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      if (this.stopped || !this.connected) return;
      this.outbound = this.outbound.then(() => this.sendSnapshot()).catch((error) => {
        console.error("Relay snapshot queue:", error instanceof Error ? error.message : error);
      });
    }, delayMs);
    this.snapshotTimer.unref?.();
  }

  private async syncBacklog() {
    await this.flushPendingEvent();
    let events: Array<BridgeEvent & { seq: number }>;
    try {
      events = this.store.eventsAfter(this.identity.lastBridgeSeq) as Array<BridgeEvent & { seq: number }>;
    } catch {
      this.identity.lastBridgeSeq = this.store.latestSeq();
      this.identity.pendingEvent = undefined;
      saveHostIdentity(this.identityPath, this.identity);
      return;
    }
    for (const event of events) await this.publishEvent(event);
  }

  private async flushPendingEvent() {
    const pending = this.identity.pendingEvent;
    if (!pending) return;
    await this.request("event/append", { envelope: pending.envelope });
    this.identity.eventCounter = pending.envelope.counter;
    this.identity.lastBridgeSeq = pending.bridgeSeq;
    this.identity.pendingEvent = undefined;
    saveHostIdentity(this.identityPath, this.identity);
  }

  private async publishEvent(event: BridgeEvent & { seq: number }) {
    if (!this.connected || event.seq <= this.identity.lastBridgeSeq) return;
    if (this.identity.pendingEvent && (this.identity.pendingEvent.bridgeSeq !== event.seq || this.identity.pendingEvent.eventId !== event.eventId)) {
      throw new Error("Relay 事件 outbox 与本地事件序列不一致");
    }
    if (!this.identity.pendingEvent) {
      const counter = this.identity.eventCounter + 1;
      const envelope = await encryptAccountPayload(this.identity, {
        accountId: this.identity.accountId!,
        hostId: this.identity.hostId!,
        deviceId: this.identity.hostId!,
        channelId: "events",
        counter,
        kind: "event.append",
        eventId: event.eventId,
        eventType: eventType(event),
      }, event);
      this.identity.pendingEvent = { bridgeSeq: event.seq, eventId: event.eventId, envelope };
      saveHostIdentity(this.identityPath, this.identity);
    }
    await this.flushPendingEvent();
  }

  private async flushPendingSnapshot() {
    const pending = this.identity.pendingSnapshot;
    if (!pending) return;
    await this.request("snapshot/put", { envelope: pending.envelope });
    this.identity.snapshotCounter = pending.envelope.counter;
    this.identity.pendingSnapshot = undefined;
    saveHostIdentity(this.identityPath, this.identity);
  }

  private async sendSnapshot() {
    if (!this.connected) return;
    try {
      await this.flushPendingSnapshot();
      const threads = await this.bridge.dispatchRelay("relay-snapshot", "thread/list", { limit: 200 });
      const counter = this.identity.snapshotCounter + 1;
      const envelope = await encryptAccountPayload(this.identity, {
        accountId: this.identity.accountId!,
        hostId: this.identity.hostId!,
        deviceId: this.identity.hostId!,
        channelId: "snapshot",
        counter,
        kind: "snapshot.put",
      }, { at: new Date().toISOString(), threads });
      this.identity.pendingSnapshot = { envelope };
      saveHostIdentity(this.identityPath, this.identity);
      await this.flushPendingSnapshot();
      this.scheduleSnapshot(SNAPSHOT_REFRESH_MS);
    } catch (error) {
      console.error("Relay snapshot upload:", error instanceof Error ? error.message : error);
      this.scheduleSnapshot(SNAPSHOT_RETRY_MS);
    }
  }
}

export async function beginHostEnrollment(relayUrl: string, hostName: string, identityPath: string) {
  const base = relayHttpUrl(relayUrl);
  let identity = loadHostIdentity(identityPath);
  if (!identity) {
    identity = await createHostIdentity(base.href.replace(/\/$/, ""), hostName);
    saveHostIdentity(identityPath, identity);
  }
  if (identity.hostToken) throw new Error("这台 Host 已经完成 Relay 绑定");
  const response = await fetch(new URL("api/host/enroll/start", `${base.href.replace(/\/$/, "")}/`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: hostName,
      signingPublicKey: identity.signingPublicKey,
      encryptionPublicKey: identity.encryptionPublicKey,
    }),
  });
  const enrollment = await response.json() as any;
  if (!response.ok) throw new Error(enrollment?.error?.message || "Relay Host 绑定初始化失败");
  return { identity, enrollment };
}

export async function waitForHostEnrollment(
  relayUrl: string,
  identityPath: string,
  identity: HostIdentity,
  enrollment: { id: string; secret: string; expiresAt: number },
  onStatus?: (status: { approved: boolean; completed: boolean; expiresAt: number }) => void,
) {
  const base = relayHttpUrl(relayUrl);
  const endpoint = (path: string) => new URL(path, `${base.href.replace(/\/$/, "")}/`);
  while (Date.now() < enrollment.expiresAt) {
    await delay(2000);
    const statusResponse = await fetch(endpoint("api/host/enroll/status"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollmentId: enrollment.id, secret: enrollment.secret }),
    });
    const status = await statusResponse.json() as any;
    if (!statusResponse.ok) throw new Error(status?.error?.message || "读取 Host 绑定状态失败");
    onStatus?.({
      approved: Boolean(status.approved),
      completed: Boolean(status.completed),
      expiresAt: Number(status.expiresAt || enrollment.expiresAt),
    });
    if (!status.approved) continue;
    const completeResponse = await fetch(endpoint("api/host/enroll/complete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollmentId: enrollment.id, secret: enrollment.secret }),
    });
    const completed = await completeResponse.json() as any;
    if (!completeResponse.ok) throw new Error(completed?.error?.message || "完成 Host 绑定失败");
    await applyHostEnrollment(identity, completed);
    saveHostIdentity(identityPath, identity);
    return identity;
  }
  throw new Error("Host 绑定二维码已过期，请重新执行绑定");
}
