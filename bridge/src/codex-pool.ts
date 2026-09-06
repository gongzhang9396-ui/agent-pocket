import { randomUUID } from "node:crypto";
import { CodexAppServer, type CodexOptions } from "./codex.ts";
import { ErrorName, RpcError } from "./protocol.ts";

type Worker = {
  client: CodexAppServer;
  threads: Set<string>;
  ready: Promise<unknown>;
  releasing: boolean;
  revision: number;
  uncertain: boolean;
  operations: number;
};

const READ_METHODS = new Set(["thread/read", "thread/turns/list", "thread/goal/get"]);
const busy = (message: string) => new RpcError(ErrorName.THREAD_BUSY, message);

/**
 * A read-only catalog plus one process per root task. Workers share CODEX_HOME
 * (and native history), never a writer. Closing one also closes its idle children.
 */
export class CodexThreadPool extends CodexAppServer {
  private readonly options: CodexOptions;
  private readonly factory: (options: CodexOptions) => CodexAppServer;
  private readonly workers = new Set<Worker>();
  private readonly byThread = new Map<string, Worker>();
  private readonly pins = new Map<string, number>();
  private readonly serverRequests = new Map<string, { worker: Worker; id: string | number }>();
  private readonly maxWorkers: number;

  constructor(options: CodexOptions, factory = (config: CodexOptions) => new CodexAppServer(config), maxWorkers = 8) {
    super(options);
    this.options = options;
    this.factory = factory;
    this.maxWorkers = maxWorkers;
  }

  /** Holds an entire Bridge operation, including gaps between its RPC calls. */
  pinThread(threadId: string) {
    if (this.byThread.get(threadId)?.releasing) throw busy("任务正在交接，请稍后重试");
    this.pins.set(threadId, (this.pins.get(threadId) || 0) + 1);
    return () => {
      const remaining = (this.pins.get(threadId) || 1) - 1;
      if (remaining) this.pins.set(threadId, remaining); else this.pins.delete(threadId);
    };
  }

  private track(worker: Worker, threadId: string) {
    if (!threadId) return;
    worker.threads.add(threadId);
    this.byThread.set(threadId, worker);
  }

  private async newWorker(threadId?: string) {
    // Reclaim a provably idle worker only when capacity is needed. This avoids
    // repeatedly cold-starting the task currently being used on the phone.
    if (this.workers.size >= this.maxWorkers) {
      for (const candidate of this.workers) {
        const id = candidate.threads.values().next().value;
        if (!id || candidate.releasing) continue;
        try { await this.releaseThread(id); } catch { continue; }
        if (this.workers.size < this.maxWorkers) break;
      }
    }
    if (this.workers.size >= this.maxWorkers) throw busy("打开的任务执行器已满，请先结束或交接一个空闲任务");
    // Another request may have allocated this task while capacity was freed.
    if (threadId && this.byThread.has(threadId)) return this.byThread.get(threadId)!;
    const client = this.factory(this.options);
    const worker: Worker = { client, threads: new Set(), ready: Promise.resolve(), releasing: false, revision: 0, uncertain: false, operations: 0 };
    this.workers.add(worker);
    if (threadId) this.track(worker, threadId);
    client.on("stderr", (text) => this.emit("stderr", text));
    client.on("notification", (message) => {
      const params = message.params || {};
      // Read APIs can emit deprecation/account notices. Only task activity can
      // invalidate the idle snapshot; notices do not acquire a writer or run work.
      if (/^(thread\/|turn\/|item\/)/.test(message.method) && message.method !== "thread/tokenUsage/updated") worker.revision += 1;
      if (message.method === "thread/started") this.track(worker, params.thread?.id);
      if (message.method === "turn/started" && params.threadId && params.turn?.id) this.markTurn(params.threadId, params.turn.id);
      if (message.method === "turn/completed" && params.threadId) this.clearTurn(params.threadId, params.turn?.id);
      if (message.method === "serverRequest/resolved") {
        for (const [key, value] of this.serverRequests) {
          if (value.worker === worker && value.id === params.requestId) this.serverRequests.delete(key);
        }
      }
      this.emit("notification", message);
    });
    client.on("serverRequest", (message) => {
      worker.revision += 1;
      // Native request IDs restart in each process. The phone and persisted
      // pending-request store see a unique token; replies retain the native type.
      const id = randomUUID();
      this.serverRequests.set(id, { worker, id: message.id });
      this.emit("serverRequest", { ...message, id });
    });
    client.on("exit", (error) => {
      this.forgetWorker(worker);
      if (!worker.releasing) {
        for (const threadId of worker.threads) this.emit("notification", {
          method: "thread/status/changed", params: { threadId, status: { type: "systemError" } },
        });
        this.emit("workerExit", error);
      }
    });
    worker.ready = client.start().then(() => client.assertWritable()).catch((error) => {
      // No task RPC has run before initialization completes. Startup failures
      // without a process have no exit event to free their reserved capacity.
      worker.releasing = true;
      if (!client.child?.pid) this.forgetWorker(worker);
      else void client.closeGracefully().catch(() => {});
      throw error;
    });
    return worker;
  }

  private forgetWorker(worker: Worker) {
    this.workers.delete(worker);
    for (const id of worker.threads) {
      if (this.byThread.get(id) === worker) { this.byThread.delete(id); this.clearTurn(id); }
    }
    for (const [key, request] of this.serverRequests) if (request.worker === worker) this.serverRequests.delete(key);
  }

  isThreadUncertain(threadId: string) { return this.byThread.get(threadId)?.uncertain === true; }

  override async request(method: string, params: any = {}, timeoutMs = 30_000): Promise<any> {
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (method !== "thread/start" && !threadId) return super.request(method, params, timeoutMs);
    let worker = threadId ? this.byThread.get(threadId) : undefined;
    if (READ_METHODS.has(method) && (!worker || worker.releasing)) return super.request(method, params, timeoutMs);
    const canLoad = method === "thread/start" || method === "thread/resume" || method === "thread/goal/set" || method === "thread/goal/clear";
    if (!worker && !canLoad) throw new RpcError(ErrorName.THREAD_BUSY_EXTERNAL, "该任务的执行器不在当前 Host 中，请刷新任务状态");
    let allocated = false;
    if (!worker) { worker = await this.newWorker(threadId); allocated = true; }
    if (worker.releasing) throw busy("任务正在交接，请稍后重试");
    if (worker.uncertain && !READ_METHODS.has(method) && method !== "turn/interrupt") throw busy("之前的操作结果尚不确定，请先查看任务状态");
    worker.operations += 1;
    let invokedMutation = false;
    try {
      await worker.ready;
      invokedMutation = !READ_METHODS.has(method);
      if (allocated && method.startsWith("thread/goal/")) await worker.client.request("thread/resume", { threadId });
      const result = await worker.client.request(method, params, timeoutMs);
      if (result?.thread?.id) this.track(worker, result.thread.id);
      return result;
    } catch (error) {
      if (invokedMutation && !(error as any)?.codexError && !(error instanceof RpcError)) worker.uncertain = true;
      // A rejected initial resume can leave an empty process around. Never
      // close a timed-out create/resume: it may have succeeded upstream.
      if (allocated && !worker.uncertain && !worker.client.pending.size && !this.hasPendingRequests(worker)) {
        try {
          const loaded = await worker.client.request("thread/loaded/list", { limit: 1 });
          if (Array.isArray(loaded?.data) && !loaded.data.length && !loaded.nextCursor) {
            worker.releasing = true;
            void worker.client.closeGracefully().catch(() => {});
          }
        } catch { /* Unknown state keeps the process intact. */ }
      }
      throw error;
    } finally {
      worker.operations -= 1;
    }
  }

  override respond(id: string | number, result?: unknown, error?: unknown) {
    const pending = this.serverRequests.get(String(id));
    if (!pending) throw new RpcError(ErrorName.NOT_FOUND, "这个确认请求的执行器已经退出，请刷新任务");
    pending.worker.client.respond(pending.id, result, error);
    this.serverRequests.delete(String(id));
  }

  private hasPendingRequests(worker: Worker) {
    return [...this.serverRequests.values()].some((request) => request.worker === worker);
  }

  private assertIdleLocally(worker: Worker) {
    if (worker.uncertain) throw busy("之前的操作结果尚不确定，请先确认任务状态");
    if (worker.operations || worker.client.pending.size || this.hasPendingRequests(worker)) throw busy("任务还有待处理的请求，请先完成确认或回答");
    if ([...worker.threads].some((id) => this.activeTurns.has(id) || this.pins.has(id))) throw busy("任务仍在运行或处理操作，请结束后再交接");
  }

  async releaseThread(threadId: string) {
    const worker = this.byThread.get(threadId);
    if (!worker) return { released: true, alreadyReleased: true };
    if (worker.releasing) throw busy("任务正在释放，请稍后重试");
    this.assertIdleLocally(worker);
    worker.releasing = true;
    try {
      await worker.ready;
      const revision = worker.revision;
      const loaded = await worker.client.request("thread/loaded/list", { limit: 100 });
      if (!Array.isArray(loaded?.data) || loaded.nextCursor || loaded.data.some((id: unknown) => typeof id !== "string")) {
        throw busy("无法完整确认执行器中的任务，请稍后重试");
      }
      // Include the root even if an upstream unload has removed its subscription.
      for (const id of new Set<string>([threadId, ...loaded.data])) {
        const [read, goal, terminals, queue] = await Promise.all([
          worker.client.request("thread/read", { threadId: id, includeTurns: true }),
          worker.client.request("thread/goal/get", { threadId: id }),
          worker.client.request("thread/backgroundTerminals/list", { threadId: id, limit: 1 }),
          worker.client.request("thread/queue/list", { threadId: id, limit: 1 }),
        ]);
        if (read?.thread?.status?.type !== "idle" || !Array.isArray(read.thread.turns) || read.thread.turns.some((turn: any) => !["completed", "failed", "interrupted"].includes(turn.status))) {
          throw busy("任务或子任务尚未空闲，请结束后再交接");
        }
        if (!goal || !("goal" in goal) || (goal.goal !== null && goal.goal?.status !== "complete")) throw busy("任务有尚未结束的持续目标，请先完成或清除目标");
        if (!Array.isArray(terminals?.data) || terminals.data.length || terminals.nextCursor) throw busy("任务有后台命令，请先在当前执行器中结束它们");
        if (!Array.isArray(queue?.data) || queue.data.length || queue.nextCursor) throw busy("任务还有排队指令，请处理后再交接");
      }
      const after = await worker.client.request("thread/loaded/list", { limit: 100 });
      if (after.nextCursor || !Array.isArray(after.data) || [...after.data].sort().join("\n") !== [...loaded.data].sort().join("\n") || worker.revision !== revision) {
        throw busy("检查期间任务状态发生变化，请稍后重试");
      }
      this.assertIdleLocally(worker);
      await worker.client.closeGracefully();
      return { released: true, alreadyReleased: false };
    } catch (error) {
      if (!worker.client.closing) worker.releasing = false;
      if (error instanceof RpcError) throw error;
      throw busy("尚不能确认任务已安全释放；请确认 Codex 版本及任务状态后重试");
    }
  }

  override stop() {
    for (const worker of this.workers) worker.client.stop();
    super.stop();
  }
}
