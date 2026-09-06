import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { AcpClient } from "./acp-client.ts";
import { AgentTaskStore, type AgentTask } from "./agent-store.ts";
import { GrokNativeCatalog } from "./grok-native-catalog.ts";
import { assertAllowedCwd } from "./config.ts";
import type { BridgeStore } from "./store.ts";
import { ErrorName, RpcError, newEvent, truncateUtf8 } from "./protocol.ts";

type GrokInput = { cwd: string; text: string; model?: string; effort?: string; clientMessageId?: string };
type Running = { task: AgentTask; client: AcpClient; turnId: string; loading: boolean; shared: boolean; promptFinished?: boolean; currentPromptId?: string; queueVersion?: number; cancelKey?: string; historyCursor?: string | null; historyRevision?: string; interruptRequested?: boolean; lastText?: any; buffered: string; tools: Map<string, any>; timer?: NodeJS.Timeout; done?: Promise<void> };
type Permission = { run: Running; id: string | number; options: any[]; item: any };
const caps = { send: true, interrupt: true, approval: true, question: false, plan: false, goal: false, handoff: false, steer: false, attachments: false };
const CLIENT_ID = "agent-pocket";
const LIVE_CURSOR = "ap-grok-live-v1:";

export function resolveGrokCommand(command?: string) {
  if (command?.trim()) return command.trim();
  const installed = join(homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
  return existsSync(installed) ? installed : "grok";
}

export class GrokAgent extends EventEmitter {
  tasks: AgentTaskStore;
  active = new Map<string, Running>();
  permissions = new Map<string, Permission>();
  private probeFlight?: Promise<any>;
  private health?: { at: number; value: any };
  private stopped = false;
  private creating = 0;
  private creationFlights = new Map<string, Promise<any>>();
  private creations = new Set<Promise<any>>();
  private startFlights = new Map<string, { clientId?: string; work: Promise<any> }>();
  store: BridgeStore;
  roots: string[];
  command: string;
  factory: (args: string[], cwd: string) => AcpClient;
  native?: GrokNativeCatalog;
  private listSnapshots = new Map<string, { search?: string; at: number; rows: any[]; warning?: string }>();
  constructor(store: BridgeStore, roots: string[], command = resolveGrokCommand(),
    factory = (args: string[], cwd: string) => new AcpClient(command, args, cwd), native?: GrokNativeCatalog) {
    super(); this.store = store; this.roots = roots; this.command = command; this.factory = factory;
    this.native = native;
    this.tasks = new AgentTaskStore(store.db);
    native?.on("changed", (ids: string[]) => {
      if (ids.length) this.emit("event", newEvent("grok.catalog.updated", { threadIds: ids }));
    });
    for (const id of this.tasks.recover()) {
      try { if (store.pending(id).method.startsWith("grok/")) store.resolvePending(id, { decision: "cancel" }); } catch {}
    }
  }
  isThread(id: unknown) { return typeof id === "string" && id.startsWith("grok:"); }
  requireTask(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new RpcError(ErrorName.NOT_FOUND, "这个 Grok 会话不由手机管理；电脑会话可同步查看，请在原终端继续发送");
    assertAllowedCwd(task.cwd, this.roots);
    return task;
  }
  client(input: { cwd: string; model?: string; effort?: string }) {
    const args = ["agent", this.native ? "--leader" : "--no-leader"];
    if (input.model) args.push("--model", input.model);
    if (input.effort) args.push("--reasoning-effort", input.effort);
    args.push("stdio");
    const client = this.factory(args, input.cwd);
    client.environment = { ...process.env, GROK_DISABLE_AUTOUPDATER: "1" };
    return client;
  }
  async initialize(client: AcpClient) {
    client.start();
    const init = await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "agent-pocket", version: "0.3.2" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if (init.protocolVersion !== 1 || init.agentCapabilities?.loadSession !== true) throw new RpcError("VERSION_UNSUPPORTED", "请更新 Grok CLI：需要 ACP v1 和会话恢复能力");
    if (this.native) {
      const version = /^(\d+)\.(\d+)\.(\d+)/.exec(init._meta?.agentVersion || "");
      if (!version || (+version[1] === 0 || (+version[1] === 1 && +version[2] === 0 && +version[3] < 13))) {
        throw new RpcError("VERSION_UNSUPPORTED", "跨端续聊需要 Grok CLI 1.0.13 或更新版本，请在电脑更新后刷新");
      }
    }
    const methods = new Set((init.authMethods || []).map((x: any) => x.id));
    const methodId = process.env.XAI_API_KEY && methods.has("xai.api_key") ? "xai.api_key" : methods.has("cached_token") ? "cached_token" : null;
    if (methodId) {
      try { await client.request("authenticate", { methodId, _meta: { headless: true } }); }
      catch { throw new RpcError("AGENT_AUTH_REQUIRED", "请在电脑运行 grok login，完成后在手机刷新"); }
    } else if (methods.size > 0) throw new RpcError("AGENT_AUTH_REQUIRED", "请先在电脑登录 Grok CLI");
    return init;
  }
  async probe() {
    if (this.health && Date.now() - this.health.at < (this.health.value.available ? 30_000 : 3_000)) return this.health.value;
    if (this.probeFlight) return this.probeFlight;
    this.probeFlight = (async () => {
      const client = this.client({ cwd: assertAllowedCwd(this.roots[0], this.roots) });
      client.on("request", m => client.reject(m.id));
      try {
        const init = await this.initialize(client);
        const modelState = init._meta?.modelState;
        const models = (modelState?.availableModels || []).filter((m: any) => typeof m.modelId === "string").map((m: any) => ({
          id: m.modelId, model: m.modelId, displayName: m.name || m.modelId, description: m.description || "Grok CLI 模型",
          isDefault: m.modelId === modelState.currentModelId, agentId: "grok",
          supportedReasoningEfforts: (m._meta?.reasoningEfforts || []).map((r: any) => ({ reasoningEffort: r.id, description: r.description || r.label || r.id }))
            .sort((a: any, b: any) => Number(b.reasoningEffort === m._meta?.reasoningEffort) - Number(a.reasoningEffort === m._meta?.reasoningEffort)),
          defaultReasoningEffort: m._meta?.reasoningEffort,
        })).sort((a: any, b: any) => Number(b.isDefault) - Number(a.isDefault));
        return { id: "grok", name: "Grok", available: true, version: init._meta?.agentVersion, capabilities: caps, models };
      } catch (error) {
        return { id: "grok", name: "Grok", available: false, error: error instanceof RpcError ? error.message : "无法连接 Grok CLI，请在电脑检查安装和登录", capabilities: { ...caps, send: false }, models: [] };
      } finally { await client.stop(); }
    })();
    try { const value = await this.probeFlight; this.health = { at: Date.now(), value }; return value; }
    finally { this.probeFlight = undefined; }
  }
  describe(task: AgentTask) {
    const run = this.active.get(task.id);
    const waiting = [...this.permissions.values()].some(p => p.run === run);
    const latest = this.tasks.latestTurn(task.id);
    const capabilities = { ...caps, send: !this.stopped && this.health?.value.available !== false };
    return { id: task.id, agentId: "grok", name: task.title, preview: task.title, cwd: task.cwd,
      model: task.model, createdAt: Math.floor(task.createdAt / 1000), updatedAt: Math.floor(task.updatedAt / 1000),
      status: { type: run ? "active" : latest?.status === "completed" ? "completed" : latest?.status === "failed" ? "systemError" : "idle", activeFlags: waiting ? ["waitingOnApproval"] : [] },
      source: "grok", execution: { backend: "grok", owner: task.historySource === "native" ? "shared" : "host", capabilities,
        statusMessage: run?.shared ? run.loading ? "正在连接电脑上的 Grok 会话…" : run.currentPromptId === run.turnId ? undefined : "已排队，等待 Grok 开始这一轮…" : undefined }, capabilities };
  }
  describeNative(row: any) {
    const task = this.tasks.get(row.id);
    const managed = task && this.describe(task);
    const capabilities = { ...caps, send: !this.stopped && this.health?.value.available !== false, interrupt: Boolean(this.active.get(row.id)), approval: Boolean(this.active.get(row.id)) };
    return { ...row, ...(managed ? { status: managed.status } : {}),
      execution: { backend: "grok", owner: "shared", capabilities, statusMessage: managed?.execution.statusMessage }, capabilities };
  }
  async list(search?: string) {
    const managed = this.tasks.list().filter(task => {
      try { assertAllowedCwd(task.cwd, this.roots); return !search || task.title.toLowerCase().includes(search.toLowerCase()); } catch { return false; }
    }).map(task => this.describe(task));
    const native = await this.native?.list(search) ?? [];
    const nativeIds = new Set(native.map(row => row.id));
    return [...managed.filter(row => !nativeIds.has(row.id)), ...native.map(row => this.describeNative(row))]
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }
  async listPage(cursor: string | undefined, search: string | undefined, limit: number) {
    const prefix = "ap-grok-list-v1:"; let token: string, offset = 0;
    for (const [key, value] of this.listSnapshots) if (Date.now() - value.at > 5 * 60_000) this.listSnapshots.delete(key);
    if (cursor) {
      try {
        if (!cursor.startsWith(prefix)) throw new Error();
        const parsed = JSON.parse(Buffer.from(cursor.slice(prefix.length), "base64url").toString("utf8"));
        token = parsed.token; offset = parsed.offset;
        const snapshot = this.listSnapshots.get(token);
        if (!snapshot || snapshot.search !== search || !Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.rows.length) throw new Error();
      } catch { throw new RpcError(ErrorName.INVALID_REQUEST, "Grok 列表游标已失效或搜索条件不匹配，请刷新"); }
    } else {
      const rows = await this.list(search); token = randomUUID();
      while (this.listSnapshots.size >= 8) this.listSnapshots.delete(this.listSnapshots.keys().next().value!);
      this.listSnapshots.set(token, { search, at: Date.now(), rows, warning: this.native?.warning });
    }
    const snapshot = this.listSnapshots.get(token)!;
    const data: any[] = []; let size = 0;
    while (offset < snapshot.rows.length && data.length < limit) {
      const saved = snapshot.rows[offset];
      const row = saved.execution?.owner === "shared" ? this.describeNative(saved) : saved;
      try { assertAllowedCwd(row.cwd, this.roots); } catch { offset++; continue; }
      const bytes = Buffer.byteLength(JSON.stringify(row));
      if (size + bytes > 512 * 1024) break;
      data.push(row); size += bytes; offset++;
    }
    return { data, nextCursor: offset < snapshot.rows.length ? prefix + Buffer.from(JSON.stringify({ token, offset })).toString("base64url") : null, warning: snapshot.warning };
  }
  read(id: string, cursor?: string): any {
    const saved = this.tasks.get(id);
    if (this.native && (!saved || saved.historySource === "native")) return this.readNative(id, cursor);
    const task = this.requireTask(id); const page = this.tasks.read(id, cursor);
    return { thread: { ...this.describe(task), turns: page.turns }, page: page.page };
  }
  private async readNative(id: string, cursor?: string) {
    const run = this.active.get(id);
    if (!run) {
      if (cursor?.startsWith(LIVE_CURSOR)) throw new RpcError("HISTORY_CHANGED", "这一轮已保存到电脑，请刷新后继续加载历史");
      const result = await this.native!.read(id, cursor, { maxBytes: 500 * 1024 });
      result.thread = { ...result.thread, ...this.describeNative(result.thread) };
      result.page.revision += ":saved";
      const latest = this.tasks.latestTurn(id);
      if (!cursor && latest && latest.status !== "completed") {
        const notices = this.tasks.read(id, undefined, String(latest.id)).turns.flatMap(t => t.items).filter(i => i.id === `grok-notice-${latest.id}`);
        if (notices.length) result.thread.turns.push({ id: latest.id, status: latest.status, items: notices });
      }
      return result;
    }
    const revision = `${run.historyRevision ?? "new"}:live:${run.turnId}`;
    if (cursor && !cursor.startsWith(LIVE_CURSOR)) {
      const result = await this.native!.read(id, cursor);
      return { thread: { ...result.thread, ...this.describeNative(result.thread) }, page: { ...result.page, revision } };
    }
    let inner: string | undefined;
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor.slice(LIVE_CURSOR.length), "base64url").toString("utf8"));
        if (parsed.id !== id || parsed.turnId !== run.turnId || typeof parsed.cursor !== "string") throw new Error();
        inner = parsed.cursor;
      } catch { throw new RpcError("HISTORY_CHANGED", "这页流式历史已变化，请刷新后重试"); }
    }
    const live = this.tasks.read(id, inner, run.turnId, 256 * 1024);
    let turns = live.turns, nextCursor = live.page.nextCursor ? LIVE_CURSOR + Buffer.from(JSON.stringify({ id, turnId: run.turnId, cursor: live.page.nextCursor })).toString("base64url") : run.historyCursor ?? null;
    if (!live.page.hasMore && run.historyCursor) {
      const count = turns.reduce((n, t) => n + t.items.length, 0);
      if (count < 100) {
        const old = await this.native!.read(id, run.historyCursor, { maxBytes: 240 * 1024, maxItems: 100 - count });
        turns = [...old.thread.turns, ...turns]; nextCursor = old.page.nextCursor;
      }
    }
    return { thread: { ...this.describe(run.task), turns }, page: { order: "oldest_first", hasMore: nextCursor !== null, nextCursor, revision } };
  }
  validate(input: GrokInput) {
    assertAllowedCwd(input.cwd, this.roots);
    if (!input.text?.trim() || Buffer.byteLength(input.text) > 64 * 1024) throw new RpcError(ErrorName.INVALID_REQUEST, "Grok 消息需为 1–64 KiB 的文本");
    if (this.stopped) throw new RpcError("AGENT_OFFLINE", "Host 正在关闭");
    if (this.active.size + this.creating >= 4) throw new RpcError(ErrorName.THREAD_BUSY, "已有 4 个 Grok 任务在运行，请等待其中一个完成");
  }
  async create(input: GrokInput, deviceId: string) {
    const key = input.clientMessageId ? `${deviceId}:${input.clientMessageId}` : undefined;
    const existing = this.tasks.created(key);
    if (existing) return { thread: this.describe(this.requireTask(existing.id)), duplicate: true };
    const inFlight = key && this.creationFlights.get(key);
    if (inFlight) return { ...await inFlight, duplicate: true };
    this.validate(input);
    this.creating++;
    const work = this.createOnce(input, key);
    this.creations.add(work);
    if (key) this.creationFlights.set(key, work);
    try { return await work; }
    finally { this.creating--; this.creations.delete(work); if (key) this.creationFlights.delete(key); }
  }
  private async createOnce(input: GrokInput, key?: string) {
    const client = this.client(input);
    client.on("request", m => { if (!m.params?.sessionId || !this.active.has(`grok:${m.params.sessionId}`)) client.reject(m.id); });
    let task: AgentTask | undefined;
    try {
      await this.initialize(client);
      const session = await client.request("session/new", { cwd: input.cwd, mcpServers: [], _meta: { yoloMode: false, autoMode: false, modelId: input.model, reasoningEffort: input.effort, clientIdentifier: CLIENT_ID } });
      if (this.stopped) throw new RpcError("AGENT_OFFLINE", "Host 正在关闭，新任务尚未执行");
      if (typeof session.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(session.sessionId)) throw new RpcError("AGENT_PROTOCOL", "Grok 返回了无效会话 ID");
      task = this.tasks.create(session.sessionId, { ...input, model: session.models?.currentModelId || input.model, historySource: this.native ? "native" : "managed" }, key);
      client.removeAllListeners("request");
      const turn = this.run(task, input.text, input.clientMessageId, client, false);
      return { thread: this.describe(task), turn: { id: turn.turnId, status: "inProgress" } };
    } catch (error) { await client.stop(); throw error; }
  }
  async start(id: string, text: string, clientId?: string) {
    const duplicate = this.tasks.duplicate(id, clientId);
    if (duplicate) return { turn: duplicate, duplicate: true };
    const inFlight = this.startFlights.get(id);
    if (inFlight && clientId && inFlight.clientId === clientId) return { ...await inFlight.work, duplicate: true };
    if (inFlight) throw new RpcError(ErrorName.THREAD_BUSY, "Grok 正在连接这条会话，请稍后重试");
    if (this.active.has(id)) throw new RpcError(ErrorName.THREAD_BUSY, "Grok 正在执行，请等待完成或先中断");
    const saved = this.tasks.get(id);
    this.validate({ cwd: saved?.cwd ?? this.roots[0], text });
    this.creating++;
    const work = (async () => {
      let task = saved, baseline: any;
      if (this.native) {
        const metadata = await this.native.metadata(id);
        baseline = await this.native.read(id);
        if (this.stopped) throw new RpcError("AGENT_OFFLINE", "Host 正在关闭，消息尚未发送");
        task = this.tasks.adopt(metadata);
      }
      task ??= this.requireTask(id);
      const client = this.client(task);
      const run = this.run(task, text, clientId, client, true, baseline?.page);
      return { turn: { id: run.turnId, status: "inProgress" } };
    })();
    this.startFlights.set(id, { clientId, work }); this.creations.add(work);
    try { return await work; }
    finally { this.creating--; this.startFlights.delete(id); this.creations.delete(work); }
  }
  run(task: AgentTask, text: string, clientId: string | undefined, client: AcpClient, resume: boolean, baseline?: any) {
    const turnId = this.tasks.beginTurn(task.id, clientId);
    const run: Running = { task, client, turnId, loading: resume, shared: Boolean(this.native), historyCursor: baseline?.startCursor, historyRevision: baseline?.revision, buffered: "", tools: new Map() };
    this.active.set(task.id, run);
    client.on("request", m => this.permission(run, m));
    client.on("notification", m => {
      if (run.shared && m.params?.sessionId === task.nativeId && ["_x.ai/queue/changed", "x.ai/queue/changed"].includes(m.method)) {
        run.currentPromptId = m.params.runningPromptId;
        run.queueVersion = m.params.entries?.find((entry: any) => entry.id === turnId)?.version;
        this.event("sync.required", run, { reason: "grok-queue" });
        if (run.interruptRequested && !run.loading && !run.promptFinished) this.cancelRun(run);
        return;
      }
      if (m.method !== "session/update" || m.params?.sessionId !== task.nativeId || run.loading) return;
      if (run.shared && m.params?._meta?.promptId !== turnId) return;
      try { this.update(run, m.params.update); }
      catch { run.interruptRequested = true; this.cancelRun(run); }
    });
    this.writeText(run, text, "user", clientId);
    this.event("turn.status", run, { status: "started" });
    run.done = (async () => {
      let status = "failed";
      try {
        if (resume) {
          await this.initialize(client);
          if (run.interruptRequested) throw new RpcError("AGENT_CANCELLED", "任务已中断");
          await client.request("session/load", { sessionId: task.nativeId, cwd: task.cwd, mcpServers: [], _meta: { yoloMode: false, autoMode: false, clientIdentifier: CLIENT_ID } });
          run.loading = false;
        }
        if (run.interruptRequested) throw new RpcError("AGENT_CANCELLED", "任务已中断");
        const result = await client.request("session/prompt", { sessionId: task.nativeId, prompt: [{ type: "text", text }], _meta: { promptId: turnId, clientIdentifier: CLIENT_ID } }, 0);
        run.promptFinished = true;
        status = result.stopReason === "end_turn" ? "completed" : result.stopReason === "cancelled" ? "interrupted" : "failed";
        if (status === "failed") this.notice(run, "Grok 已停止这一轮，停止原因：" + String(result.stopReason || "unknown").slice(0, 100));
      } catch (error) {
        if (run.interruptRequested) status = "interrupted";
        this.flush(run);
        if (!run.interruptRequested) this.notice(run, error instanceof RpcError ? error.message : "Grok 执行失败，请检查电脑上的运行状态。");
      } finally {
        this.flush(run);
        for (const [id, p] of this.permissions) if (p.run === run) this.closePermission(id, "cancel");
        await client.stop();
        this.tasks.setStatus(turnId, status);
        if (this.native) await this.native.refresh(true).catch(() => {});
        this.active.delete(task.id);
        this.event("turn.status", run, { status });
        if (this.native) this.emit("event", newEvent("grok.catalog.updated", { threadIds: [task.id] }));
      }
    })();
    return run;
  }
  event(type: string, run: Running, payload: any) { this.emit("event", newEvent(type, { threadId: run.task.id, turnId: run.turnId, source: "grok", ...payload })); }
  notice(run: Running, text: string) {
    const item = { id: `grok-notice-${run.turnId}`, type: "agentMessage", text };
    this.tasks.put(run.task.id, run.turnId, item);
    this.event("message.delta", run, { itemId: item.id, role: "assistant", delta: text, replace: true });
  }
  cancelRun(run: Running) {
    if (!run.shared) { run.client.notify("session/cancel", { sessionId: run.task.nativeId }); return; }
    if (run.loading || run.promptFinished || run.client.closed) return;
    const key = `${run.currentPromptId}:${run.queueVersion}`;
    if (run.cancelKey === key) return;
    run.cancelKey = key;
    // Both operations are scoped to this prompt. A stale cancel cannot stop the next terminal turn.
    run.client.notify("_x.ai/queue/remove", { sessionId: run.task.nativeId, id: run.turnId, expectedVersion: run.queueVersion ?? 0, owner: CLIENT_ID });
    run.client.notify("session/cancel", { sessionId: run.task.nativeId, _meta: { promptId: run.turnId, rewindIfNoOutput: true, cancelSubagents: false } });
  }
  writeText(run: Running, text: string, role: "user" | "assistant", preferredId?: string) {
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + 8_000);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      const chunk = text.slice(offset, end); offset = end;
      const type = role === "user" ? "userMessage" : "agentMessage";
      let item = run.lastText;
      if (!item || item.type !== type || (item.text?.length || 0) + chunk.length > 8_000) {
        item = { id: preferredId && offset === end && end === text.length ? preferredId : `grok-message-${randomUUID()}`, type, text: "" };
        run.lastText = item;
      }
      item.text += chunk;
      this.tasks.put(run.task.id, run.turnId, role === "user" ? { id: item.id, type, content: [{ type: "text", text: item.text }] } : item);
      this.event("message.delta", run, { itemId: item.id, role, delta: role === "user" ? item.text : chunk, ...(role === "user" ? { replace: true, complete: true } : {}) });
    }
  }
  flush(run: Running) {
    clearTimeout(run.timer); run.timer = undefined;
    const text = run.buffered; run.buffered = "";
    if (text) this.writeText(run, text, "assistant");
  }
  update(run: Running, update: any) {
    if (!update) return;
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      run.buffered += update.content.text || "";
      if (!run.lastText || run.lastText.type === "userMessage" || run.buffered.length >= 8_000) this.flush(run);
      else run.timer ??= setTimeout(() => this.flush(run), 80);
      return;
    }
    this.flush(run);
    if (["tool_call", "tool_call_update"].includes(update.sessionUpdate) && typeof update.toolCallId === "string") {
      run.lastText = undefined;
      const id = `grok-tool-${run.turnId}-${update.toolCallId}`;
      const merged = { ...run.tools.get(id), ...update };
      run.tools.set(id, merged);
      const output = (merged.content || []).map((c: any) => c.type === "content" && c.content?.type === "text" ? c.content.text : c.type === "diff" ? `${c.path}\n${c.newText || ""}` : "").join("\n");
      const bounded = truncateUtf8(output, 32 * 1024);
      const item = { id, type: "commandExecution", command: String(merged.title || "Grok 工具").slice(0, 2000), cwd: run.task.cwd,
        status: merged.status === "completed" ? "completed" : merged.status === "failed" ? "failed" : "inProgress", aggregatedOutput: bounded.value, truncated: bounded.truncated };
      this.tasks.put(run.task.id, run.turnId, item);
      this.event("command.updated", run, { item });
    } else if (update.sessionUpdate === "plan") {
      run.lastText = undefined;
      const text = (update.entries || []).map((e: any) => `- [${e.status === "completed" ? "x" : " "}] ${e.content || ""}`).join("\n");
      const id = `grok-plan-${run.turnId}`;
      const bounded = truncateUtf8(text, 32 * 1024).value;
      this.tasks.put(run.task.id, run.turnId, { id, type: "plan", text: bounded });
      this.event("message.delta", run, { itemId: id, role: "assistant", delta: bounded, replace: true });
    }
  }
  permission(run: Running, message: any) {
    if (run.shared && (run.loading || run.promptFinished || run.currentPromptId !== run.turnId)) return;
    if (message.method !== "session/request_permission" || message.params?.sessionId !== run.task.nativeId) { run.client.reject(message.id); return; }
    // The shared leader broadcasts permissions. Do not reject another client's tool request.
    if (run.loading) return;
    this.flush(run); run.lastText = undefined;
    const tool = message.params.toolCall || {};
    const requestId = this.store.addPending(message.id, "grok/session/request_permission", { threadId: run.task.id, turnId: run.turnId });
    const item = { id: `grok-approval-${requestId}`, type: "pocketApproval", requestId,
      summary: String(tool.title || "Grok 请求执行工具").slice(0, 1000), command: truncateUtf8(tool.rawInput || tool.title || "", 8 * 1024).value, cwd: run.task.cwd };
    this.permissions.set(requestId, { run, id: message.id, options: message.params.options || [], item });
    this.tasks.put(run.task.id, run.turnId, item);
    this.event("approval.request", run, { ...item, reason: item.summary });
  }
  closePermission(requestId: string, decision: string) {
    const permission = this.permissions.get(requestId);
    if (!permission) return;
    this.permissions.delete(requestId);
    this.tasks.put(permission.run.task.id, permission.run.turnId, { ...permission.item, decision });
    this.store.resolvePending(requestId, { decision });
    this.event("sync.required", permission.run, { reason: "approval-resolved" });
  }
  respond(requestId: string, decision: string) {
    if (!["allowOnce", "deny", "cancel"].includes(decision)) throw new RpcError(ErrorName.INVALID_REQUEST, "无效的审批决定");
    const saved = this.store.pending(requestId);
    if (saved.resolved_at) return { ok: true, duplicate: true };
    const p = this.permissions.get(requestId);
    if (!p || p.run.client.closed) throw new RpcError(ErrorName.NOT_FOUND, "这次 Grok 审批已失效，请刷新任务");
    const kind = decision === "allowOnce" ? "allow_once" : "reject_once";
    const option = p.options.find(o => o.kind === kind && typeof o.optionId === "string");
    if (decision === "allowOnce" && !option) throw new RpcError(ErrorName.INVALID_REQUEST, "Grok 未提供单次允许选项，不能自动授予永久权限");
    if (decision === "cancel") { p.run.interruptRequested = true; this.cancelRun(p.run); }
    p.run.client.respond(p.id, { outcome: decision !== "cancel" && option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } });
    this.closePermission(requestId, decision);
    return { ok: true, duplicate: false };
  }
  interrupt(id: string, turnId: string) {
    this.requireTask(id);
    const run = this.active.get(id);
    if (!run || run.turnId !== turnId) throw new RpcError(ErrorName.THREAD_BUSY_EXTERNAL, "这轮 Grok 任务已结束或不属于当前 Host");
    run.interruptRequested = true;
    if (!run.loading) this.cancelRun(run);
    for (const [requestId, p] of this.permissions) if (p.run === run) this.respond(requestId, "cancel");
    return { ok: true };
  }
  async stop() {
    this.stopped = true;
    await this.native?.stop();
    this.listSnapshots.clear();
    await Promise.allSettled([...this.creations]);
    for (const run of this.active.values()) {
      try { this.interrupt(run.task.id, run.turnId); } catch {}
      await run.client.stop();
    }
    await Promise.allSettled([...this.active.values()].map(run => run.done));
    await this.probeFlight;
  }
}
