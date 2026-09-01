import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { assertAllowedCwd, type BridgeConfig } from "./config.ts";
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
  /** One-shot bootstrap recovery: re-queue this prompt if the first turn dies. */
  recoveryText?: string;
};

const MAINTENANCE_BLOCKED_METHODS = new Set([
  "thread/start",
  "turn/start",
  "turn/steer",
  "approval/respond",
  "question/respond",
]);

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

function desktopOperationError(action: string, error: unknown) {
  const mapped = mapCodexBusy(error);
  if (mapped instanceof RpcError) return mapped;
  const message = error instanceof Error ? error.message : String(error);
  if (/当前不支持|握手未声明能力|协议版本不兼容|版本过旧/i.test(message)) {
    return new RpcError(ErrorName.VERSION_UNSUPPORTED, "Desktop Attach 版本过旧；请在 Codex Desktop 新建一个任务以加载最新版插件");
  }
  if (/插件未运行|无法连接 Desktop Attach|连接已关闭|ENOENT|caller thread id/i.test(message)) {
    return new RpcError(ErrorName.NOT_FOUND, "Desktop Attach 尚未就绪；请在 Codex Desktop 新建任务并调用 desktop_attach_probe");
  }
  if (/task was not found|任务不存在|找不到任务/i.test(message)) {
    return new RpcError(ErrorName.NOT_FOUND, "Codex Desktop 中找不到这个任务");
  }
  if (/failed to initialize|function_call_output requires call_id|previous_response_id.*WebSocket v2/i.test(message)) {
    return new RpcError(
      ErrorName.VERSION_UNSUPPORTED,
      "当前 Codex 走 HTTP Responses，Desktop 插件新建和续写都需要 Responses WebSocket v2，因此任务没有真正跑起来。已有任务请先在电脑上的 Codex Desktop 继续；要从手机操作，请改用支持 WebSocket v2 的官方 ChatGPT 通道，或更新 Desktop/模型代理后再试",
    );
  }
  return new RpcError("INTERNAL", `${action}失败；请在 Codex Desktop 确认任务状态后重试`);
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
  desktopWatchers = new Map<string, DesktopWatcher>();
  relayEventListeners = new Set<(event: BridgeEvent & { seq: number }) => void>();
  runtimeStatusTimer?: NodeJS.Timeout;
  inFlightMutations = 0;

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
    this.writeRuntimeStatus();
    this.runtimeStatusTimer = setInterval(() => this.writeRuntimeStatus(), 5_000);
    this.runtimeStatusTimer.unref();
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
    if (!MAINTENANCE_BLOCKED_METHODS.has(method)) return this.dispatchUnchecked(session, method, params);
    if (this.maintenanceRequested()) {
      throw new RpcError(ErrorName.HOST_MAINTENANCE, "Host 正在准备更新，暂不接受新的任务操作");
    }
    this.inFlightMutations += 1;
    this.writeRuntimeStatus();
    try {
      return await this.dispatchUnchecked(session, method, params);
    } finally {
      this.inFlightMutations = Math.max(0, this.inFlightMutations - 1);
      this.writeRuntimeStatus();
    }
  }

  async dispatchUnchecked(session: Session, method: string, params: any) {
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
      case "project/list": {
        if (!this.desktop) throw new RpcError(ErrorName.NOT_FOUND, "Desktop Attach 插件未连接，无法读取 Codex Desktop 项目");
        let result: any;
        try {
          result = await this.desktop.listProjectsNormalized();
        } catch (error) {
          throw desktopOperationError("无法读取 Codex Desktop 项目", error);
        }
        const projects = [] as any[];
        let excluded = 0;
        for (const project of Array.isArray(result?.data) ? result.data : []) {
          try {
            projects.push({ ...project, cwd: assertAllowedCwd(project.cwd, this.config.projectRoots) });
          } catch (error) {
            if (error instanceof RpcError && error.nameCode === ErrorName.PATH_DENIED) {
              excluded += 1;
              continue;
            }
            throw error;
          }
        }
        const warning = projects.length === 0
          ? excluded > 0
            ? "Codex Desktop 的已保存项目都不在 Bridge 项目白名单内"
            : "Codex Desktop 尚未保存可用的本地项目"
          : undefined;
        return { ...result, data: projects, excluded, warning };
      }
      case "model/list": return this.codex.request("model/list", {
        cursor: stringParam(params.cursor, "cursor", 2048, false), limit: intParam(params.limit, "limit", 100, 200) || 100, includeHidden: false,
      });
      case "thread/list": {
        const cursor = stringParam(params.cursor, "cursor", 2048, false);
        const search = stringParam(params.search, "search", 500, false);
        const limit = intParam(params.limit, "limit", 50, 200) || 50;
        if (this.desktop) {
          if (cursor) throw new RpcError(ErrorName.INVALID_REQUEST, "Codex Desktop 任务列表暂不支持 cursor 分页");
          try {
            const result = await this.desktop.listThreadsNormalized(Math.min(limit, 50), search);
            this.rememberDesktopThreads(result);
            return this.applyStoredThreadOwners(result);
          } catch (error) {
            throw desktopOperationError("无法读取 Codex Desktop 任务列表", error);
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

  async dispatchRelay(deviceId: string, method: string, params: any) {
    if (method === "pair/claim" || method === "push/register") {
      throw new RpcError(ErrorName.AUTH_FAILED, "该方法只能通过本地 Bridge 连接调用");
    }
    if (method === "bridge/hello") {
      if (params.protocolVersion !== PROTOCOL_VERSION) {
        throw new RpcError(ErrorName.VERSION_UNSUPPORTED, `Bridge 协议版本应为 ${PROTOCOL_VERSION}`);
      }
      const claimedDeviceId = stringParam(params.deviceId, "deviceId", 64, false);
      if (claimedDeviceId && claimedDeviceId !== deviceId) throw new RpcError(ErrorName.AUTH_FAILED, "deviceId 与 Relay 身份不匹配");
      return {
        protocolVersion: PROTOCOL_VERSION,
        hostId: this.store.hostId(),
        hostName: this.config.hostName,
        deviceId,
        codexVersion: this.codex.version,
        readOnly: this.codex.readOnly,
        error: this.codex.compatibilityError,
        latestSeq: this.store.latestSeq(),
      };
    }
    const virtual = { device: { id: deviceId }, hello: true } as Session;
    return this.dispatch(virtual, method, params || {});
  }

  subscribeRelayEvents(listener: (event: BridgeEvent & { seq: number }) => void) {
    this.relayEventListeners.add(listener);
    return () => this.relayEventListeners.delete(listener);
  }

  async startThread(params: any) {
    const target = stringParam(params.target, "target", 32, false)?.trim() || "bridge";
    if (target !== "desktop" && target !== "bridge") {
      throw new RpcError(ErrorName.INVALID_REQUEST, "target 仅支持 desktop 或 bridge");
    }
    const cwd = assertAllowedCwd(params.cwd, this.config.projectRoots);
    const text = stringParam(params.text, "text", 1024 * 1024)!;
    const model = stringParam(params.model, "model", 200, false)?.trim() || undefined;
    const effort = stringParam(params.effort, "effort", 32, false)?.trim() || undefined;
    const clientMessageId = stringParam(params.clientMessageId, "clientMessageId", 128, false)?.trim() || undefined;
    if (target === "desktop") {
      const workspaceMode = stringParam(params.workspaceMode, "workspaceMode", 32, false)?.trim() || "local";
      if (workspaceMode !== "local") {
        throw new RpcError(ErrorName.INVALID_REQUEST, "Desktop 新任务的 workspaceMode 仅支持 local");
      }
      if (!this.desktop) throw new RpcError(ErrorName.NOT_FOUND, "Desktop Attach 插件未连接，无法在 Desktop 新建任务");
      try {
        const created = await this.desktop.createThread(cwd, text, model, effort, workspaceMode);
        const threadId = typeof created?.thread?.id === "string" ? created.thread.id.trim() : "";
        if (!threadId) throw new Error("Desktop Attach 返回的新任务缺少 thread.id");
        const owner = this.store.claimThreadOwner(threadId, "desktop");
        if (owner !== "desktop") throw new Error("新任务 ID 已被其他 writer 占用");
        this.publishDesktopMessage(threadId, clientMessageId, "user", text, { complete: true });
        // The attach plugin only re-queues bootstrap failures it can observe
        // within its short verify window; later deaths are recovered by the
        // watcher. Skip watcher recovery when the plugin already re-queued.
        const pluginRequeued = typeof (created as any)?.warning === "string" && (created as any).warning.includes("re-queued");
        this.startDesktopWatcher(threadId, undefined, pluginRequeued ? undefined : text);
        return {
          ...created,
          source: "desktop",
          thread: {
            ...created.thread,
            id: threadId,
            cwd,
            source: "desktop",
            capabilities: { send: true, interrupt: false, approval: false, question: false },
          },
        };
      } catch (error) {
        throw desktopOperationError("无法通过 Codex Desktop 新建任务", error);
      }
    }

    this.codex.assertWritable();
    const started = await this.codex.request("thread/start", {
      cwd, model, approvalPolicy: "on-request",
    });
    const threadId = started.thread.id;
    this.store.setThreadOwner(threadId, "bridge");
    const turn = await this.codex.request("turn/start", {
      threadId, input: [{ type: "text", text }], model, effort,
    });
    this.codex.markTurn(threadId, turn.turn.id);
    this.writeRuntimeStatus();
    return { thread: started.thread, turn: turn.turn };
  }

  async startTurn(params: any) {
    const threadId = stringParam(params.threadId, "threadId", 100)!;
    const text = stringParam(params.text, "text", 1024 * 1024)!;
    const clientMessageId = stringParam(params.clientMessageId, "clientMessageId", 128, false)?.trim() || undefined;
    if (this.store.threadOwner(threadId) !== "bridge") return this.sendToDesktop(threadId, text, clientMessageId);
    this.codex.assertWritable();
    await this.codex.assertThreadControllable(threadId);
    await this.codex.request("thread/resume", { threadId });
    const result = await this.codex.request("turn/start", {
      threadId, input: [{ type: "text", text }],
      model: stringParam(params.model, "model", 200, false), effort: stringParam(params.effort, "effort", 32, false),
    });
    this.codex.markTurn(threadId, result.turn.id);
    this.writeRuntimeStatus();
    return result;
  }

  async steerTurn(params: any) {
    const threadId = stringParam(params.threadId, "threadId", 100)!;
    const expected = stringParam(params.expectedTurnId, "expectedTurnId", 100)!;
    const text = stringParam(params.text, "text", 1024 * 1024)!;
    const clientMessageId = stringParam(params.clientMessageId, "clientMessageId", 128, false)?.trim() || undefined;
    if (this.store.threadOwner(threadId) !== "bridge") return this.sendToDesktop(threadId, text, clientMessageId);
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
    if (this.store.threadOwner(threadId) !== "bridge") {
      await this.readDesktopThread(threadId, 1);
      throw new RpcError(ErrorName.THREAD_BUSY_EXTERNAL, "Desktop 任务暂不支持从手机中断，请在 Codex Desktop 处理");
    }
    this.codex.assertWritable();
    if (this.codex.activeTurns.get(threadId) !== turnId) {
      throw new RpcError(ErrorName.THREAD_BUSY_EXTERNAL, "当前活动 turn 不属于 Bridge，不能中断");
    }
    const result = await this.codex.request("turn/interrupt", { threadId, turnId });
    this.codex.clearTurn(threadId, turnId);
    this.writeRuntimeStatus();
    return result;
  }

  rememberDesktopThreads(result: any) {
    for (const thread of Array.isArray(result?.data) ? result.data : []) {
      if (typeof thread?.id !== "string" || !thread.id) continue;
      this.store.claimThreadOwner(thread.id, "desktop");
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

  async readThread(params: any) {
    const threadId = stringParam(params.threadId, "threadId", 100)!;
    if (this.store.threadOwner(threadId) === "bridge") {
      return this.codex.request("thread/read", { threadId, includeTurns: true });
    }
    const cursor = stringParam(params.cursor, "cursor", 4096, false);
    if (cursor !== undefined && !cursor.trim()) {
      throw new RpcError(ErrorName.INVALID_REQUEST, "cursor 格式或长度无效");
    }
    return this.readDesktopThread(threadId, 10, cursor);
  }

  async readDesktopThread(threadId: string, turnLimit = 10, cursor?: string) {
    if (!this.desktop) throw new RpcError(ErrorName.NOT_FOUND, "Desktop Attach 插件未连接");
    let result: any;
    try {
      result = await this.desktop.readThreadNormalized(threadId, turnLimit, cursor);
    } catch (error) {
      throw desktopOperationError("无法通过 Codex Desktop 读取任务", error);
    }
    if (!result?.thread || typeof result.thread !== "object") {
      throw new RpcError("INTERNAL", "Codex Desktop 返回的任务详情不完整");
    }
    const cwd = assertAllowedCwd(result.thread.cwd, this.config.projectRoots);
    const owner = this.store.claimThreadOwner(threadId, "desktop");
    if (owner !== "desktop") {
      throw new RpcError(ErrorName.NOT_FOUND, "该任务由 Bridge app-server 管理，不能通过 Desktop Attach 接管");
    }
    const turns = Array.isArray(result.thread.turns) ? result.thread.turns : [];
    const existingItemIds = new Set(turns.flatMap((turn: any) =>
      Array.isArray(turn?.items) ? turn.items.map((item: any) => item?.id).filter((id: unknown) => typeof id === "string") : [],
    ));
    const overlayItems = cursor
      ? []
      : this.desktopOverlayItems(threadId).filter((item: any) => !existingItemIds.has(item.id));
    const overlayTurn = overlayItems.length > 0
      ? { id: `agent-pocket-overlay-${threadId}`, status: "completed", items: overlayItems }
      : undefined;
    const mergedTurns = !overlayTurn
      ? turns
      : result?.page?.order === "newest_first"
        ? [overlayTurn, ...turns]
        : [...turns, overlayTurn];
    return {
      ...result,
      thread: {
        ...result.thread,
        cwd,
        turns: mergedTurns,
        source: "desktop",
        capabilities: { send: true, interrupt: false, approval: false, question: false },
      },
    };
  }

  desktopOverlayItems(threadId: string) {
    const latest = new Map<string, { seq: number; item: any }>();
    for (const event of this.store.eventsForThread(threadId, "message.delta")) {
      const payload = event.payload as any;
      if (payload?.source !== "desktop" || payload?.replace !== true) continue;
      const itemId = typeof payload.itemId === "string" ? payload.itemId : "";
      const role = payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : undefined;
      const text = typeof payload.delta === "string" ? payload.delta : undefined;
      if (!itemId || !role || text === undefined) continue;
      latest.set(itemId, {
        seq: event.seq || 0,
        item: role === "user"
          ? { id: itemId, type: "userMessage", content: [{ type: "text", text }] }
          : { id: itemId, type: "agentMessage", text },
      });
    }
    return [...latest.values()].sort((left, right) => left.seq - right.seq).map((entry) => entry.item);
  }

  publishDesktopMessage(
    threadId: string,
    itemId: string | undefined,
    role: "user" | "assistant",
    text: string,
    options: { turnId?: string; complete: boolean; truncated?: boolean },
  ) {
    const limited = truncateUtf8(text, MAX_COMMAND_BYTES);
    const resolvedItemId = itemId || `desktop-${role}-${options.turnId || randomUUID()}`;
    this.publish(newEvent("message.delta", {
      threadId,
      turnId: options.turnId,
      itemId: resolvedItemId,
      role,
      delta: limited.value,
      complete: options.complete,
      replace: true,
      source: "desktop",
      truncated: options.truncated === true || limited.truncated,
    }));
    return resolvedItemId;
  }

  async sendToDesktop(threadId: string, text: string, clientMessageId?: string) {
    if (!this.desktop) throw new RpcError(ErrorName.NOT_FOUND, "Desktop Attach 插件未连接");
    await this.readDesktopThread(threadId, 1);
    try {
      let cursor = this.desktopWatchers.get(threadId)?.cursor;
      if (!this.desktopWatchers.has(threadId)) {
        try { cursor = (await this.desktop.waitThread(threadId, undefined, 0)).cursor; } catch {}
      }
      await this.desktop.sendMessage(threadId, text);
      const messageId = this.publishDesktopMessage(threadId, clientMessageId, "user", text, { complete: true });
      this.startDesktopWatcher(threadId, cursor);
      return { ok: true, accepted: true, source: "desktop", threadId, messageId, liveSync: true };
    } catch (error) {
      throw desktopOperationError("无法通过 Codex Desktop 续写", error);
    }
  }

  startDesktopWatcher(threadId: string, cursor?: string, recoveryText?: string) {
    const existing = this.desktopWatchers.get(threadId);
    if (existing) {
      existing.generation += 1;
      if (recoveryText && !existing.recoveryText) existing.recoveryText = recoveryText;
      return;
    }
    const watcher: DesktopWatcher = { cursor, generation: 1, stopped: false, recoveryText };
    this.desktopWatchers.set(threadId, watcher);
    this.writeRuntimeStatus();
    watcher.task = this.runDesktopWatcher(threadId, watcher).finally(() => {
      if (this.desktopWatchers.get(threadId) === watcher) this.desktopWatchers.delete(threadId);
      this.writeRuntimeStatus();
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
          const terminal = this.desktopWaitIsTerminal(result);
          if (typeof result.assistantText === "string" && result.assistantText) {
            this.publishDesktopMessage(
              threadId,
              `desktop-agent-${result.turnId || result.cursor || "current"}`,
              "assistant",
              result.assistantText,
              {
                turnId: result.turnId,
                complete: terminal,
                truncated: result.assistantTextTruncated,
              },
            );
          }
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
          const bootstrapDied = result.turnStatus === "failed" || result.threadStatus === "systemError";
          if (bootstrapDied && watcher.recoveryText) {
            // The first turn died after creation (typical on third-party HTTP
            // model channels, where Desktop's stateful bootstrap needs the
            // official Responses WebSocket v2). Re-deliver the prompt once via
            // the stateless queue path and keep watching for the recovery turn.
            const recoveryText = watcher.recoveryText;
            watcher.recoveryText = undefined;
            try {
              await this.desktop.sendMessage(threadId, recoveryText);
              watcher.generation += 1;
              this.publish(newEvent("sync.required", { threadId, reason: "bootstrap-requeue" }));
              continue;
            } catch (error) {
              console.error("Desktop bootstrap requeue:", error instanceof Error ? error.message : error);
            }
          }
          if (generationAtWait === watcher.generation && terminal) return;
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
        this.writeRuntimeStatus();
        this.publish(newEvent("turn.status", { ...p, turnId: p.turn?.id, status: "started" })); break;
      case "turn/completed":
        if (p.threadId) this.codex.clearTurn(p.threadId, p.turn?.id);
        this.writeRuntimeStatus();
        this.publish(newEvent("turn.status", { ...p, turnId: p.turn?.id, status: "completed" })); break;
      case "thread/status/changed":
        this.publish(newEvent("turn.status", { ...p })); break;
    }
  }

  publish(event: BridgeEvent) {
    const saved = this.store.appendEvent(event);
    for (const listener of this.relayEventListeners) {
      try { listener(saved); } catch (error) { console.error("Relay event listener:", error); }
    }
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
    if (this.runtimeStatusTimer) {
      clearInterval(this.runtimeStatusTimer);
      this.runtimeStatusTimer = undefined;
    }
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
    this.writeRuntimeStatus(false);
  }

  runtimeStatus(running = true) {
    const maintenance = this.maintenanceRequest();
    return {
      version: 1,
      pid: process.pid,
      running,
      activeTaskCount: new Set([
        ...this.codex.activeTurns.keys(),
        ...this.desktopWatchers.keys(),
      ]).size + this.inFlightMutations,
      maintenance: Boolean(maintenance),
      maintenanceRequestId: maintenance?.requestId,
      updatedAt: new Date().toISOString(),
    };
  }

  maintenanceRequested() {
    return Boolean(this.maintenanceRequest());
  }

  maintenanceRequest() {
    const path = this.config.maintenancePath;
    if (!path || !existsSync(path)) return undefined;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; requestId?: unknown; expiresAt?: unknown };
      if (value.version !== 1 || typeof value.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId)
        || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) {
        return undefined;
      }
      return { requestId: value.requestId, expiresAt: value.expiresAt };
    } catch {
      return undefined;
    }
  }

  writeRuntimeStatus(running = true) {
    const path = this.config.runtimeStatusPath;
    if (!path) return;
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(this.runtimeStatus(running))}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      console.error("Host runtime status:", error);
    }
  }
}
