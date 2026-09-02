import net from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

const IPC_PROTOCOL_VERSION = 1;
const MAX_IPC_MESSAGE_BYTES = 2 * 1024 * 1024;

type DesktopAttachRegistration = {
  protocolVersion: number;
  instanceId: string;
  pipeName: string;
  token: string;
  pid: number;
  startedAt: string;
  readOnly: boolean;
  capabilities: string[];
};

export type DesktopWaitSummary = {
  cursor?: string;
  changed: boolean;
  threadStatus?: string;
  turnId?: string;
  turnStatus?: string;
  wakeReason?: string;
  timedOut: boolean;
  assistantText?: string;
  assistantTextTruncated?: boolean;
};

export type DesktopCreateResult = {
  source: "desktop";
  hostId?: string;
  thread: {
    id: string;
    name?: string;
    cwd?: string;
    source?: "desktop";
    status?: unknown;
    capabilities?: unknown;
  };
};

export type DesktopProject = {
  id: string;
  name: string;
  cwd: string;
  source: "desktop";
};

export type DesktopThreadRead = {
  source: "desktop";
  thread: Record<string, unknown> & {
    id: string;
    cwd: string;
    source: "desktop";
    turns: unknown[];
    capabilities: { send: true; interrupt: false; approval: false; question: false };
  };
  [key: string]: unknown;
};

function desktopContentJson(response: any, context: string) {
  const items = Array.isArray(response?.contentItems) ? response.contentItems : [];
  const text = items.find((item: any) => item?.type === "inputText" && typeof item.text === "string")?.text;
  if (!text) throw new Error(`Desktop Attach ${context} 缺少 JSON 内容`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Desktop Attach ${context} 返回格式不兼容`);
  }
}

export function normalizeDesktopThreadList(response: any, search?: string) {
  const payload = desktopContentJson(response, "任务列表");
  const rows = [
    ...(Array.isArray(payload?.pinnedThreads) ? payload.pinnedThreads : []),
    ...(Array.isArray(payload?.threads) ? payload.threads : []),
  ];
  const query = search?.trim().toLocaleLowerCase("zh-CN");
  const seen = new Set<string>();
  const data = rows.flatMap((thread: any) => {
    if (!thread || typeof thread !== "object" || thread.kind !== "codex") return [];
    if (thread.archived === true || thread.isArchived === true || thread.archivedAt != null) return [];
    const id = typeof thread.id === "string" ? thread.id.trim() : "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const title = typeof thread.title === "string" ? thread.title : "";
    const preview = typeof thread.summary === "string" ? thread.summary : "";
    const cwd = typeof thread.cwd === "string" ? thread.cwd : "";
    if (query && !`${title}\n${preview}\n${cwd}`.toLocaleLowerCase("zh-CN").includes(query)) return [];
    return [{
      id,
      name: title || preview.split(/\r?\n/, 1)[0]?.slice(0, 80) || "未命名任务",
      preview,
      cwd,
      updatedAt: Number.isSafeInteger(thread.updatedAt) ? thread.updatedAt : 0,
      status: { type: "active", desktopState: typeof thread.status === "string" ? thread.status : "unknown" },
      source: "desktop",
      capabilities: { send: true, interrupt: false, approval: false, question: false },
    }];
  });
  return { data, source: "desktop", readOnly: false };
}

export function normalizeDesktopProjectList(response: any) {
  const payload = desktopContentJson(response, "项目列表");
  const rows = Array.isArray(payload?.projects) ? payload.projects : [];
  const seen = new Set<string>();
  const data: DesktopProject[] = rows.flatMap((project: any) => {
    if (!project || typeof project !== "object" || project.projectKind !== "local") return [];
    const id = typeof project.projectId === "string" ? project.projectId.trim() : "";
    const cwd = typeof project.path === "string" ? project.path.trim() : "";
    if (!id || !cwd || !isAbsolute(cwd) || seen.has(id)) return [];
    seen.add(id);
    const label = typeof project.label === "string" ? project.label.trim() : "";
    return [{ id, name: label || basename(cwd) || "未命名项目", cwd, source: "desktop" as const }];
  });
  return { data, source: "desktop" as const };
}

export function normalizeDesktopThreadRead(response: any, expectedThreadId?: string): DesktopThreadRead {
  const payload = desktopContentJson(response, "任务详情");
  const rawThread = payload?.thread;
  if (!rawThread || typeof rawThread !== "object" || Array.isArray(rawThread)) {
    throw new Error("Desktop Attach 任务详情缺少 thread");
  }
  const id = typeof rawThread.id === "string" ? rawThread.id.trim() : "";
  const cwd = typeof rawThread.cwd === "string" ? rawThread.cwd.trim() : "";
  if (!id || (expectedThreadId && id !== expectedThreadId)) {
    throw new Error("Desktop Attach 任务详情 ID 不匹配");
  }
  if (rawThread.kind !== "codex") throw new Error("Desktop Attach 目标不是 Codex 任务");
  if (!cwd || !isAbsolute(cwd)) throw new Error("Desktop Attach 任务详情缺少绝对 cwd");
  const turns = Array.isArray(payload?.turns)
    ? payload.turns
    : Array.isArray(rawThread.turns)
      ? rawThread.turns
      : [];
  const title = typeof rawThread.title === "string" ? rawThread.title.trim() : "";
  const preview = typeof rawThread.preview === "string" ? rawThread.preview : "";
  return {
    ...payload,
    source: "desktop",
    thread: {
      ...rawThread,
      id,
      cwd,
      name: title || preview.split(/\r?\n/, 1)[0]?.slice(0, 80) || "未命名任务",
      turns,
      source: "desktop",
      capabilities: { send: true, interrupt: false, approval: false, question: false },
    },
  };
}

export function defaultDesktopAttachRegistration(env = process.env) {
  const localAppData = env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return resolve(localAppData, "AgentPocket", "desktop-attach.json");
}

export function parseDesktopAttachRegistration(value: unknown): DesktopAttachRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Desktop Attach 注册信息无效");
  }
  const item = value as Record<string, unknown>;
  if (item.protocolVersion !== IPC_PROTOCOL_VERSION) throw new Error("Desktop Attach 协议版本不兼容");
  if (typeof item.instanceId !== "string" || !item.instanceId.trim()) throw new Error("Desktop Attach instanceId 无效");
  if (typeof item.pipeName !== "string" || !item.pipeName.startsWith("\\\\.\\pipe\\agent-pocket-desktop-attach-")) {
    throw new Error("Desktop Attach pipeName 无效");
  }
  if (typeof item.token !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(item.token)) {
    throw new Error("Desktop Attach token 无效");
  }
  if (!Number.isSafeInteger(item.pid) || Number(item.pid) <= 0) throw new Error("Desktop Attach pid 无效");
  if (typeof item.startedAt !== "string" || Number.isNaN(Date.parse(item.startedAt))) throw new Error("Desktop Attach startedAt 无效");
  if (!Array.isArray(item.capabilities) || item.capabilities.some((entry) => typeof entry !== "string")) {
    throw new Error("Desktop Attach capabilities 无效");
  }
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    instanceId: item.instanceId,
    pipeName: item.pipeName,
    token: item.token,
    pid: Number(item.pid),
    startedAt: item.startedAt,
    readOnly: item.readOnly === true,
    capabilities: item.capabilities as string[],
  };
}

export class DesktopAttachClient {
  registrationPath: string;
  timeoutMs: number;

  constructor(options: { registrationPath?: string; timeoutMs?: number } = {}) {
    this.registrationPath = options.registrationPath || defaultDesktopAttachRegistration();
    this.timeoutMs = options.timeoutMs || 15_000;
  }

  registration() {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.registrationPath, "utf8"));
    } catch {
      throw new Error("Desktop Attach 插件未运行；请先在 Codex Desktop 新任务中调用 desktop_attach_probe");
    }
    return parseDesktopAttachRegistration(value);
  }

  probe() {
    return this.request("attach/probe", {});
  }

  listThreads(limit = 10) {
    return this.request("thread/list", { limit });
  }

  async listThreadsNormalized(limit = 50, search?: string) {
    return normalizeDesktopThreadList(await this.listThreads(limit), search);
  }

  listProjects() {
    return this.request("project/list", {});
  }

  async listProjectsNormalized() {
    return normalizeDesktopProjectList(await this.listProjects());
  }

  readThread(threadId: string, turnLimit = 10, cursor?: string) {
    const params: Record<string, unknown> = { threadId, turnLimit };
    if (cursor) params.cursor = cursor;
    return this.request("thread/read", params);
  }

  async readThreadNormalized(threadId: string, turnLimit = 10, cursor?: string) {
    return normalizeDesktopThreadRead(await this.readThread(threadId, turnLimit, cursor), threadId);
  }

  createThread(cwd: string, text: string, model?: string, effort?: string, workspaceMode = "local"): Promise<DesktopCreateResult> {
    const params: Record<string, unknown> = { cwd, text, workspaceMode };
    if (model) params.model = model;
    if (effort) params.effort = effort;
    return this.request("thread/create", params, { write: true });
  }

  sendMessage(threadId: string, text: string) {
    return this.request("thread/send", { threadId, text }, { write: true });
  }

  waitThread(threadId: string, afterCursor?: string, timeoutMs = 8_000): Promise<DesktopWaitSummary> {
    const params: Record<string, unknown> = { threadId, timeoutMs };
    if (afterCursor) params.afterCursor = afterCursor;
    return this.request("thread/wait", params, {
      timeoutMs: Math.min(this.timeoutMs, timeoutMs + 3_000),
    });
  }

  async request(method: string, params: Record<string, unknown>, options: { write?: boolean; timeoutMs?: number } = {}) {
    const registration = this.registration();
    if (!registration.capabilities.includes(method)) {
      return Promise.reject(new Error(`Desktop Attach 当前不支持：${method}`));
    }
    if (options.write && registration.readOnly) {
      return Promise.reject(new Error("Desktop Attach 当前处于只读模式"));
    }

    return new Promise<any>((resolvePromise, rejectPromise) => {
      const socket = net.createConnection(registration.pipeName);
      let buffer = "";
      let authenticated = false;
      let settled = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) rejectPromise(error instanceof Error ? error : new Error(String(error)));
        else resolvePromise(value);
      };
      const send = (id: number, requestMethod: string, requestParams: Record<string, unknown>) => {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: requestMethod, params: requestParams })}\n`);
      };
      const timer = setTimeout(() => finish(new Error(`Desktop Attach 请求超时：${method}`)), options.timeoutMs ?? this.timeoutMs);

      socket.setEncoding("utf8");
      socket.once("connect", () => send(1, "attach/hello", { token: registration.token }));
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > MAX_IPC_MESSAGE_BYTES) {
          finish(new Error("Desktop Attach 响应超过 2MB 限制"));
          return;
        }
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message: any;
          try { message = JSON.parse(line); } catch {
            finish(new Error("Desktop Attach 返回无效 JSON"));
            return;
          }
          if (message.id === 1) {
            if (message.error) {
              finish(new Error(`Desktop Attach 鉴权失败：${message.error.message || "AUTH_FAILED"}`));
              return;
            }
            if (message.result?.protocolVersion !== IPC_PROTOCOL_VERSION) {
              finish(new Error("Desktop Attach 握手版本不兼容"));
              return;
            }
            const handshakeCapabilities = Array.isArray(message.result?.capabilities) ? message.result.capabilities : [];
            if (!handshakeCapabilities.includes(method)) {
              finish(new Error(`Desktop Attach 握手未声明能力：${method}`));
              return;
            }
            if (options.write && message.result?.readOnly !== false) {
              finish(new Error("Desktop Attach 握手处于只读模式"));
              return;
            }
            authenticated = true;
            send(2, method, params);
          } else if (message.id === 2 && authenticated) {
            if (message.error) finish(new Error(message.error.message || `Desktop Attach 调用失败：${method}`));
            else finish(undefined, message.result);
            return;
          }
        }
      });
      socket.once("error", (error) => finish(new Error(`无法连接 Desktop Attach 插件：${error.message}`)));
      socket.once("close", () => {
        if (!settled) finish(new Error("Desktop Attach 插件连接已关闭"));
      });
    });
  }
}
