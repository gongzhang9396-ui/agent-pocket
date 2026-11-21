import { randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { assertAllowedCwd } from "./config.ts";
import { ErrorName, RpcError } from "./protocol.ts";

export const ARTIFACT_CHUNK_BYTES = 192 * 1024;
export const ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
const TTL = 15 * 60_000;
const types: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/plain", ".csv": "text/plain", ".json": "text/plain",
  ".log": "text/plain", ".yaml": "text/plain", ".yml": "text/plain", ".xml": "text/plain", ".html": "text/plain", ".svg": "text/plain",
  ".js": "text/plain", ".ts": "text/plain", ".tsx": "text/plain", ".jsx": "text/plain", ".py": "text/plain", ".css": "text/plain",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".zip": "application/zip",
};
export type Artifact = { id: string; messageId: string; source: string; name: string; mimeType: string; size: number; unavailable?: string };
type Grant = { deviceId: string; threadId: string; cwd: string; path: string; root: string; stamp: string; expires: number; artifact: Artifact };
function stamp(s: any) { return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":"); }
function inside(root: string, path: string) { const rel = relative(root, path); return !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`); }
function same(a: string, b: string) { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function unavailable() { return new RpcError(ErrorName.PATH_DENIED, "文件不可读取、已变化或不在此任务的可分享范围内，请刷新对话"); }

// Only explicit assistant Markdown links confer a reference. User messages,
// tool output and caller-provided paths never authorize a filesystem read.
export function artifactLinks(thread: any) {
  const result: Array<{ source: string; messageId: string }> = [];
  for (const turn of thread.turns || []) for (const [index, item] of (turn.items || []).entries()) {
    if (item.type !== "agentMessage" || typeof item.text !== "string") continue;
    const expression = /!?\[[^\]\r\n]{0,300}\]\(\s*(?:<([^<>\r\n]{1,4096})>|([^\s()]{1,4096}))\s*\)/g;
    for (const match of item.text.matchAll(expression)) {
      const source = match[1] || match[2];
      if (/^(?:https?:|mailto:|data:|blob:|javascript:|file:|sandbox:|#)/i.test(source)) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) continue;
      const messageId = `${turn.id}:${item.id || index}`;
      if (!result.some(item => item.source === source && item.messageId === messageId)) result.push({ source, messageId });
      if (result.length >= 32) return result;
    }
  }
  return result;
}

export class ThreadArtifacts {
  private grants = new Map<string, Grant>();
  async checkedPath(path: string, root: string) {
    if (!inside(root, path)) throw unavailable();
    // Check every component and canonical resolution, rejecting symlinks,
    // junctions and Windows alternate data streams, even inside the project.
    const rel = relative(root, path);
    if (rel.split(/[\\/]/).some(part => part.startsWith(".") || /[:\x00-\x1f]/.test(part))) throw unavailable();
    let cursor = path;
    for (;;) {
      const s = await lstat(cursor);
      if (s.isSymbolicLink() || !same(await realpath(cursor), resolve(cursor))) throw unavailable();
      if (same(cursor, root)) break;
      const parent = dirname(cursor); if (parent === cursor) throw unavailable(); cursor = parent;
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > ARTIFACT_MAX_BYTES) throw unavailable();
    return stat;
  }
  async list(deviceId: string, thread: any, projectRoots: string[], codexHome: string) {
    if (!deviceId || !thread?.id) throw unavailable();
    const cwd = assertAllowedCwd(thread.cwd, projectRoots);
    const roots = [cwd];
    // Generated images are additionally scoped to this exact Codex chat.
    if (/^[a-zA-Z0-9-]{1,100}$/.test(thread.id)) roots.push(resolve(codexHome, "generated_images", thread.id));
    for (const [id, grant] of this.grants) if (grant.expires < Date.now()) this.grants.delete(id);
    const data: Artifact[] = [];
    for (const link of artifactLinks(thread)) {
      let decoded: string; try { decoded = decodeURIComponent(link.source); } catch { continue; }
      decoded = decoded.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, "");
      if (/^[\\/]{2}|[\x00-\x1f]/.test(decoded)) continue;
      const path = resolve(cwd, decoded); const name = basename(path); const mimeType = types[extname(path).toLowerCase()];
      if (!mimeType) continue;
      const root = roots.find(root => inside(root, path));
      const descriptor: Artifact = { ...link, id: "", name, mimeType, size: 0 };
      try {
        if (!root) throw unavailable();
        const stat = await this.checkedPath(path, root);
        const currentStamp = stamp(stat);
        const prior = [...this.grants.values()].find(grant => grant.deviceId === deviceId && grant.threadId === thread.id && grant.path === path && grant.stamp === currentStamp && grant.artifact.messageId === link.messageId && grant.artifact.source === link.source);
        descriptor.id = prior?.artifact.id || randomUUID(); descriptor.size = stat.size;
        while (this.grants.size >= 512 && !this.grants.has(descriptor.id)) this.grants.delete(this.grants.keys().next().value!);
        this.grants.set(descriptor.id, { deviceId, threadId: thread.id, cwd, path, root, stamp: currentStamp, artifact: descriptor, expires: Date.now() + TTL });
      } catch { descriptor.unavailable = "文件已移动、超过 32 MiB，或不在此任务的可分享范围内"; }
      data.push(descriptor);
    }
    return { data, chunkBytes: ARTIFACT_CHUNK_BYTES, maxBytes: ARTIFACT_MAX_BYTES };
  }
  async read(deviceId: string, threadId: string, id: string, offset: number, projectRoots: string[]) {
    const grant = this.grants.get(id);
    if (!grant || grant.deviceId !== deviceId || grant.threadId !== threadId || grant.expires < Date.now()) throw unavailable();
    assertAllowedCwd(grant.cwd, projectRoots);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > grant.artifact.size) throw new RpcError(ErrorName.INVALID_REQUEST, "文件偏移无效");
    let file;
    try {
      const before = await this.checkedPath(grant.path, grant.root);
      if (stamp(before) !== grant.stamp) throw unavailable();
      file = await open(grant.path, "r");
      if (stamp(await file.stat()) !== grant.stamp) throw unavailable();
      const buffer = Buffer.alloc(Math.min(ARTIFACT_CHUNK_BYTES, grant.artifact.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (bytesRead !== buffer.length || stamp(await file.stat()) !== grant.stamp || stamp(await this.checkedPath(grant.path, grant.root)) !== grant.stamp) throw unavailable();
      return { id, offset, size: grant.artifact.size, data: buffer.toString("base64"), nextOffset: offset + bytesRead, done: offset + bytesRead === grant.artifact.size };
    } catch { throw unavailable(); }
    finally { await file?.close(); }
  }
}
