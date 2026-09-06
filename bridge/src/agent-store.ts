import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { RpcError } from "./protocol.ts";

export type AgentTask = { id: string; nativeId: string; cwd: string; model?: string; effort?: string; title: string; createdAt: number; updatedAt: number; historySource: "managed" | "native" };
const taskRows = `SELECT t.*, CASE WHEN n.thread_id IS NULL THEN 'managed' ELSE 'native' END AS history_source
  FROM agent_tasks t LEFT JOIN agent_native_tasks n ON n.thread_id=t.id`;

/** Durable mobile transcript, independent of the expiring event replay window. */
export class AgentTaskStore {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY, native_id TEXT NOT NULL UNIQUE, creation_key TEXT UNIQUE,
        cwd TEXT NOT NULL, model TEXT, effort TEXT, title TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_turns (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES agent_tasks(id),
        client_message_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(thread_id, client_message_id)
      );
      CREATE TABLE IF NOT EXISTS agent_items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES agent_tasks(id), turn_id TEXT NOT NULL REFERENCES agent_turns(id),
        item_json TEXT NOT NULL, UNIQUE(thread_id,id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_items_thread ON agent_items(thread_id, seq);
      CREATE INDEX IF NOT EXISTS idx_agent_turns_thread ON agent_turns(thread_id, created_at);
      CREATE TABLE IF NOT EXISTS agent_native_tasks (
        thread_id TEXT PRIMARY KEY REFERENCES agent_tasks(id)
      );
    `);
    // Keep agent_tasks unchanged so the previous Host can still write after a rollback.
  }
  task(row: any): AgentTask | undefined {
    return row ? { id: row.id, nativeId: row.native_id, cwd: row.cwd, model: row.model ?? undefined, effort: row.effort ?? undefined,
      title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, historySource: row.history_source === "native" ? "native" : "managed" } : undefined;
  }
  get(id: string) { return this.task(this.db.prepare(taskRows + " WHERE t.id=?").get(id)); }
  created(key?: string) { return key ? this.task(this.db.prepare(taskRows + " WHERE t.creation_key=?").get(key)) : undefined; }
  list() { return this.db.prepare(taskRows + " ORDER BY t.updated_at DESC LIMIT 200").all().map(row => this.task(row)!); }
  create(nativeId: string, input: { cwd: string; model?: string; effort?: string; text: string; historySource?: "managed" | "native" }, key?: string) {
    const id = `grok:${nativeId}`;
    const now = Date.now();
    this.db.prepare("INSERT INTO agent_tasks(id,native_id,creation_key,cwd,model,effort,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, nativeId, key ?? null, input.cwd, input.model ?? null, input.effort ?? null, input.text.trim().slice(0, 80), now, now);
    if (input.historySource === "native") this.db.prepare("INSERT INTO agent_native_tasks VALUES(?)").run(id);
    return this.get(id)!;
  }
  adopt(task: Omit<AgentTask, "historySource">) {
    const existing = this.db.prepare("SELECT id,native_id FROM agent_tasks WHERE id=? OR native_id=?").all(task.id, task.nativeId);
    if (existing.some(row => row.id !== task.id || row.native_id !== task.nativeId)) {
      throw new RpcError("SESSION_CONFLICT", "Grok 会话标识与旧记录冲突，请在电脑检查，消息尚未发送");
    }
    this.db.exec("SAVEPOINT adopt_native_task");
    try {
      this.db.prepare(`INSERT INTO agent_tasks(id,native_id,cwd,model,title,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd, model=excluded.model,
        title=excluded.title, updated_at=MAX(agent_tasks.updated_at,excluded.updated_at)`)
        .run(task.id, task.nativeId, task.cwd, task.model ?? null, task.title, task.createdAt, task.updatedAt);
      this.db.prepare("INSERT OR IGNORE INTO agent_native_tasks VALUES(?)").run(task.id);
      this.db.exec("RELEASE adopt_native_task");
    } catch (error) { this.db.exec("ROLLBACK TO adopt_native_task; RELEASE adopt_native_task"); throw error; }
    return this.get(task.id)!;
  }
  beginTurn(threadId: string, clientId?: string) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO agent_turns VALUES(?,?,?,?,?)").run(id, threadId, clientId ?? null, "inProgress", Date.now());
    return id;
  }
  duplicate(threadId: string, clientId?: string) {
    return clientId ? this.db.prepare("SELECT id,status FROM agent_turns WHERE thread_id=? AND client_message_id=?").get(threadId, clientId) : undefined;
  }
  setStatus(turnId: string, status: string) { this.db.prepare("UPDATE agent_turns SET status=? WHERE id=?").run(status, turnId); }
  put(threadId: string, turnId: string, item: any) {
    const json = JSON.stringify(item);
    if (Buffer.byteLength(json) > 256 * 1024) throw new RpcError("RESPONSE_TOO_LARGE", "Grok 单条历史超过大小限制");
    this.db.prepare(`INSERT INTO agent_items(id,thread_id,turn_id,item_json) VALUES(?,?,?,?)
      ON CONFLICT(thread_id,id) DO UPDATE SET item_json=excluded.item_json WHERE turn_id=excluded.turn_id`)
      .run(item.id, threadId, turnId, json);
    this.db.prepare("UPDATE agent_tasks SET updated_at=? WHERE id=?").run(Date.now(), threadId);
  }
  latestTurn(threadId: string) { return this.db.prepare("SELECT id,status FROM agent_turns WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").get(threadId); }
  recover() {
    const permissions: string[] = [];
    const turns = this.db.prepare("SELECT id,thread_id FROM agent_turns WHERE status='inProgress'").all() as any[];
    for (const turn of turns) {
      for (const row of this.db.prepare("SELECT item_json FROM agent_items WHERE turn_id=?").all(turn.id) as any[]) {
        const item = JSON.parse(row.item_json);
        if (item.type === "pocketApproval" && !item.decision) {
          this.put(turn.thread_id, turn.id, { ...item, decision: "cancel" }); permissions.push(item.requestId);
        }
      }
      this.setStatus(turn.id, "interrupted");
      this.put(turn.thread_id, turn.id, { id: `grok-notice-${turn.id}`, type: "agentMessage", text: "Host 重启中断了这轮 Grok 连接，电脑上的执行可能仍在继续。请刷新确认后再发送，系统不会自动重发指令。" });
    }
    return permissions;
  }
  read(threadId: string, cursor?: string, onlyTurnId?: string, budget = 512 * 1024) {
    let before = Number.MAX_SAFE_INTEGER;
    if (cursor) {
      try {
        if (!cursor.startsWith("ap-grok-v1:")) throw new Error();
        const decoded = JSON.parse(Buffer.from(cursor.slice(11), "base64url").toString("utf8"));
        if (decoded.threadId !== threadId || decoded.turnId !== onlyTurnId || !Number.isSafeInteger(decoded.before) || decoded.before < 1) throw new Error();
        before = decoded.before;
      } catch { throw new RpcError("INVALID_REQUEST", "Grok 历史游标无效或属于其他任务"); }
    }
    const rows = this.db.prepare(`SELECT i.*,t.status FROM agent_items i JOIN agent_turns t ON t.id=i.turn_id
      WHERE i.thread_id=? AND i.seq<? AND (? IS NULL OR i.turn_id=?) ORDER BY i.seq DESC LIMIT 101`).all(threadId, before, onlyTurnId ?? null, onlyTurnId ?? null) as any[];
    const selected: any[] = []; let size = 0;
    for (const row of rows.slice(0, 100)) {
      const bytes = Buffer.byteLength(row.item_json) + 256;
      if (size + bytes > budget) break;
      selected.push(row); size += bytes;
    }
    if (rows.length && !selected.length) throw new RpcError("RESPONSE_TOO_LARGE", "Grok 单条历史超过当前页大小限制");
    const turns = new Map<string, any>();
    for (const row of selected.toReversed()) {
      const turn = turns.get(row.turn_id) || { id: row.turn_id, status: row.status, items: [] };
      turn.items.push(JSON.parse(row.item_json)); turns.set(row.turn_id, turn);
    }
    const hasMore = selected.length < rows.length;
    return { turns: [...turns.values()], page: { order: "oldest_first", hasMore,
      nextCursor: hasMore ? "ap-grok-v1:" + Buffer.from(JSON.stringify({ threadId, turnId: onlyTurnId, before: selected.at(-1)!.seq })).toString("base64url") : null } };
  }
}
