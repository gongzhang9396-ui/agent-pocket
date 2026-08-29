import { WebSocket, WebSocketServer } from "ws";
import { assertAllowedCwd, listProjects, type BridgeConfig } from "./config.ts";
import { CodexAppServer, mapCodexBusy } from "./codex.ts";
import { DesktopAttachClient, type DesktopWaitSummary } from "./desktop-attach.ts";
import { FcmNotifier } from "./fcm.ts";
import { BridgeStore } from "./store.ts";
import {
  ErrorName,
  MAX_COMMAND_BYTES,
  MAX_DIFF_BYTES,
  PROTOCOL_VERSION,
  RpcError,
  newEvent,
  toRpcError,
  truncateUtf8,
  type BridgeEvent,
} from "./protocol.ts";

type Session = { socket: WebSocket; device?: any; hello: boolean };
type DesktopWatcher = {
  cursor?: string;
  generation: number;
  stopped: boolean;
  lastPublishedKey?: string;
  task?: Promise<void>;
};

function stringParam(value: unknown, name: string, max: number, required = true) {
  if (value === undefined || value === null) {
    if (!required) return undefined;
    throw new RpcError(ErrorName.INVALID_REQUEST, `${name} 不能为空`);
  }
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) {
    throw new RpcError(ErrorName.INVALID_REQUEST, `${name} 格式或长度无效`);
  }
  return value;
}

function intParam(value: unknown, name: string, fallback: number, max: number) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RpcError(ErrorName.INVALID_REQUEST, `${name} 必须是 0 到 ${max} 的整数`);
  }
  return value;
}

function questionAnswers(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 64 * 1024) {
    throw new RpcError(ErrorName.INVALID_REQUEST, "answers 格式或长度无效");
  }
  for (const [questionId, answer] of Object.entries(value)) {
    if (!questionId || questionId.length > 100 || !answer || typeof answer !== "object" || Array.isArray(answer)) {
      throw new RpcError(ErrorName.INVALID_REQUEST, "answers 包含无效问题");
    }
    const values = (answer as any).answers;
    if (!Array.isArray(values) || values.length < 1 || values.length > 10 || values.some((item) => typeof item !== "string" || item.length > 4000)) {
      throw new RpcError(ErrorName.INVALID_REQUEST, "answers 包含无效答案");
    }
  }
  return value;
}

export class BridgeServer {
  config: BridgeConfig;
  store: BridgeStore;
  codex: CodexAppServer;
  fcm: FcmNotifier;
  desktop?: DesktopAttachClient;
  wss?: WebSocketServer;
  sessions = new Set<Session>();
  commandOutputBytes = new Map<string, number>();
  desktopThreads = new Set<string>();
  desktopWatchers = new Map<string, DesktopWatcher>();

  constructor(config: BridgeConfig, store: BridgeStore, codex: CodexAppServer, fcm: FcmNotifier, desktop?: DesktopAttachClient) {
    this.config = config;
    this.store = store;
    this.codex = codex;
    this.fcm = fcm;
    this.desktop = desktop;
    codex.on("notification", (message) => this.onCodexNotification(message));
    codex.on("serverRequest", (message) => this.onCodexRequest(message));
    codex.on("exit", (error) => this.publish(newEvent("connection.status", { status: "codex-exited", error: error.message })));
  }

  async start() {
    this.wss = new WebSocketServer({ host: this.config.bindHost, port: this.config.port, maxPayload: MAX_DIFF_BYTES + 64 * 1024 });
    this.wss.on("connection", (socket, request) => {
      const auth = request.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const session: Session = { socket, device: this.store.authenticate(token), hello: false };
      this.sessions.add(session);
      socket.on("message", (data) => this.onMessage(session, data.toString("utf8")));
      socket.on("close", () => this.sessions.delete(session));
      socket.on("error", () => this.sessions.delete(session));
    });
    await new Promise<void>((resolve, reject) => {
      this.wss!.once("listening", resolve);
      this.wss!.once("error", reject);
    });
  }

  send(session: Session, message: unknown) {
    if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(message));
  }

  response(session: Session, id: unknown, result: unknown) {
    this.send(session, { jsonrpc: "2.0", id, result });
  }

  failure(session: Session, id: unknown, error: unknown) {
    this.send(session, { jsonrpc: "2.0", id, error: toRpcError(error).toJson() });
  }

  async onMessage(session: Session, raw: string) {
    let message: any;
    try { message = JSON.parse(raw); } catch { return this.failure(session, null, new RpcError(ErrorName.INVALID_REQUEST, "JSON 无效")); }
    const id = message.id ?? null;
    try {
      if (!message || message.jsonrpc !== "2.0") throw new RpcError(ErrorName.INVALID_REQUEST, "jsonrpc 必须为 2.0");
      if (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number") {
        throw new RpcError(ErrorName.INVALID_REQUEST, "id 必须是字符串或数字");
      }
      if (typeof message.method !== "string") throw new RpcError(ErrorName.INVALID_REQUEST, "缺少 method");
      if (message.params !== undefined && (typeof message.params !== "object" || message.params === null || Array.isArray(message.params))) {
        throw new RpcError(ErrorName.INVALID_REQUEST, "params 必须是对象");
      }
      if (session.device && !this.store.isDeviceActive(session.device.id)) {
        session.device = undefined;
        throw new RpcError(ErrorName.AUTH_FAILED, "设备令牌已撤销");
      }
      if (message.method !== "pair/claim" && !session.device) throw new RpcError(ErrorName.AUTH_FAILED, "设备令牌无效或已撤销");
      if (!["pair/claim", "bridge/hello"].includes(message.method) && !session.hello) {
        throw new RpcError(ErrorName.AUTH_FAILED, "必须先完成 bridge/hello");
      }
      const result = await this.dispatch(session, message.method, message.params || {});
      if (message.id !== undefined) this.response(session, id, result);
    } catch (error) {
      const mapped = mapCodexBusy(error);
      this.failure(session, id, mapped);
      if (mapped instanceof RpcError && mapped.nameCode === ErrorName.AUTH_FAILED) session.socket.close(4003, "authentication failed");
    }
  }

  async dispatch(session: Session, method: string, params: any) {
    switch (method) {
      case "pair/claim": {
        const claimed = this.store.claimPairing({
          pairingId: stringParam(params.pairingId, "pairingId", 64)!,
          secret: stringParam(params.secret, "secret", 128)!,
          deviceName: stringParam(params.deviceName, "deviceName", 100, false),
        });
        return claimed;
      }
      case "bridge/hello": {
        if (params.protocolVersion !== PROTOCOL_VERSION) {
          throw new RpcError(ErrorName.VERSION_UNSUPPORTED, `Bridge 协议版本应为 ${PROTOCOL_VERSION}`);
        }
        const deviceId = stringParam(params.deviceId, "deviceId", 64, false);
        if (deviceId && deviceId !== session.device.id) throw new RpcError(ErrorName.AUTH_FAILED, "deviceId 与令牌不匹配");
        const lastSeq = intParam(params.lastSeq, "lastSeq", 0, Number.MAX_SAFE_INTEGER);
        const replay = this.store.eventsAfter(lastSeq);
        session.hello = true;
        for (const event of replay) this.send(session, { jsonrpc: "2.0", method: "bridge/event", params: event });
        return {
          protocolVersion: PROTOCOL_VERSION,
          hostId: this.store.hostId(), hostName: this.config.hostName,
          deviceId: session.device.id, codexVersion: this.codex.version,
          readOnly: this.codex.readOnly, error: this.codex.compatibilityError,
          latestSeq: this.store.latestSeq(),
        };
      }
      case "push/register": {
        const token = stringParam(params.fcmToken, "fcmToken", 4096)!;
        this.store.registerPush(session.device.id, token);
        return { ok: true };
      }
      case "project/list": return { data: listProjects(this.config.projectRoots) };
      case "model/list": return this.codex.request("model/list", {
        cursor: stringParam(params.cursor, "cursor", 2048, false), limit: intParam(params.limit, "limit", 100, 200) || 100, includeHidden: false,
      });
      case "thread/list": {
        const cursor = stringParam(params.cursor, "cursor", 2048, false);
        const search = stringParam(params.search, "search", 500, false);
        const limit = intParam(params.limit, "limit", 50, 200) || 50;
        if (this.desktop && !cursor) {
          try {
            const result = await this.desktop.listThreadsNormalized(Math.min(limit, 50), search);
            this.rememberDesktopThreads(result);
            return this.applyStoredThreadOwners(result);
          } catch {
            // The plugin is experimental. Keep the existing read path available
            // when it is not running or its internal Desktop schema changes.
          }
        }
        return this.codex.request("thread/list", {
          cursor, searchTerm: search, limit,
          sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true,
        });
      }
      case "thread/read": return this.readThread(params);
      case "thread/start": return this.startThread(params);
      case "turn/start": return this.startTurn(params);
      case "turn/steer": return this.steerTurn(params);
      case "turn/interrupt": return this.interruptTurn(params);
      case "approval/respond": return this.respondApproval(params);
      case "question/respond": return this.respondQuestion(params);
      default: throw new RpcError(ErrorName.NOT_FOUND, `未知方法：${method}`);
    }
  }

  async startThread(params: any) {
    this.codex.assertWritable();
    const cwd = assertAllowedCwd(params.cwd, this.config.projectRoots);
    const text = stringParam(params.text, "text", 1024 * 1024)!;
    const model = stringParam(params.model, "model", 200, false);
    const effort = stringParam(params.effort, "effort", 32, false);
    const started = await this.codex.request("thread/start", {
      cwd, model, approvalPolicy: "on-request",
    });
    const threadId = started.thread.id;
    this.store.setThreadOwner(threadId, "bridge");
    this.desktopThreads.delete(threadId);
    const turn = await this.codex.request("turn/start", {
      threadId, input: [{ type: "text", text }], model, effort,
    });
    this.codex.markTurn(threadId, turn.turn.id);
    return { thread: started.thread, turn: turn.turn };
  }

  async startTurn(params: any) {
    const threadId = stringParam(params.threadId, "threadId", 100)!;
    const text = stringParam(params.text, "text", 1024 * 1024)!;
    if (await this.isDesktopThread(threadId)) return this.sendToDesktop(threadId, text);
    if (this.store.threadOwner(threadId) !== "bridge") {
      throw new RpcError(ErrorName.THREAD_BUSY_EXTERNAL, "任务未由 Codex Desktop 列表确认，已拒绝使用独立 app-server 写入");
    }
    this.codex.assertWritable();
    await this.codex.assertThreadControllable(threadId);
    await this.codex.request("thread/resume", { threadId });
    const result = await this.codex.request("turn/start", {
      threadId, input: [{ type: "text", text }],
      model: stringParam(params.model, "model", 200, false), effort: stringParam(params.effort, "effort", 32, false),
    });
    this.codex.markTurn(threadId, result.turn.id);
    return result;
  }

  async steerTurn(params: any) {
    const threadId = stringParam(params.threadId, "threadId", 100)!;
    const expected = stringParam(params.expectedTurnId, "expectedTurnId", 100)!;
    const text = stringParam(params.text, "text", 1024 * 1024)!;
    if (await this.isDesktopThread(threadId)) return this.sendToDesktop(threadId, text);
    if (this.store.threadOwner(threadId) !== "bridge") {
      throw new RpcError(ErrorName.THREAD_BUSY_EXTERNAL, "任务 owner 未确认为 Bridge，不能使用独立 app-server steer");
    }
    this.codex.assertWritable();
    if (this.codex.activeTurns.get(threadId) !== expected) {
      throw new RpcError(ErrorName.THREAD_BUSY_EXTERNAL, "当前活动 turn 不属于 Bridge，不能 steer");
    }
    return this.codex.request("turn/steer", {
      threadId, expectedTurnId: expected, input: [{ type: "text", text }],
    });
  }

  async interruptTurn(params: any) {
    const threadId = stringParam(params.threadId, "threadId", 100)!;
    const turnId = stringParam(params.turnId, "turnId", 100)!;
    if (await this.isDesktopThread(threadId)) {
      throw new RpcError(ErrorName.THREAD_BUSY_EXTERNAL, "Desktop 任务暂不支持从手机中断，请在 Codex Desktop 处理");
    }
    if (this.store.threadOwner(threadId) !== "bridge") {
      throw new RpcError(ErrorName.THREAD_BUSY_EXTERNAL, "任务 owner 未确认为 Bridge，不能使用独立 app-server 中断");
    }
    this.codex.assertWritable();
    if (this.codex.activeTurns.get(threadId) !== turnId) {
      throw new RpcError(ErrorName.THREAD_BUSY_EXTERNAL, "当前活动 turn 不属于 Bridge，不能中断");
    }
    const result = await this.codex.request("turn/interrupt", { threadId, turnId });
    this.codex.clearTurn(threadId, turnId);
    return result;
  }

  rememberDesktopThreads(result: any) {
    for (const thread of Array.isArray(result?.data) ? result.data : []) {
      if (typeof thread?.id !== "string" || !thread.id) continue;
      const owner = this.store.claimThreadOwner(thread.id, "desktop");
      if (owner === "desktop") this.desktopThreads.add(thread.id);
      else this.desktopThreads.delete(thread.id);
    }
  }

  applyStoredThreadOwners(result: any) {
    if (!Array.isArray(result?.data)) return result;
    return {
      ...result,
      data: result.data.map((thread: any) => {
        if (typeof thread?.id !== "string" || this.store.threadOwner(thread.id) !== "bridge") return thread;
        return {
          ...thread,
          source: "bridge",
          capabilities: { send: true, interrupt: true, approval: true, question: true },
        };
      }),
    };
  }

  async isDesktopThread(threadId: string) {
    const storedOwner = this.store.threadOwner(threadId);
    if (storedOwner === "bridge") return false;
    if (storedOwner === "desktop") return true;
    if (this.desktopThreads.has(threadId)) return true;
    if (!this.desktop) return false;
    try {
      const result = await this.desktop.listThreadsNormalized(50);
      this.rememberDesktopThreads(result);
      return this.desktopThreads.has(threadId);
    } catch {
      return false;
    }
  }

  async readThread(params: any) {
    const threadId = stringParam(params.threadId, "threadId", 100)!;
    const result = await this.codex.request("thread/read", { threadId, includeTurns: true });
    if (!(await this.isDesktopThread(threadId)) || !result?.thread || typeof result.thread !== "object") return result;
    return {
      ...result,
      thread: {
        ...result.thread,
        source: "desktop",
        capabilities: { send: true, interrupt: false, approval: false, question: false },
      },
    };
  }

  async sendToDesktop(threadId: string, text: string) {
    if (!this.desktop) throw new RpcError(ErrorName.THREAD_BUSY_EXTERNAL, "Desktop Attach 插件未连接");
    try {
      let liveSync = this.desktopWatchers.has(threadId);
      let baselineCursor: string | undefined;
      if (!liveSync) {
        try {
          const baseline = await this.desktop.waitThread(threadId, undefined, 0);
          baselineCursor = baseline.cursor;
          liveSync = true;
        } catch {
          // Older or temporarily incompatible plugins retain the Android
          // short-poll fallback. Sending through Desktop remains available.
        }
      }
      await this.desktop.sendMessage(threadId, text);
      if (liveSync) this.startDesktopWatcher(threadId, baselineCursor);
      return { ok: true, accepted: true, source: "desktop", threadId, liveSync };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RpcError(ErrorName.THREAD_BUSY_EXTERNAL, `无法通过 Codex Desktop 续写：${message}`);
    }
  }

  startDesktopWatcher(threadId: string, cursor?: string) {
    const existing = this.desktopWatchers.get(threadId);
    if (existing) {
      existing.generation += 1;
      return;
    }
    const watcher: DesktopWatcher = { cursor, generation: 1, stopped: false };
    this.desktopWatchers.set(threadId, watcher);
    watcher.task = this.runDesktopWatcher(threadId, watcher).finally(() => {
      if (this.desktopWatchers.get(threadId) === watcher) this.desktopWatchers.delete(threadId);
    });
  }

  async runDesktopWatcher(threadId: string, watcher: DesktopWatcher) {
    if (!this.desktop) return;
    try {
      while (!watcher.stopped) {
        const generationAtWait = watcher.generation;
        const result = await this.desktop.waitThread(threadId, watcher.cursor, 8_000);
        if (watcher.stopped) return;
        if (result.cursor) watcher.cursor = result.cursor;
        if (result.changed) {
          const eventKey = this.desktopWaitEventKey(result);
          if (eventKey !== watcher.lastPublishedKey) {
            watcher.lastPublishedKey = eventKey;
            this.publish(newEvent("sync.required", {
              threadId,
              turnId: result.turnId,
              reason: "desktop-wait",
              status: result.threadStatus,
              turnStatus: result.turnStatus,
              wakeReason: result.wakeReason,
            }));
          }
          if (generationAtWait === watcher.generation && this.desktopWaitIsTerminal(result)) return;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    } catch {
      if (!watcher.stopped) {
        this.publish(newEvent("sync.required", {
          threadId,
          reason: "desktop-wait-fallback",
        }));
      }
    }
  }

  desktopWaitEventKey(result: DesktopWaitSummary) {
    return result.cursor || [result.threadStatus, result.turnId, result.turnStatus, result.wakeReason].join(":");
  }

  desktopWaitIsTerminal(result: DesktopWaitSummary) {
    return ["idle", "completed"].includes(result.threadStatus || "") ||
      ["completed", "failed", "interrupted", "cancelled"].includes(result.turnStatus || "");
  }

  approvalResult(method: string, params: any, decision: string) {
    if (method === "item/permissions/requestApproval") {
      return decision === "accept" ? { permissions: params.permissions || {}, scope: "turn" } : { permissions: {} };
    }
    return { decision };
  }

  async respondApproval(params: any) {
    this.codex.assertWritable();
    const pending = this.store.pending(stringParam(params.requestId, "requestId", 100)!);
    if (!pending.method.endsWith("/requestApproval")) throw new RpcError(ErrorName.INVALID_REQUEST, "requestId 不是审批请求");
    const decision = ({ allowOnce: "accept", deny: "decline", cancel: "cancel" } as any)[stringParam(params.decision, "decision", 16)!];
    if (!decision) throw new RpcError(ErrorName.INVALID_REQUEST, "decision 仅支持 allowOnce、deny、cancel");
    const result = this.approvalResult(pending.method, pending.params, decision);
    const resolved = this.store.resolvePending(pending.request_id, result);
    if (!resolved.duplicate) this.codex.respond(pending.codex_id, result);
    return { ok: true, duplicate: resolved.duplicate };
  }

  async respondQuestion(params: any) {
    this.codex.assertWritable();
    const pending = this.store.pending(stringParam(params.requestId, "requestId", 100)!);
    if (pending.method !== "item/tool/requestUserInput") throw new RpcError(ErrorName.INVALID_REQUEST, "requestId 不是提问请求");
    const result = { answers: questionAnswers(params.answers) };
    const resolved = this.store.resolvePending(pending.request_id, result);
    if (!resolved.duplicate) this.codex.respond(pending.codex_id, result);
    return { ok: true, duplicate: resolved.duplicate };
  }

  async onCodexRequest(message: any) {
    const method = String(message.method);
    const isQuestion = method === "item/tool/requestUserInput";
    const isApproval = method.endsWith("/requestApproval");
    if (!isQuestion && !isApproval) {
      this.codex.respond(message.id, undefined, { code: -32601, message: "Unsupported server request" });
      return;
    }
    const requestId = this.store.addPending(message.id, method, message.params);
    const type = isQuestion ? "question.request" : "approval.request";
    this.publish(newEvent(type, { ...message.params, requestId }));
  }

  onCodexNotification(message: any) {
    const p = message.params || {};
    switch (message.method) {
      case "item/agentMessage/delta":
        this.publish(newEvent("message.delta", { ...p })); break;
      case "item/started":
      case "item/completed":
        if (p.item?.type === "commandExecution") {
          const item = { ...p.item };
          delete item.aggregatedOutput;
          this.publish(newEvent("command.updated", { ...p, item }));
          if (message.method === "item/completed") this.commandOutputBytes.delete(`${p.threadId || ""}:${p.turnId || ""}:${p.item.id || ""}`);
        }
        break;
      case "turn/plan/updated":
      case "item/plan/delta":
        this.publish(newEvent("plan.updated", { ...p })); break;
      case "item/commandExecution/outputDelta": {
        const key = `${p.threadId || ""}:${p.turnId || ""}:${p.itemId || ""}`;
        const used = this.commandOutputBytes.get(key) || 0;
        if (used >= MAX_COMMAND_BYTES) break;
        const raw = typeof p.delta === "string" ? p.delta : "";
        const rawBytes = Buffer.byteLength(raw, "utf8");
        const output = truncateUtf8(raw, MAX_COMMAND_BYTES - used);
        const written = Buffer.byteLength(output.value, "utf8");
        const truncated = output.truncated || used + rawBytes > MAX_COMMAND_BYTES;
        this.commandOutputBytes.set(key, truncated ? MAX_COMMAND_BYTES : used + written);
        this.publish(newEvent("command.updated", { ...p, delta: output.value, truncated, originalBytes: used + rawBytes }));
        break;
      }
      case "turn/diff/updated": {
        const diff = truncateUtf8(p.diff || "", MAX_DIFF_BYTES);
        this.publish(newEvent("diff.updated", { ...p, diff: diff.value, truncated: diff.truncated, originalBytes: diff.originalBytes }));
        break;
      }
      case "turn/started":
        if (p.threadId && p.turn?.id) this.codex.markTurn(p.threadId, p.turn.id);
        this.publish(newEvent("turn.status", { ...p, turnId: p.turn?.id, status: "started" })); break;
      case "turn/completed":
        if (p.threadId) this.codex.clearTurn(p.threadId, p.turn?.id);
        this.publish(newEvent("turn.status", { ...p, turnId: p.turn?.id, status: "completed" })); break;
      case "thread/status/changed":
        this.publish(newEvent("turn.status", { ...p })); break;
    }
  }

  publish(event: BridgeEvent) {
    const saved = this.store.appendEvent(event);
    for (const session of this.sessions) {
      if (session.device && !this.store.isDeviceActive(session.device.id)) {
        session.socket.close(4003, "device revoked");
      } else if (session.device && session.hello) {
        this.send(session, { jsonrpc: "2.0", method: "bridge/event", params: saved });
      }
    }
    if (["approval.request", "question.request"].includes(saved.type) || (saved.type === "turn.status" && (saved.payload as any)?.status === "completed")) {
      void this.fcm.send(this.store.pushTokens(), {
        hostId: this.store.hostId(), sessionId: saved.threadId || "", eventId: saved.eventId, type: saved.type,
      }).catch((error) => console.error("FCM:", error));
    }
    return saved;
  }

  async stop() {
    const watcherTasks = [...this.desktopWatchers.values()].flatMap((watcher) => watcher.task ? [watcher.task] : []);
    for (const watcher of this.desktopWatchers.values()) watcher.stopped = true;
    this.desktopWatchers.clear();
    for (const session of this.sessions) session.socket.close();
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()) || resolve());
    if (watcherTasks.length > 0) {
      await new Promise<void>((resolve) => {
        let completed = false;
        const finish = () => {
          if (completed) return;
          completed = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 12_000);
        void Promise.allSettled(watcherTasks).then(finish);
      });
    }
  }
}
