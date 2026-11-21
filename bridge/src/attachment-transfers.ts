import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { mkdir, lstat, realpath, readdir, readFile, writeFile, rename, open, unlink, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { RpcError } from "./protocol.ts";

export const UPLOAD_CHUNK = 192 * 1024;
export const UPLOAD_FILE_MAX = 20 * 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[a-f0-9-]{36}$/;
const EXTENSIONS = new Set("txt md markdown json jsonl csv tsv xml yaml yml log kt kts java js jsx ts tsx py rs go c cc cpp h hpp cs swift rb php sh ps1 bat cmd toml ini conf cfg gradle sql html css scss vue svelte properties pdf".split(" "));
type Target = { threadId?: string; cwd: string };
type Manifest = Target & { version: 2; id: string; tokenHash: string; deviceId: string; operationId: string;
  slot: string; filename: string; mimeType: string; size: number; sha256: string; extension: string;
  createdAt: number; touchedAt: number; ready: boolean; committed: boolean; retainedAt: number };
export type UploadReference = { id: string; token: string };
type Options = { now?: () => number; deviceQuota?: number; globalQuota?: number;
  /** Unknown means retain: cleanup must never guess that a task has ended. */
  taskState?: (threadId: string) => Promise<"active" | "ended" | "unknown">;
  operationState?: (operationId: string) => "pending" | "unknown" | "succeeded" | "failed" | undefined };

function invalid(message: string): never { throw new RpcError("INVALID_REQUEST", message); }
function text(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid("附件参数无效");
  return value;
}
function samePath(a: string, b: string) { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function hash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }

/** Disk-backed, serialized transfers. Metadata never contains the bearer token.
 * Each upload is bound to a device, operation and validated project/task. */
export class AttachmentTransfers {
  readonly root: string;
  readonly options: Options;
  private tail: Promise<unknown> = Promise.resolve();
  private now: () => number;
  private orphanBytes = 0;
  private directoryCount = 0;
  constructor(root: string, options: Options = {}) {
    this.root = resolve(root); this.options = options; this.now = options.now ?? Date.now;
    if (dirname(this.root) === this.root) invalid("附件目录不能是磁盘根目录");
  }
  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn).catch(error => {
      if (error instanceof RpcError) throw error;
      throw new RpcError("ATTACHMENT_STORAGE", "附件写入或读取失败，请检查电脑磁盘空间和目录权限");
    });
    this.tail = task.catch(() => undefined); return task;
  }
  private async directory(path: string, create = false) {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), resolve(path))) {
      throw new RpcError("PATH_DENIED", "附件目录不能经过链接或重解析点");
    }
  }
  private async initialize() {
    await this.directory(this.root, true);
    const marker = join(this.root, ".agent-pocket-uploads-v2");
    try {
      const info = await lstat(marker);
      if (!info.isFile() || info.isSymbolicLink() || await readFile(marker, "utf8") !== "agent-pocket-uploads-v2\n") throw new Error("marker");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw new RpcError("PATH_DENIED", "附件目录标记无效");
      if ((await readdir(this.root)).length) throw new RpcError("PATH_DENIED", "新附件目录必须为空");
      await writeFile(marker, "agent-pocket-uploads-v2\n", { flag: "wx", mode: 0o600 });
    }
  }
  private path(m: Manifest) { return join(this.root, m.id, `content.${m.extension}`); }
  private async regular(path: string) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new RpcError("PATH_DENIED", "附件文件身份无效");
    return info;
  }
  private async read(id: string): Promise<Manifest> {
    if (!UUID.test(id)) invalid("附件编号无效");
    await this.directory(join(this.root, id));
    const path = join(this.root, id, "manifest.json");
    if ((await this.regular(path)).size > 8192) invalid("附件记录无效");
    const m = JSON.parse(await readFile(path, "utf8")) as Manifest;
    if (m.version !== 2 || m.id !== id || !SAFE_ID.test(m.deviceId) || !SAFE_ID.test(m.operationId) ||
        !/^[a-z0-9]{1,16}$/.test(m.extension) || !Number.isSafeInteger(m.size) || m.size < 1 || m.size > UPLOAD_FILE_MAX ||
        !/^[a-f0-9]{64}$/.test(m.sha256) || !/^[a-f0-9]{64}$/.test(m.tokenHash) ||
        !Number.isFinite(m.touchedAt) || !Number.isFinite(m.retainedAt)) invalid("附件记录损坏，请恢复电脑端备份");
    return m;
  }
  private async save(m: Manifest) {
    const dir = join(this.root, m.id), temp = join(dir, "manifest.next");
    // A crash may leave this exact, private journal file behind. Do not follow it.
    try { await this.regular(temp); await unlink(temp); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(m)); await file.sync(); } finally { await file.close(); }
    await rename(temp, join(dir, "manifest.json"));
  }
  private async authenticated(deviceId: string, ref: UploadReference) {
    let m: Manifest;
    try { m = await this.read(text(ref?.id)); }
    catch (error: any) { if (error.code === "ENOENT") throw new RpcError("NOT_FOUND", "附件暂存已过期或不存在，请重新上传"); throw error; }
    if (m.deviceId !== deviceId || m.tokenHash !== hash(text(ref?.token, 100))) throw new RpcError("AUTH_FAILED", "附件不属于当前设备");
    return m;
  }
  private async remove(m: Manifest) {
    // No recursive removal: only the exact owned files may be deleted.
    for (const name of [`content.${m.extension}`, "manifest.next", "manifest.json"]) {
      const path = join(this.root, m.id, name);
      try { await this.regular(path); await unlink(path); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
    await rmdir(join(this.root, m.id));
  }
  private async manifests() {
    const result: Manifest[] = [];
    this.orphanBytes = 0; this.directoryCount = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!UUID.test(entry.name)) continue;
      this.directoryCount++;
      try { result.push(await this.read(entry.name)); }
      catch {
        // A crash before the first manifest commit cannot have exposed this
        // upload to a writer. Remove only this exact, recognizable orphan
        // layout after one hour. Corrupt committed records remain for recovery.
        const dir = join(this.root, entry.name);
        try {
          await this.directory(dir);
          const names = await readdir(dir);
          const owned = names.every(name => /^(?:content\.[a-z0-9]{1,16}|manifest\.next|manifest\.json)$/.test(name));
          const info = await lstat(dir);
          if (owned && !names.includes("manifest.json") && this.now() - info.mtimeMs > HOUR) {
            for (const name of names) { await this.regular(join(dir, name)); }
            for (const name of names) { await unlink(join(dir, name)); }
            await rmdir(dir); this.directoryCount--; continue;
          }
          for (const name of names) { this.orphanBytes += (await this.regular(join(dir, name))).size; }
        } catch { throw new RpcError("PATH_DENIED", "附件暂存目录包含异常路径，请在电脑端恢复"); }
      }
    }
    return result;
  }
  private async cleanupUnlocked() {
    const now = this.now();
    for (const m of await this.manifests()) {
      if (!m.committed) { if (now - m.touchedAt > HOUR) await this.remove(m); continue; }
      const operation = this.options.operationState?.(m.operationId);
      if (operation === "unknown" || operation === "pending") continue;
      // A definitive failed send cannot retain a live task reference forever.
      // Unknown/pending results above still retain all claimed files.
      if (operation === "failed") { if (now - m.retainedAt > HOUR) await this.remove(m); continue; }
      if (!m.threadId) continue;
      const state = await this.options.taskState?.(m.threadId) ?? "unknown";
      if (state !== "ended") { m.retainedAt = now; await this.save(m); }
      else if (now - m.retainedAt > HOUR) await this.remove(m);
    }
  }
  cleanup() { return this.serial(async () => { await this.initialize(); await this.cleanupUnlocked(); }); }
  begin(deviceId: string, params: any, target: Target) { return this.serial(async () => {
    if (!SAFE_ID.test(deviceId) || !SAFE_ID.test(text(params.operationId)) || !SAFE_ID.test(text(params.slot))) invalid("附件操作编号无效");
    const filename = text(params.filename, 160).replace(/[\\/]/g, "_");
    const mimeType = text(params.mimeType, 128).toLowerCase();
    const size = params.size, sha256 = params.sha256;
    if (!Number.isSafeInteger(size) || size < 1 || size > UPLOAD_FILE_MAX || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) invalid("单个附件须为 1 字节到 20 MiB，并提供 SHA-256");
    const image = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[mimeType];
    const ext = filename.toLowerCase().split(".").pop()!;
    if (!image && !EXTENSIONS.has(ext) && ![".env", "dockerfile", "makefile"].includes(filename.toLowerCase()) && !mimeType.startsWith("text/") &&
        !["application/pdf", "application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript", "application/sql"].includes(mimeType)) invalid("只支持图片、文本/代码和 PDF 附件");
    await this.initialize(); await this.cleanupUnlocked();
    const all = await this.manifests();
    const operation = all.filter(m => m.deviceId === deviceId && m.operationId === params.operationId);
    const previous = operation.find(m => m.slot === params.slot);
    if (previous) {
      if (previous.filename !== filename || previous.mimeType !== mimeType || previous.size !== size || previous.sha256 !== sha256 ||
          previous.cwd !== target.cwd || previous.threadId !== target.threadId) invalid("同一附件编号不能用于不同内容或任务");
      // The token is deterministic from the persisted client nonce; lost begin
      // replies can be recovered without creating another upload.
      if (previous.tokenHash !== hash(text(params.token, 100))) throw new RpcError("AUTH_FAILED", "附件凭据不匹配");
      previous.touchedAt = this.now(); await this.save(previous);
      return this.statusOf(previous);
    }
    const token = text(params.token, 100);
    if (!/^[A-Za-z0-9_-]{43,86}$/.test(token)) invalid("附件凭据无效");
    if (operation.length >= 3 || operation.reduce((n, m) => n + m.size, size) > 60 * 1024 * 1024) invalid("每次最多 3 个附件，合计 60 MiB");
    if (this.directoryCount >= 4096 || all.filter(m => m.deviceId === deviceId).length >= 120 ||
        all.reduce((n, m) => n + m.size, size + this.orphanBytes) > (this.options.globalQuota ?? 1024 * 1024 * 1024) ||
        all.filter(m => m.deviceId === deviceId).reduce((n, m) => n + m.size, size + this.orphanBytes) > (this.options.deviceQuota ?? 120 * 1024 * 1024)) {
      throw new RpcError("ATTACHMENT_QUOTA", "电脑端附件暂存额度已满，请稍后重试");
    }
    const now = this.now(), m: Manifest = { version: 2, id: randomUUID(), deviceId, operationId: params.operationId, slot: params.slot,
      filename, mimeType, size, sha256, extension: image || (EXTENSIONS.has(ext) ? ext : mimeType === "application/pdf" ? "pdf" : "txt"),
      tokenHash: hash(token), ...target, createdAt: now, touchedAt: now, retainedAt: now, ready: false, committed: false };
    await this.directory(join(this.root, m.id), true);
    await this.save(m);
    await writeFile(this.path(m), Buffer.alloc(0), { flag: "wx", mode: 0o600 });
    return this.statusOf(m);
  }); }
  private async statusOf(m: Manifest) {
    let info;
    try { info = await this.regular(this.path(m)); }
    catch (error: any) {
      // Initial metadata is committed before creating the empty data file. A
      // crash in between is recoverable without regenerating the upload ID.
      if (error.code !== "ENOENT" || m.ready || m.committed) throw error;
      await writeFile(this.path(m), Buffer.alloc(0), { flag: "wx", mode: 0o600 }); info = await this.regular(this.path(m));
    }
    if (info.size > m.size) invalid("附件长度异常");
    return { id: m.id, offset: info.size, size: m.size, ready: m.ready, committed: m.committed, sha256: m.sha256, chunkSize: UPLOAD_CHUNK };
  }
  status(device: string, ref: UploadReference) { return this.serial(async () => {
    const m = await this.authenticated(device, ref); m.touchedAt = this.now(); await this.save(m); return this.statusOf(m);
  }); }
  write(device: string, params: UploadReference & { offset: number; data: string }) { return this.serial(async () => {
    const m = await this.authenticated(device, params);
    if (m.committed || !Number.isSafeInteger(params.offset) || params.offset < 0 || typeof params.data !== "string" || params.data.length > Math.ceil(UPLOAD_CHUNK / 3) * 4) invalid("附件分块无效");
    const bytes = Buffer.from(params.data, "base64");
    if (!bytes.length || bytes.length > UPLOAD_CHUNK || bytes.toString("base64") !== params.data || params.offset + bytes.length > m.size) invalid("附件分块内容或长度无效");
    const before = await this.regular(this.path(m)), file = await open(this.path(m), constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (stat.ino !== before.ino || stat.dev !== before.dev || stat.nlink !== 1 || !stat.isFile()) throw new RpcError("PATH_DENIED", "附件文件已变化");
      if (params.offset < stat.size) {
        if (params.offset + bytes.length > stat.size) invalid("重复分块不能覆盖未确认的边界");
        const prior = Buffer.alloc(bytes.length); const read = await file.read(prior, 0, prior.length, params.offset);
        if (read.bytesRead !== bytes.length || !prior.equals(bytes)) invalid("重复分块必须与已上传内容一致");
      } else {
        if (params.offset !== stat.size || m.ready) invalid("附件分块顺序无效");
        let written = 0;
        while (written < bytes.length) { const result = await file.write(bytes, written, bytes.length - written, params.offset + written); if (!result.bytesWritten) throw new Error("short write"); written += result.bytesWritten; }
        await file.sync();
      }
    } finally { await file.close(); }
    m.touchedAt = this.now(); await this.save(m); return this.statusOf(m);
  }); }
  private async verify(m: Manifest) {
    const before = await this.regular(this.path(m));
    if (before.size !== m.size) invalid("附件尚未完整上传");
    const digest = createHash("sha256");
    for await (const bytes of createReadStream(this.path(m), { highWaterMark: UPLOAD_CHUNK, flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) })) digest.update(bytes);
    const after = await this.regular(this.path(m));
    if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs || digest.digest("hex") !== m.sha256) invalid("附件内容已变化或 SHA-256 校验失败");
  }
  finish(device: string, ref: UploadReference) { return this.serial(async () => {
    const m = await this.authenticated(device, ref); await this.verify(m); m.ready = true; m.touchedAt = this.now(); await this.save(m); return this.statusOf(m);
  }); }
  abort(device: string, ref: UploadReference) { return this.serial(async () => {
    const m = await this.authenticated(device, ref); if (m.committed) invalid("已发送的附件不能取消"); await this.remove(m); return { ok: true };
  }); }
  claim(device: string, refs: UploadReference[], operationId: string, target: Target) { return this.serial(async () => {
    if (!Array.isArray(refs) || !refs.length || refs.length > 3 || new Set(refs.map(r => r.id)).size !== refs.length) invalid("附件引用无效");
    const files: Manifest[] = [];
    for (const ref of refs) {
      const m = await this.authenticated(device, ref);
      if (!m.ready || m.operationId !== operationId || m.cwd !== target.cwd || m.threadId !== target.threadId || m.committed) invalid("附件不属于此次发送或目标任务");
      await this.verify(m); files.push(m);
    }
    if (files.reduce((sum, m) => sum + m.size, 0) > 60 * 1024 * 1024) invalid("附件总量超限");
    for (const m of files) { m.committed = true; m.retainedAt = m.touchedAt = this.now(); await this.save(m); }
    return files.map(m => ({ id: m.id, filename: m.filename, mimeType: m.mimeType, path: this.path(m), size: m.size }));
  }); }
  bindTask(device: string, refs: UploadReference[], threadId: string) { return this.serial(async () => {
    for (const ref of refs) { const m = await this.authenticated(device, ref); if (!m.committed) invalid("附件尚未提交"); m.threadId = threadId; m.retainedAt = this.now(); await this.save(m); }
  }); }
}
