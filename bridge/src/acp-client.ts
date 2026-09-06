import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { RpcError } from "./protocol.ts";

/** JSON-RPC transport only. Model execution and session ownership live in GrokAgent. */
export class AcpClient extends EventEmitter {
  child?: ChildProcessWithoutNullStreams;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  nextId = 0;
  closed = false;
  command: string;
  args: string[];
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  constructor(command: string, args: string[], cwd: string) { super(); this.command = command; this.args = args; this.cwd = cwd; }

  start() {
    this.child = spawn(this.command, this.args, { cwd: this.cwd, env: this.environment ?? process.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      if (this.closed) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) {
        this.fail(new RpcError("AGENT_PROTOCOL", "Grok 输出超过协议上限"));
        this.child?.kill();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.method) {
          try { this.emit(message.id === undefined ? "notification" : "request", message); }
          catch { this.fail(new RpcError("AGENT_PROTOCOL", "Grok 返回了无法处理的协议消息")); this.child?.kill(); return; }
        }
        else {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(Object.assign(new RpcError("AGENT_ERROR", "Grok 请求失败；请检查电脑上的 Grok 登录和模型状态"), { acpError: message.error }));
          else pending.resolve(message.result ?? {});
        }
      }
    });
    // Drain stderr without logging credentials, config or model/tool contents.
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail(new RpcError("AGENT_OFFLINE", "Grok 连接已关闭")));
    this.child.once("error", () => this.fail(new RpcError("AGENT_UNAVAILABLE", "无法启动 Grok CLI，请在电脑安装 Grok 并登录")));
    this.child.once("close", () => { this.fail(new RpcError("AGENT_OFFLINE", "Grok 进程已退出")); this.emit("exit"); });
  }

  fail(error: Error) {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  send(value: unknown) {
    if (this.closed || !this.child?.stdin.writable) throw new RpcError("AGENT_OFFLINE", "Grok 连接已关闭");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  request(method: string, params: unknown, timeoutMs = 8_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError("AGENT_TIMEOUT", "Grok 响应超时，请检查电脑上的运行状态"));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method: string, params: unknown) { this.send({ jsonrpc: "2.0", method, params }); }
  respond(id: string | number, result: unknown) { this.send({ jsonrpc: "2.0", id, result }); }
  reject(id: string | number) { this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported client request" } }); }

  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill(), 3_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}
