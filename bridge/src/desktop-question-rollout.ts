import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_TAIL = 32 * 1024 * 1024;
const MAX_HEADER = 256 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 4;
const MAX_CACHE = 32;
const PATH_TTL = 60_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Question = { title: string; options?: string[] };
type Row = { turnId: string; questions: Question[] };
type CachedPath = { path?: string; root?: string; until: number };
const paths = new Map<string, CachedPath>();
const contents = new Map<string, { size: number; mtimeMs: number; ino: number; dev: number; rows: Map<string, Row> }>();

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE) map.delete(map.keys().next().value!);
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Recheck every component, including cached paths, so a replaced directory or
// symlink cannot redirect a later read outside the trusted session root.
function safePath(root: string, path: string) {
  try {
    if (!inside(root, path) || realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) return false;
    let current = path;
    while (current !== root) {
      if (lstatSync(current).isSymbolicLink()) return false;
      current = dirname(current);
    }
    return realpathSync(path) === path;
  } catch { return false; }
}

function findFile(home: string, id: string): CachedPath {
  const key = `${resolve(home)}\0${id}`;
  const cached = paths.get(key);
  if (cached && cached.until > Date.now() && (!cached.path || (cached.root && safePath(cached.root, cached.path)))) return cached;
  let entries = 0;
  for (const name of ["sessions", "archived_sessions"]) {
    const root = join(resolve(home), name);
    try {
      if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) continue;
    } catch { continue; }
    const pending = [{ path: root, depth: 0 }];
    while (pending.length && entries < MAX_ENTRIES) {
      const dir = pending.pop()!;
      let children;
      try { children = readdirSync(dir.path, { withFileTypes: true }); } catch { continue; }
      for (const child of children) {
        if (++entries > MAX_ENTRIES) break;
        const path = join(dir.path, child.name);
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory() && dir.depth < MAX_DEPTH) pending.push({ path, depth: dir.depth + 1 });
        else if (child.isFile() && child.name.endsWith(`-${id}.jsonl`) && safePath(root, path)) {
          const found = { path, root, until: Date.now() + PATH_TTL };
          boundedSet(paths, key, found);
          return found;
        }
      }
    }
  }
  const missing = { until: Date.now() + 5_000 };
  boundedSet(paths, key, missing);
  return missing;
}

function validQuestions(value: any): value is Question[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 3 && value.every((q) =>
    q && typeof q.title === "string" && !!q.title.trim() && q.title.length <= 12_000 &&
    (q.options === undefined || (Array.isArray(q.options) && q.options.length <= 20 &&
      q.options.every((option: unknown) => typeof option === "string" && option.length <= 4_000))));
}

function readAt(fd: number, length: number, position: number) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, buffer, read, length - read, position + read);
    if (!count) break;
    read += count;
  }
  if (read !== length) throw new Error("Incomplete rollout read");
  return buffer.toString("utf8");
}

/** Recover only accepted tool calls from the matching Desktop session. */
export function readDesktopAsyncQuestions(home: string, id: string): Map<string, Row> {
  const empty = () => new Map<string, Row>();
  if (!SAFE_ID.test(id)) return empty();
  const found = findFile(home, id);
  if (!found.path || !found.root) return empty();
  let fd: number | undefined;
  try {
    if (!safePath(found.root, found.path)) return empty();
    const before = lstatSync(found.path);
    if (!before.isFile()) return empty();
    fd = openSync(found.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ino !== before.ino || opened.dev !== before.dev) return empty();
    const cached = contents.get(found.path);
    if (cached && cached.size === opened.size && cached.mtimeMs === opened.mtimeMs && cached.ino === opened.ino && cached.dev === opened.dev) {
      const current = lstatSync(found.path);
      const after = fstatSync(fd);
      if (current.size === opened.size && current.mtimeMs === opened.mtimeMs && current.ino === opened.ino &&
        current.dev === opened.dev && after.size === opened.size && after.mtimeMs === opened.mtimeMs && safePath(found.root, found.path)) return cached.rows;
      return empty();
    }
    const header = readAt(fd, Math.min(opened.size, MAX_HEADER), 0);
    const firstEnd = header.indexOf("\n");
    if (firstEnd < 0) return empty();
    const meta = JSON.parse(header.slice(0, firstEnd));
    if (meta?.type !== "session_meta" || meta.payload?.id !== id ||
      (meta.payload.session_id !== undefined && meta.payload.session_id !== id)) return empty();
    const start = Math.max(0, opened.size - MAX_TAIL);
    let tail = start ? readAt(fd, opened.size - start, start) : readAt(fd, opened.size, 0);
    if (start) tail = tail.slice(tail.indexOf("\n") + 1);
    // A trailing incomplete JSON line may become valid on the next poll.
    tail = tail.slice(0, tail.lastIndexOf("\n") + 1);
    const calls = new Map<string, Row>();
    const accepted = new Set<string>();
    const conflicts = new Set<string>();
    for (const line of tail.split("\n")) {
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      const p = record?.payload;
      const turnId = p?.internal_chat_message_metadata_passthrough?.turn_id;
      if (record?.type !== "response_item" || !SAFE_ID.test(p?.call_id || "") || !SAFE_ID.test(turnId || "")) continue;
      const key = JSON.stringify([turnId, p.call_id]);
      if (p.type === "function_call" && p.name === "request_user_input_async") {
        try {
          const args = JSON.parse(p.arguments);
          if (validQuestions(args.questions)) {
            if (calls.has(key)) conflicts.add(key);
            else calls.set(key, { turnId, questions: args.questions.map((q: Question) => ({ title: q.title, ...(q.options === undefined ? {} : { options: q.options }) })) });
          }
        } catch { /* malformed input is not evidence */ }
      } else if (p.type === "function_call_output" && calls.has(key)) {
        try { if (JSON.parse(p.output)?.accepted === true) accepted.add(key); } catch { /* incomplete output */ }
      }
    }
    const after = fstatSync(fd);
    const current = lstatSync(found.path);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || current.size !== opened.size ||
      current.mtimeMs !== opened.mtimeMs || current.ino !== opened.ino || current.dev !== opened.dev || !safePath(found.root, found.path)) return empty();
    const rows = empty();
    const ambiguous = new Set<string>();
    for (const [key, row] of calls) {
      if (!accepted.has(key) || conflicts.has(key)) continue;
      const [, callId] = JSON.parse(key);
      if (rows.has(callId)) { rows.delete(callId); ambiguous.add(callId); }
      else if (!ambiguous.has(callId)) rows.set(callId, row);
    }
    boundedSet(contents, found.path, { size: opened.size, mtimeMs: opened.mtimeMs, ino: opened.ino, dev: opened.dev, rows });
    return rows;
  } catch { return empty(); }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ } }
}

export function enrichDesktopQuestions(home: string, id: string, turns: any[]) {
  const rows = readDesktopAsyncQuestions(home, id);
  return turns.map((turn) => ({ ...turn, items: (turn.items || []).map((item: any) => {
    const row = rows.get(item?.id);
    return row && row.turnId === turn.id && item.type === "agentMessage"
      ? { ...item, delivery: "async", questions: row.questions } : item;
  }) }));
}
