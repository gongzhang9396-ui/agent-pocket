import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertAllowedCwd } from "./config.ts";
import { ErrorName, RpcError, truncateUtf8 } from "./protocol.ts";

const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const HISTORY_CURSOR = "ap-grok-native-v1:";
const MAX_LINE = 16 * 1024 * 1024;
const PAGE_BYTES = 512 * 1024;
const READ_ONLY_REASON = "电脑终端的 Grok 会话已同步，可查看历史与后续更新；请在原终端继续发送，手机暂不接管此会话。";
const readOnlyCaps = { send: false, interrupt: false, approval: false, question: false, plan: false, goal: false, handoff: false, steer: false, attachments: false };
type Entry = { id: string; nativeId: string; cwd: string; dir: string; title: string; createdAt: number; updatedAt: number; model?: string; fingerprint: string };
type Line = { start: number; end: number; bytes?: Buffer; oversized?: boolean };
type Revision = { identity: string; size: number; mtime: number; digest?: string; revision: string };
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 24);
const epoch = (value: unknown, fallback: number) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : fallback;

/** Read only the requested regular file, never a link into another directory. */
async function safeOpen(path: string) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || !samePath(await realpath(path), path)) throw new Error("Unsafe native file");
  const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const actual = await file.stat(); const after = await lstat(path);
    if (!actual.isFile() || after.isSymbolicLink() || actual.ino !== before.ino || actual.dev !== before.dev || actual.ino !== after.ino || actual.dev !== after.dev || !samePath(await realpath(path), path)) throw new Error("Native file changed");
    return file;
  } catch (error) { await file.close(); throw error; }
}

async function readBytes(file: FileHandle, start: number, length: number) {
  const buffer = Buffer.alloc(length); let total = 0;
  while (total < length) {
    const { bytesRead } = await file.read(buffer, total, length - total, start + total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}
async function anchor(file: FileHandle, end: number) { return hash(await readBytes(file, Math.max(0, end - 256), Math.min(256, end))); }

async function snapshotHash(file: FileHandle, length: number, prefixAt?: number): Promise<{ digest?: string; prefix?: string }> {
  // Huge histories remain readable, but a changed file invalidates their old
  // cursors instead of claiming append-only continuity without verifying it.
  if (length > 128 * 1024 * 1024) return {};
  const hasher = createHash("sha256"); let position = 0, prefix = prefixAt === 0 ? hasher.copy().digest("hex") : undefined;
  while (position < length) {
    const take = Math.min(256 * 1024, length - position, prefixAt !== undefined && position < prefixAt ? prefixAt - position : Infinity);
    const bytes = await readBytes(file, position, take);
    if (bytes.length !== take) throw new RpcError("HISTORY_CHANGED", "电脑正在改写历史，请稍后刷新");
    hasher.update(bytes); position += take;
    if (position === prefixAt) prefix = hasher.copy().digest("hex");
  }
  return { digest: hasher.digest("hex"), prefix };
}

/** Reverse JSONL scan. Bytes and work are bounded even for one enormous line. */
async function* linesBackwards(file: FileHandle, end: number): AsyncGenerator<Line> {
  let position = end, lineEnd = end, pieces: Buffer[] = [], length = 0, scanned = 0;
  while (position > 0 && scanned < 64 * 1024 * 1024) {
    const start = Math.max(0, position - 64 * 1024);
    const buffer = await readBytes(file, start, position - start);
    if (buffer.length !== position - start) throw new RpcError("HISTORY_CHANGED", "电脑会话历史已变化，请刷新后重新加载");
    scanned += buffer.length; let right = buffer.length;
    for (let index = buffer.length - 1; index >= 0; index--) {
      if (buffer[index] !== 10) continue;
      const part = buffer.subarray(index + 1, right); length += part.length;
      if (length <= MAX_LINE) pieces.push(part);
      const lineStart = start + index + 1;
      if (lineStart < lineEnd) yield { start: lineStart, end: lineEnd, ...(length > MAX_LINE ? { oversized: true } : { bytes: Buffer.concat(pieces.reverse()) }) };
      lineEnd = start + index; pieces = []; length = 0; right = index;
    }
    const part = buffer.subarray(0, right); length += part.length;
    if (length <= MAX_LINE) pieces.push(part);
    position = start;
  }
  if (position === 0 && lineEnd > 0) yield { start: 0, end: lineEnd, ...(length > MAX_LINE ? { oversized: true } : { bytes: Buffer.concat(pieces.reverse()) }) };
  else if (position > 0) throw new RpcError("RESPONSE_TOO_LARGE", "原生历史中有超过 64 MiB 的记录，请在电脑查看这一段");
}

function contentText(value: unknown, unwrapQuery = false): string {
  if (typeof value === "string") return unwrapQuery ? value.replace(/^<user_query>\r?\n([\s\S]*)\r?\n<\/user_query>$/, "$1") : value;
  if (!Array.isArray(value)) return "";
  return value.map(item => item?.type === "text" && typeof item.text === "string" ? contentText(item.text, unwrapQuery)
    : item?.type === "image" ? "\n[图片附件，请在电脑查看]\n" : "\n[此附件请在电脑查看]\n").join("");
}
function messageParts(row: any, prefix: string) {
  const parts: any[] = [];
  const add = (text: string, user = false) => {
    for (let i = 0; i < text.length;) {
      let end = Math.min(text.length, i + 8_000);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      const value = text.slice(i, end); i = end;
      const id = `${prefix}-${parts.length}`;
      parts.push(user ? { id, type: "userMessage", content: [{ type: "text", text: value }] } : { id, type: "agentMessage", text: value });
    }
  };
  if (!row || typeof row !== "object" || Array.isArray(row)) { add("[这条原生记录格式无法识别，请在电脑查看]"); return parts; }
  if (row.synthetic_reason) return parts;
  if (row.type === "user") {
    const indexed = Number.isSafeInteger(row.prompt_index);
    const text = contentText(row.content, indexed);
    // Grok 1.0.13 stores bootstrap environment/rules as an unindexed user row.
    // Actual user input has prompt_index; preserve literal markup inside it.
    if (!indexed && /^<user_info>\r?\nOS Version:/.test(text) && text.includes("</user_info>")) return parts;
    add(text, true);
  }
  if (row.type === "assistant") {
    add(contentText(row.content));
    for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
      add(`工具调用 · ${typeof call.name === "string" ? call.name : "Grok 工具"}\n\n${typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {})}`);
    }
  }
  if (row.type === "tool_result") add(`工具结果\n\n${contentText(row.content)}`);
  if (row.type === "backend_tool_call") add(`Grok 内置工具\n\n${JSON.stringify(row.kind ?? {})}`);
  // System prompts and private/encrypted reasoning are not conversation messages.
  return parts;
}

/** A read-only projection of Grok's native files. Never loads or owns a session. */
export class GrokNativeCatalog extends EventEmitter {
  roots: string[];
  directory: string;
  private entries = new Map<string, Entry>();
  private revisions = new Map<string, Revision>();
  private flight?: Promise<void>;
  private reads = new Map<string, Promise<any>>();
  private refreshedAt = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  warning?: string;
  constructor(roots: string[], directory = join(homedir(), ".grok", "sessions")) { super(); this.roots = roots; this.directory = resolve(directory); }
  startWatching() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.refresh(true).catch(() => {}); }, 5_000);
    this.timer.unref();
  }
  async stop() { this.stopped = true; clearInterval(this.timer); this.timer = undefined; await this.flight; await Promise.allSettled([...this.reads.values()]); }
  async refresh(force = false) {
    if (this.flight) return this.flight;
    if (!force && Date.now() - this.refreshedAt < 2_000) return;
    this.flight = this.scan();
    try { await this.flight; } finally { this.flight = undefined; }
  }
  private async scan() {
    const next = new Map<string, Entry>(), ambiguous = new Set<string>();
    this.warning = undefined;
    let root: string;
    try { root = await realpath(this.directory); }
    catch (error: any) { if (error.code !== "ENOENT") this.warning = "无法读取电脑上的 Grok 会话目录"; this.commit(next); return; }
    const groups = await readdir(root, { withFileTypes: true }).catch(() => { this.warning = "无法读取电脑上的 Grok 会话目录"; return []; });
    let visited = 0;
    scan: for (const group of groups) {
      if (!group.isDirectory() || group.isSymbolicLink()) continue;
      let cwd: string;
      try { cwd = assertAllowedCwd(decodeURIComponent(group.name), this.roots); } catch { continue; }
      const groupPath = join(root, group.name);
      if (!samePath(await realpath(groupPath).catch(() => ""), groupPath)) continue;
      for (const session of await readdir(groupPath, { withFileTypes: true }).catch(() => [])) {
        if (!session.isDirectory() || session.isSymbolicLink() || !SAFE_ID.test(session.name)) continue;
        if (++visited > 5_000) { this.warning = "Grok 原生目录超过 5,000 个会话，本次只同步已扫描部分"; break scan; }
        const dir = join(groupPath, session.name); let file: FileHandle | undefined;
        try {
          if (!samePath(await realpath(dir), dir)) continue;
          file = await safeOpen(join(dir, "summary.json")); const stat = await file.stat();
          if (stat.size > 1024 * 1024) continue;
          const summary = JSON.parse((await readBytes(file, 0, stat.size)).toString("utf8"));
          if (summary.info?.id !== session.name || !samePath(assertAllowedCwd(summary.info.cwd, this.roots), cwd)) continue;
          const history = await lstat(join(dir, "chat_history.jsonl")).catch(error => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          if (history && (!history.isFile() || history.isSymbolicLink())) continue;
          const id = `grok:${session.name}`;
          if (next.has(id)) { ambiguous.add(id); continue; }
          next.set(id, { id, nativeId: session.name, cwd, dir,
            title: truncateUtf8(typeof summary.generated_title === "string" && summary.generated_title.trim() ? summary.generated_title : "Grok 电脑会话", 500).value,
            model: typeof summary.current_model_id === "string" ? summary.current_model_id.slice(0, 200) : undefined,
            createdAt: epoch(summary.created_at, stat.birthtimeMs), updatedAt: Math.max(epoch(summary.updated_at, stat.mtimeMs), history?.mtimeMs ?? 0),
            fingerprint: `${stat.size}:${stat.mtimeMs}:${history ? `${history.dev}:${history.ino}:${history.size}:${history.mtimeMs}` : "pending-history"}` });
        } catch { /* A half-written/deleted/inaccessible session cannot authorize a path. */ }
        finally { await file?.close(); }
      }
    }
    for (const id of ambiguous) next.delete(id);
    this.commit(next);
  }
  private commit(next: Map<string, Entry>) {
    const changed = new Set([...next.keys(), ...this.entries.keys()].filter(id => next.get(id)?.fingerprint !== this.entries.get(id)?.fingerprint));
    const initialized = this.refreshedAt !== 0;
    this.entries = next; this.refreshedAt = Date.now();
    for (const id of this.revisions.keys()) if (!next.has(id)) this.revisions.delete(id);
    if (initialized && changed.size && !this.stopped) this.emit("changed", [...changed]);
  }
  describe(entry: Entry) {
    return { id: entry.id, agentId: "grok", name: entry.title, preview: entry.title, cwd: entry.cwd,
      model: entry.model, createdAt: Math.floor(entry.createdAt / 1000), updatedAt: Math.floor(entry.updatedAt / 1000),
      status: { type: "notLoaded", activeFlags: [] }, source: "grok",
      execution: { backend: "grok", owner: "external", capabilities: readOnlyCaps, readOnlyReason: READ_ONLY_REASON }, capabilities: readOnlyCaps };
  }
  async list(search?: string) {
    await this.refresh(); this.startWatching();
    return [...this.entries.values()].filter(entry => {
      try { assertAllowedCwd(entry.cwd, this.roots); return !search || `${entry.title}\n${entry.cwd}`.toLowerCase().includes(search.toLowerCase()); } catch { return false; }
    }).map(entry => this.describe(entry));
  }
  async metadata(id: string) {
    await this.refresh(true);
    const entry = this.entries.get(id);
    if (!entry) throw new RpcError(ErrorName.NOT_FOUND, "电脑会话已移除、目录不可访问或不在项目白名单内");
    assertAllowedCwd(entry.cwd, this.roots);
    return { id: entry.id, nativeId: entry.nativeId, cwd: entry.cwd, model: entry.model, title: entry.title, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
  }
  async read(id: string, cursor?: string, options: { maxBytes?: number; maxItems?: number } = {}) {
    const previous = this.reads.get(id) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.readPage(id, cursor, options));
    this.reads.set(id, work);
    try { return await work; } finally { if (this.reads.get(id) === work) this.reads.delete(id); }
  }
  private async readPage(id: string, cursor?: string, options: { maxBytes?: number; maxItems?: number }) {
    if (!id.startsWith("grok:") || !SAFE_ID.test(id.slice(5))) throw new RpcError(ErrorName.NOT_FOUND, "找不到这个 Grok 会话");
    await this.refresh(); this.startWatching();
    const entry = this.entries.get(id);
    if (!entry) throw new RpcError(ErrorName.NOT_FOUND, "电脑会话已移除、目录不可访问或不在项目白名单内");
    assertAllowedCwd(entry.cwd, this.roots);
    let file: FileHandle;
    try { file = await safeOpen(join(entry.dir, "chat_history.jsonl")); }
    catch { throw new RpcError("HISTORY_UNAVAILABLE", "电脑上的 Grok 历史暂未就绪，请稍后刷新；消息尚未发送"); }
    try {
      const stat = await file.stat(); const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      const previous = this.revisions.get(id);
      const unchanged = previous && previous.identity === identity && stat.size === previous.size && stat.mtimeMs === previous.mtime;
      const hashes = unchanged ? { digest: previous.digest, prefix: previous.digest } : await snapshotHash(file, stat.size, previous?.size);
      const appended = previous && previous.identity === identity && stat.size >= previous.size && previous.digest && hashes.prefix === previous.digest;
      const revision = unchanged || appended ? previous!.revision : randomUUID();
      this.revisions.set(id, { identity, size: stat.size, mtime: stat.mtimeMs, digest: hashes.digest, revision });
      let end = stat.size, partBefore: number | undefined;
      const startCursor = end > 0 ? HISTORY_CURSOR + Buffer.from(JSON.stringify({ id, end, revision, anchor: await anchor(file, end) })).toString("base64url") : null;
      if (cursor) {
        let parsed: any;
        try {
          if (!cursor.startsWith(HISTORY_CURSOR)) throw new Error();
          parsed = JSON.parse(Buffer.from(cursor.slice(HISTORY_CURSOR.length), "base64url").toString("utf8"));
          if (parsed.id !== id || !Number.isSafeInteger(parsed.end) || parsed.end <= 0 || parsed.end > stat.size ||
            (parsed.partBefore !== undefined && (!Number.isSafeInteger(parsed.partBefore) || parsed.partBefore < 1))) throw new Error();
        } catch { throw new RpcError(ErrorName.INVALID_REQUEST, "原生 Grok 历史游标无效或属于其他会话"); }
        if (parsed.revision !== revision || parsed.anchor !== await anchor(file, parsed.end)) throw new RpcError("HISTORY_CHANGED", "电脑会话已回退或改写，请刷新后重新加载历史");
        end = parsed.end; partBefore = parsed.partBefore;
      }
      const items: any[] = []; let bytes = 0, before = 0, remainingPart: number | undefined, scanned = 0, pending = false;
      for await (const line of linesBackwards(file, end)) {
        let row: any;
        if (line.oversized) row = { type: "assistant", content: "[这条原生记录超过 16 MiB，请在电脑查看完整内容]" };
        else {
          try { row = JSON.parse(line.bytes!.toString("utf8")); }
          catch {
            if (line.end === stat.size) { pending = true; before = line.start; continue; }
            row = { type: "assistant", content: "[这条原生记录暂时无法解析，请在电脑查看]" };
          }
        }
        const prefix = `grok-native-${line.start}-${line.bytes ? hash(line.bytes) : "large"}`;
        const parts = messageParts(row, prefix);
        const count = partBefore ?? parts.length; partBefore = undefined;
        if (count > parts.length) throw new RpcError("HISTORY_CHANGED", "电脑历史已变化，请刷新后重试");
        let index = count - 1;
        for (; index >= 0; index--) {
          const size = Buffer.byteLength(JSON.stringify(parts[index])) + 100;
          if (items.length >= (options.maxItems ?? 100) || bytes + size > (options.maxBytes ?? PAGE_BYTES)) break;
          items.push(parts[index]); bytes += size;
        }
        if (index >= 0) { before = line.end; remainingPart = index + 1; break; }
        before = line.start;
        if (++scanned >= 256 || items.length >= (options.maxItems ?? 100)) break;
      }
      const nextCursor = before > 0 || remainingPart !== undefined ? HISTORY_CURSOR + Buffer.from(JSON.stringify({ id, end: before, partBefore: remainingPart, revision, anchor: await anchor(file, before) })).toString("base64url") : null;
      return { thread: { ...this.describe(entry), turns: items.length ? [{ id: `grok-native-history-${revision}`, status: "completed", items: items.reverse() }] : [] },
        page: { order: "oldest_first", hasMore: nextCursor !== null, nextCursor, startCursor, revision, pending } };
    } finally { await file.close(); }
  }
}
