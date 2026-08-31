import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MAX_ROLLOUT_TAIL_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 20_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function readAssistantTextFromRollout({
  threadId,
  turnId,
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
  maxChars = 20_000,
} = {}) {
  if (!SAFE_ID.test(threadId || "") || !SAFE_ID.test(turnId || "")) return undefined;
  const rolloutPath = findRolloutFile(threadId, codexHome);
  if (!rolloutPath) return undefined;
  const tail = readFileTail(rolloutPath, MAX_ROLLOUT_TAIL_BYTES);
  return extractAssistantTextFromRollout(tail, turnId, maxChars);
}

export function findRolloutFile(threadId, codexHome) {
  if (!SAFE_ID.test(threadId || "")) return undefined;
  const suffix = `-${threadId}.jsonl`;
  const roots = [join(resolve(codexHome), "sessions"), join(resolve(codexHome), "archived_sessions")];
  const matches = [];
  let scanned = 0;

  for (const root of roots) {
    const pending = [{ path: root, depth: 0 }];
    while (pending.length > 0 && scanned < MAX_SCAN_ENTRIES) {
      const current = pending.pop();
      let entries;
      try {
        entries = readdirSync(current.path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        scanned += 1;
        if (scanned >= MAX_SCAN_ENTRIES) break;
        const entryPath = join(current.path, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink() && current.depth < 4) {
          pending.push({ path: entryPath, depth: current.depth + 1 });
        } else if (entry.isFile() && entry.name.endsWith(suffix)) {
          try {
            matches.push({ path: entryPath, mtimeMs: statSync(entryPath).mtimeMs });
          } catch {}
        }
      }
    }
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.path;
}

export function extractAssistantTextFromRollout(text, turnId, maxChars = 20_000) {
  if (typeof text !== "string" || !SAFE_ID.test(turnId || "")) return undefined;
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes(turnId) || !/(last_agent_message|AgentMessage|\"role\":\"assistant\")/.test(line)) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;

    if (payload.type === "task_complete" && payload.turn_id === turnId) {
      const textValue = nonEmptyString(payload.last_agent_message);
      if (textValue) return textValue.slice(0, maxChars);
    }

    if (record.type === "event_msg" && payload.turn_id === turnId && payload.type === "item_completed") {
      const item = payload.item;
      if (item?.type === "AgentMessage") {
        const textValue = textFromContent(item.content);
        if (textValue) return textValue.slice(0, maxChars);
      }
    }

    if (record.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
      const metadataTurnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
      if (metadataTurnId === turnId) {
        const textValue = textFromContent(payload.content);
        if (textValue) return textValue.slice(0, maxChars);
      }
    }
  }
  return undefined;
}

function readFileTail(path, maxBytes) {
  let handle;
  try {
    handle = openSync(path, "r");
    const size = fstatSync(handle).size;
    if (size <= maxBytes) return readFileSync(path, "utf8");
    const start = size - maxBytes;
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(handle, buffer, 0, maxBytes, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const firstNewline = text.indexOf("\n");
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  } catch {
    return "";
  } finally {
    if (handle !== undefined) {
      try { closeSync(handle); } catch {}
    }
  }
}

function textFromContent(content) {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => nonEmptyString(item?.text))
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
