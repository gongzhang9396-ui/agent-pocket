import { DeviceChannel, decryptAccountEnvelope, MAX_RELAY_FRAME_BYTES, ready, type DeviceKeys } from "./crypto";
import { verifiedReceipt } from './pending-writes';

type Listener = (value: any) => void;

/** Browser transport for the Relay ticket protocol and encrypted Host channels. */
export class RelayClient {
  socket?: WebSocket;
  private accessToken: string;
  private refreshToken: string;
  private sequence = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: number }>();
  private channels = new Map<string, DeviceChannel>();
  private listeners = new Set<Listener>();
  private seenEvents = new Set<string>();
  private reconnectTimer?: number;
  private closed = false;
  private connecting?: Promise<void>;
  private refreshing?: Promise<any>;
  private generation = 0;
  private readonly cursorMemory = new Map<string, number>();

  constructor(accessToken: string, refreshToken: string, readonly accountId: string, readonly deviceId: string, readonly keys: DeviceKeys, readonly contentKey?: string, private readonly onTokens?: (tokens: any) => void) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  on(listener: Listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
    const response = await fetch("/api/web/refresh", { method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: this.refreshToken }) });
    if (!response.ok) {
      const error = new Error("网页会话已失效，请重新登录");
      for (const listener of this.listeners) listener({ type: "expired", error });
      throw error;
    }
    const tokens = await response.json();
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    this.onTokens?.(tokens);
    return tokens;
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async ticket() {
    let response = await fetch("/api/web/ws-ticket", { method: "POST", credentials: "omit", headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" }, body: "{}" });
    if (response.status === 401) {
      await this.refresh();
      response = await fetch("/api/web/ws-ticket", { method: "POST", credentials: "omit", headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" }, body: "{}" });
    }
    if (!response.ok) throw new Error("无法取得实时连接票据");
    return (await response.json()).ticket as string;
  }

  async connect() {
    if (this.closed) return;
    window.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.connecting = (async () => {
      await ready();
      if (this.closed) return;
      const ticket = await this.ticket();
      if (this.closed) return;
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${protocol}://${location.host}/ws/device`, ["agentpocket.device.v1", ticket]);
      const socketGeneration = ++this.generation;
      this.socket = socket;
      socket.onmessage = (event) => { if (this.socket === socket && socketGeneration === this.generation) void this.message(String(event.data)); };
      socket.onclose = (event) => {
        if (this.socket !== socket || socketGeneration !== this.generation) return;
        for (const pending of this.pending.values()) { window.clearTimeout(pending.timer); pending.reject(new Error("实时连接已断开")); }
        this.pending.clear();
        for (const channel of this.channels.values()) channel.destroy();
        this.channels.clear();
        const explicitlyRevoked = event.code === 4003 && /revoked|forgotten/i.test(event.reason || "");
        if (event.code === 4003 && !explicitlyRevoked && !this.closed) {
          // An expired access token is recoverable while the refresh token is
          // valid. Device revocation/forgetting uses an explicit close reason
          // and falls through to the terminal revoked state below.
          void this.refresh().then(() => this.connect()).catch(() => undefined);
          for (const listener of this.listeners) listener({ type: "closed", code: event.code, recovering: true });
          return;
        }
        for (const listener of this.listeners) listener({ type: explicitlyRevoked ? "revoked" : "closed", code: event.code });
        if (!this.closed && event.code !== 4003) {
          window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = undefined; void this.connect().catch((error) => { for (const listener of this.listeners) listener({ type: "error", error }); this.scheduleReconnect(); }); }, Math.min(30000, 1000 + Math.random() * 2000));
        }
      };
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("实时连接失败")); });
      await this.request("relay/hello", { protocolVersion: 2 });
      if (this.closed) return;
      for (const listener of this.listeners) listener({ type: "connected" });
    })().catch((error) => { this.scheduleReconnect(); throw error; }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async reconnect() { if (this.closed) return; await this.connect(); }

  private cursorKey(hostId: string) { return `agent-pocket-web-cursor:${this.accountId}:${this.deviceId}:${hostId}`; }
  private readCursor(hostId: string) { const key = this.cursorKey(hostId); const memory = this.cursorMemory.get(key); if (memory !== undefined) return memory; try { return Number(sessionStorage.getItem(key) || 0); } catch { return 0; } }
  private writeCursor(hostId: string, value: number) { const key = this.cursorKey(hostId); this.cursorMemory.set(key, value); try { sessionStorage.setItem(key, String(value)); } catch { /* private browsing */ } }
  private scheduleReconnect() { if (this.closed || this.reconnectTimer !== undefined || this.connecting) return; this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = undefined; void this.connect().catch(() => this.scheduleReconnect()); }, Math.min(30000, 1000 + Math.random() * 2000)); }

  private async message(raw: string) {
    let message: any;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.id !== undefined) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      window.clearTimeout(pending.timer);
      if (message.error) { const error: any = Object.assign(new Error(message.error.message), message.error); error.nameCode = message.error.data?.name || message.error.nameCode; error.detail = message.error.data?.detail; pending.reject(error); } else pending.resolve(message.result);
      return;
    }
    if (message.method === "channel/open") {
      for (const listener of this.listeners) listener({ type: "channel-open", params: message.params?.envelope || message.params });
      return;
    }
    if (message.method === "channel/data") {
      const envelope = message.params?.envelope;
      const channel = envelope && this.channels.get(envelope.channelId);
      if (!channel) return;
      try { const value = channel.decrypt(envelope); for (const listener of this.listeners) listener({ type: "channel-data", value }); }
      catch (error) { for (const listener of this.listeners) listener({ type: "error", error }); }
      return;
    }
    if (message.method === "relay/event" && this.contentKey) {
      try {
        const envelope = message.params?.envelope || message.params;
        const seq = Number(message.params?.seq || message.params?.hostSeq || 0);
        const hostId = envelope.hostId || message.params?.hostId;
        const cursor = hostId ? this.readCursor(hostId) : 0;
        const identity = `${hostId || ""}:${envelope.eventId || envelope.counter}:${seq}`;
        if (this.seenEvents.has(identity)) return;
        if (seq > 0 && seq <= cursor) return;
        if (hostId && seq > cursor + 1) { for (const listener of this.listeners) listener({ type: "gap", hostId, cursor, nextSeq: seq }); void this.recover(hostId, cursor); return; }
        this.seenEvents.add(identity);
        const value = decryptAccountEnvelope(this.contentKey, envelope);
        if (hostId && seq > 0) this.writeCursor(hostId, seq);
        for (const listener of this.listeners) listener({ type: "event", value, seq, hostId });
        if (this.seenEvents.size > 4096) this.seenEvents.delete(this.seenEvents.values().next().value!);
      } catch (error) { for (const listener of this.listeners) listener({ type: "error", error }); }
      return;
    }
    for (const listener of this.listeners) listener({ type: message.method, params: message.params });
  }

  private async recover(hostId: string, cursor: number) {
    try {
      const result = await this.replay(hostId, cursor);
      for (const event of result.eventsAfter || []) for (const listener of this.listeners) listener({ type: "event", value: event.payload, seq: event.seq, hostId, replayed: true });
      for (const listener of this.listeners) listener({ type: "recovered", hostId, cursor: this.readCursor(hostId) });
    } catch (error) { for (const listener of this.listeners) listener({ type: "error", error, hostId }); }
  }

  request(method: string, params: any) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("实时连接未连接"));
    const id = this.sequence++;
    const promise = new Promise<any>((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(id); reject(new Error(`请求超时: ${method}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
    });
    try { this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); } catch (error) { const pending = this.pending.get(id); if (pending) { window.clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error instanceof Error ? error : new Error(String(error))); } }
    return promise;
  }

  async listHosts() { return this.request("host/list", {}); }
  async snapshot(hostId: string) { const value = await this.request("snapshot/get", { hostId }); if (!value || !this.contentKey) return value; const envelope = value.envelope || value; return { ...decryptAccountEnvelope(this.contentKey, envelope), revision: Number(envelope.counter || 0), updatedAt: value.updatedAt }; }
  async replay(hostId: string, lastSeq?: number) { const cursor = lastSeq ?? this.readCursor(hostId); const value = await this.request("event/replay", { hostId, lastSeq: cursor }); if (!this.contentKey) return { eventsAfter: Array.isArray(value) ? value : (value.eventsAfter || []) }; const eventsAfter = (Array.isArray(value) ? value : (value.eventsAfter || [])).map((event: any) => ({ ...event, payload: decryptAccountEnvelope(this.contentKey!, event.envelope || event) })); const max = eventsAfter.reduce((current: number, event: any) => Math.max(current, Number(event.seq || 0)), cursor); if (max > cursor) this.writeCursor(hostId, max); return { eventsAfter }; }
  async openChannel(host: any) {
    const generation = this.generation;
    const channel = await DeviceChannel.open(this.keys, this.accountId, { ...host, deviceId: this.deviceId },
      (method, params) => this.request(method, params), (handler, fail) => this.on((value) => {
        if (value.type === "channel-open") handler(value.params);
        if (["closed", "revoked", "expired"].includes(value.type)) fail(new Error("实时连接已断开"));
      }));
    if (this.closed || generation !== this.generation) { channel.destroy(); throw new Error("实时连接已变化，请重新连接 Host"); }
    this.channels.set(channel.channelId, channel); return channel;
  }
  async call(channel: DeviceChannel, method: string, params: any) {
    const id = this.sequence++;
    const inner = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (channel.estimateFrameBytes(inner, id) > MAX_RELAY_FRAME_BYTES) throw Object.assign(new Error("加密信封超过 Relay 单帧大小"), { notSent: true });
    let timer = 0; let off = () => {};
    const result = new Promise<any>((resolve, reject) => {
      off = this.on((value) => {
        if (["closed", "expired", "revoked"].includes(value.type)) { reject(new Error("实时连接已断开，操作结果待确认")); return; }
        if (value.type !== "channel-data" || value.value?.id !== id) return;
        if (value.value.error) {
          const error: any = Object.assign(new Error(value.value.error.message), value.value.error);
          error.nameCode = value.value.error.data?.name || value.value.error.nameCode;
          error.detail = value.value.error.data?.detail; reject(error);
        } else resolve(value.value.result);
      });
      timer = window.setTimeout(() => reject(new Error(`加密通道请求超时: ${method}`)), 30000);
    });
    try {
      // Observe both promises immediately: a relay failure must not leave an
      // orphaned inner timeout/rejection or an approval listener behind.
      const envelope = channel.encrypt(inner);
      return (await Promise.all([this.request("channel/data", { envelope }), result]))[1];
    } finally { off(); window.clearTimeout(timer); }
  }
  async operation(channel: DeviceChannel, operationId: string) { return verifiedReceipt(await this.call(channel, "operation/get", { operationId }), operationId); }
  async close() { this.closed = true; for (const listener of this.listeners) listener({ type: "closed" }); this.listeners.clear(); window.clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.generation++; for (const channel of this.channels.values()) channel.destroy(); this.channels.clear(); for (const pending of this.pending.values()) { window.clearTimeout(pending.timer); pending.reject(new Error("实时连接已关闭")); } this.pending.clear(); this.socket?.close(); this.socket = undefined; }
}
