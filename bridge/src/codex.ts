import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { compareVersions } from "./config.ts";
import { ErrorName, RpcError } from "./protocol.ts";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class CodexAppServer extends EventEmitter {
  command: string;
  args: string[];
  codexHome: string;
  minVersion: string;
  child?: ChildProcessWithoutNullStreams;
  pending = new Map<number, Pending>();
  nextId = 1;
  version = "unknown";
  readOnly = true;
  compatibilityError?: string;
  activeTurns = new Map<string, string>();

  constructor(options: { command: string; args?: string[]; codexHome: string; minVersion: string }) {
    super();
    this.command = options.command;
    this.args = options.args || ["app-server", "--stdio"];
    this.codexHome = options.codexHome;
    this.minVersion = options.minVersion;
  }

  checkVersion() {
    const result = spawnSync(this.command, ["--version"], { encoding: "utf8", shell: false });
    if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || "codex --version failed");
    this.version = (result.stdout || result.stderr).trim();
    if (compareVersions(this.version, this.minVersion) < 0) {
      this.compatibilityError = `Codex ${this.version} 低于最低支持版本 ${this.minVersion}`;
      this.readOnly = true;
      return false;
    }
    return true;
  }

  async start() {
    const versionOk = this.checkVersion();
    this.child = spawn(this.command, this.args, {
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    }) as ChildProcessWithoutNullStreams;
    this.child.stderr.on("data", (chunk) => this.emit("stderr", chunk.toString("utf8")));
    this.child.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (${code ?? signal})`);
      for (const value of this.pending.values()) value.reject(error);
      this.pending.clear();
      this.emit("exit", error);
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.onLine(line));

    try {
      await this.request("initialize", {
        clientInfo: { name: "agent-pocket-bridge", version: "0.3.1" },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized");
      await this.request("model/list", { limit: 1 });
      await this.request("thread/list", { limit: 1, useStateDbOnly: true });
      this.readOnly = !versionOk;
    } catch (error) {
      this.readOnly = true;
      this.compatibilityError = error instanceof Error ? error.message : String(error);
    }
    return { version: this.version, readOnly: this.readOnly, error: this.compatibilityError };
  }

  onLine(line: string) {
    if (!line.trim()) return;
    let message: any;
    try { message = JSON.parse(line); } catch { this.emit("stderr", `non-json stdout: ${line}\n`); return; }
    if ((typeof message.id === "number" || typeof message.id === "string") && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(message.id));
      if (message.error) {
        const error = new Error(message.error.message || "Codex RPC error") as any;
        error.codexError = message.error;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.emit("serverRequest", message);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  request(method: string, params: unknown = {}, timeoutMs = 30_000) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown) {
    if (!this.child?.stdin.writable) return;
    const message: any = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  respond(id: string | number, result?: unknown, error?: unknown) {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not running");
    const message = error === undefined ? { jsonrpc: "2.0", id, result } : { jsonrpc: "2.0", id, error };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  assertWritable() {
    if (this.readOnly) throw new RpcError(ErrorName.VERSION_UNSUPPORTED, this.compatibilityError || "Codex 协议能力不兼容");
  }

  markTurn(threadId: string, turnId: string) { this.activeTurns.set(threadId, turnId); }
  clearTurn(threadId: string, turnId?: string) {
    if (!turnId || this.activeTurns.get(threadId) === turnId) this.activeTurns.delete(threadId);
  }

  async assertThreadControllable(threadId: string) {
    const response = await this.request("thread/read", { threadId, includeTurns: true });
    const status = response?.thread?.status;
    const inProgressTurn = Array.isArray(response?.thread?.turns)
      ? response.thread.turns.find((turn: any) => turn?.status === "inProgress")
      : undefined;
    if (inProgressTurn && !this.activeTurns.has(threadId)) {
      throw new RpcError(
        ErrorName.THREAD_BUSY_EXTERNAL,
        "该线程存在由 Codex Desktop 或其他 writer 启动的活动 turn",
        { turnId: inProgressTurn.id },
      );
    }
    return response;
  }

  stop() {
    if (this.child && !this.child.killed) this.child.kill();
  }
}

export function mapCodexBusy(error: unknown) {
  if (error instanceof RpcError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const data = (error as any)?.codexError?.data;
  const text = `${message} ${JSON.stringify(data || {})}`.toLowerCase();
  if (text.includes("writer") || text.includes("lock") || text.includes("already active")) {
    return new RpcError(ErrorName.THREAD_BUSY_EXTERNAL, "线程正在外部 Codex 进程中运行");
  }
  if (text.includes("active turn") || text.includes("busy")) {
    return new RpcError(ErrorName.THREAD_BUSY, message);
  }
  return error;
}
