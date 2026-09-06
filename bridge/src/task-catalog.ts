import { assertAllowedCwd } from "./config.ts";
import { CodexAppServer } from "./codex.ts";
import { ErrorName, RpcError } from "./protocol.ts";

const CURSOR_PREFIX = "ap-history-v1:";
const LIST_CURSOR_PREFIX = "ap-catalog-v1:";
// An empty sourceKinds selects Codex's interactive defaults, excluding appServer.
const ROOT_SOURCES = ["cli", "vscode", "exec", "appServer", "unknown"];
const HISTORY_PAGE_BYTES = 768 * 1024;
type HistoryPosition = { turnId: string; itemId: string | null };
export const isCatalogCursor = (cursor?: string) => cursor?.startsWith(CURSOR_PREFIX) === true;
const unsupported = (error: any) => error?.codexError?.code === -32601;

/** Native history is a read model. None of these methods resumes or claims a writer. */
export class TaskCatalog {
  private paginatedHistory = true;
  private codex: CodexAppServer;
  private roots: string[];
  private describe: (thread: any) => any;
  constructor(codex: CodexAppServer, roots: string[], describe: (thread: any) => any) {
    this.codex = codex;
    this.roots = roots;
    this.describe = describe;
  }

  async list(cursor: string | undefined, search: string | undefined, limit: number) {
    const data: any[] = [];
    let nextCursor: string | undefined;
    if (cursor) {
      try {
        if (!cursor.startsWith(LIST_CURSOR_PREFIX)) throw new Error("Different reader");
        const value = JSON.parse(Buffer.from(cursor.slice(LIST_CURSOR_PREFIX.length), "base64url").toString("utf8"));
        if (value.search !== (search || null) || typeof value.cursor !== "string" || !value.cursor) throw new Error("Different query");
        nextCursor = value.cursor;
      } catch { throw new RpcError(ErrorName.INVALID_REQUEST, "列表游标与当前查询不匹配，请刷新后重试"); }
    }
    let excluded = 0;
    const seen = new Set<string>();
    const cursors = new Set(nextCursor ? [nextCursor] : []);
    // Fill a page after path filtering, but bound work in large shared homes.
    for (let page = 0; page < 10; page++) {
      const result = await this.codex.request("thread/list", {
        cursor: nextCursor, searchTerm: search, limit: limit - data.length,
        sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true,
        archived: false, modelProviders: [], sourceKinds: ROOT_SOURCES,
      });
      if (!Array.isArray(result?.data)) throw new RpcError("INTERNAL", "Codex 任务目录格式不完整");
      for (const thread of result.data) {
        if (typeof thread?.id !== "string" || !thread.id || seen.has(thread.id)) continue;
        try {
          const cwd = assertAllowedCwd(thread.cwd, this.roots);
          seen.add(thread.id);
          data.push(this.describe({ ...thread, cwd }));
        } catch (error) {
          if (error instanceof RpcError && error.nameCode === ErrorName.PATH_DENIED) excluded++;
          else throw error;
        }
      }
      nextCursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (nextCursor && cursors.has(nextCursor)) throw new RpcError("INTERNAL", "Codex 任务目录游标重复，请重新刷新");
      if (nextCursor) cursors.add(nextCursor);
      if (!nextCursor || data.length >= limit) break;
    }
    return { data, nextCursor: nextCursor ? LIST_CURSOR_PREFIX + Buffer.from(JSON.stringify({ cursor: nextCursor, search: search || null })).toString("base64url") : null,
      source: "codex-catalog", excluded };
  }

  async read(threadId: string, cursor?: string) {
    let nativeCursor: string | undefined;
    let before: HistoryPosition | undefined;
    let legacyCursor = false;
    if (cursor) {
      try {
        if (!isCatalogCursor(cursor)) throw new Error("Different reader");
        const value = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"));
        if (value.threadId !== threadId) throw new Error("Different task");
        if (value.before !== undefined) {
          if (typeof value.before?.turnId !== "string" || !value.before.turnId ||
            (value.before.itemId !== null && (typeof value.before.itemId !== "string" || !value.before.itemId))) throw new Error("Invalid position");
          before = value.before;
        }
        if (value.cursor !== null && (typeof value.cursor !== "string" || !value.cursor)) throw new Error("Invalid cursor");
        if (value.cursor === null && !before) throw new Error("Missing position");
        if (value.legacy !== undefined && value.legacy !== true) throw new Error("Invalid reader");
        legacyCursor = value.legacy === true;
        nativeCursor = value.cursor || undefined;
      } catch { throw new RpcError(ErrorName.INVALID_REQUEST, "历史游标与当前任务不匹配，请刷新后重试"); }
    }
    const metadata = await this.codex.request("thread/read", { threadId, includeTurns: false });
    if (metadata?.thread?.id !== threadId) throw new RpcError(ErrorName.NOT_FOUND, "Codex 中找不到这个任务");
    const cwd = assertAllowedCwd(metadata.thread.cwd, this.roots);
    let page: any;
    for (let seek = 0; this.paginatedHistory && seek < 10; seek++) {
      try {
        page = await this.codex.request("thread/turns/list", {
          threadId, cursor: nativeCursor, limit: 10, sortDirection: "desc", itemsView: "full",
        });
        if (!Array.isArray(page?.data)) throw new RpcError("INTERNAL", "Codex 历史分页格式不完整");
        if (legacyCursor) throw new RpcError(ErrorName.INVALID_REQUEST, "历史读取方式已更新，请刷新任务");
        if (!before || page.data.some((turn: any) => turn.id === before!.turnId)) break;
        // A turn may have been appended since the first partial page. Seek the
        // stable turn/item boundary, never an offset relative to the new tail.
        if (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === nativeCursor) {
          throw new RpcError(ErrorName.INVALID_REQUEST, "历史位置已变化，请刷新任务");
        }
        nativeCursor = page.nextCursor;
        if (seek === 9) throw new RpcError(ErrorName.INVALID_REQUEST, "任务产生了较多新内容，请刷新后继续加载历史");
      } catch (error) {
        if (!unsupported(error) || (cursor && !legacyCursor)) throw error;
        this.paginatedHistory = false;
      }
    }
    if (!this.paginatedHistory) {
      if (cursor && !legacyCursor) throw new RpcError(ErrorName.VERSION_UNSUPPORTED, "当前 Codex 不支持此历史游标，请刷新任务");
      const full = await this.codex.request("thread/read", { threadId, includeTurns: true });
      if (full?.thread?.id !== threadId || !Array.isArray(full.thread.turns)) throw new RpcError("INTERNAL", "Codex 历史格式不完整");
      // Revalidate the response used for display, including after a concurrent cwd change.
      return this.historyPage({ ...full.thread, cwd: assertAllowedCwd(full.thread.cwd, this.roots) },
        [...full.thread.turns].reverse(), undefined, undefined, before, true);
    }
    return this.historyPage({ ...metadata.thread, cwd }, page.data, nativeCursor, page.nextCursor, before);
  }

  private historyPage(metadata: any, turns: any[], nativeCursor?: string, nextNativeCursor?: string,
    before?: HistoryPosition, legacy = false) {
    const thread = this.describe({ ...metadata, turns: [] });
    const selected: any[] = [];
    // Reserve room for the opaque cursor and response envelope, measured in
    // UTF-8 bytes because CJK text and JSON escaping change the wire size.
    let used = Buffer.byteLength(JSON.stringify(thread), "utf8") + 8192;
    const cursorFor = (position?: HistoryPosition) => {
      const next = position ? nativeCursor : nextNativeCursor;
      return position || next ? CURSOR_PREFIX + Buffer.from(JSON.stringify({
        threadId: thread.id, cursor: next || null, ...(position ? { before: position } : {}), ...(legacy ? { legacy: true } : {}),
      })).toString("base64url") : null;
    };
    const finish = (position?: HistoryPosition) => {
      const nextCursor = cursorFor(position);
      const result = { thread: { ...thread, turns: selected }, page: { hasMore: nextCursor !== null, nextCursor, order: "newest_first" } };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > HISTORY_PAGE_BYTES) {
        throw new RpcError("RESPONSE_TOO_LARGE", "任务信息超过单页大小，请在电脑查看完整内容");
      }
      return result;
    };
    const start = before ? turns.findIndex((turn) => turn.id === before.turnId) : 0;
    if (start < 0) throw new RpcError(ErrorName.INVALID_REQUEST, "历史位置已变化，请刷新任务");
    for (let turnIndex = start; turnIndex < turns.length; turnIndex++) {
      const turn = turns[turnIndex];
      const items = Array.isArray(turn.items) ? turn.items : [];
      const end = turnIndex === start && before?.itemId !== null && before?.itemId !== undefined
        ? items.findIndex((item: any) => item.id === before.itemId) : items.length;
      if (end < 0) throw new RpcError(ErrorName.INVALID_REQUEST, "历史记录已变化，请刷新任务");
      const part = { ...turn, items: [] as any[] };
      used += Buffer.byteLength(JSON.stringify(part), "utf8") + 1;
      if (used > HISTORY_PAGE_BYTES) {
        if (!selected.length) throw new RpcError("RESPONSE_TOO_LARGE", "单条任务记录过大，请在电脑查看完整内容");
        return finish({ turnId: turn.id, itemId: items[end]?.id || null });
      }
      for (let itemIndex = end - 1; itemIndex >= 0; itemIndex--) {
        const item = items[itemIndex];
        const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
        if (used + bytes > HISTORY_PAGE_BYTES) {
          if (!selected.length && !part.items.length) {
            throw new RpcError("RESPONSE_TOO_LARGE", "单条任务记录过大，请在电脑查看完整内容");
          }
          if (part.items.length) selected.push(part);
          return finish({ turnId: turn.id, itemId: items[itemIndex + 1]?.id || null });
        }
        part.items.unshift(item);
        used += bytes;
      }
      selected.push(part);
    }
    return finish();
  }
}

/** Send only effective identifiers, never the raw config, provider endpoint or credentials. */
export async function listEffectiveModels(codex: CodexAppServer, params: any) {
  // Later pages belong to the native catalog; never insert the default again.
  if (params?.cursor) return codex.request("model/list", params);
  const [models, config] = await Promise.allSettled([
    codex.request("model/list", params), codex.request("config/read", { includeLayers: false }, 5_000),
  ]);
  const effective = config.status === "fulfilled" ? config.value?.config : undefined;
  const configuredModel = typeof effective?.model === "string" ? effective.model : undefined;
  const configuredProvider = typeof effective?.model_provider === "string" ? effective.model_provider : undefined;
  const effort = typeof effective?.model_reasoning_effort === "string" ? effective.model_reasoning_effort : null;
  const result = models.status === "fulfilled" ? models.value : undefined;
  const data = Array.isArray(result?.data) ? result.data : [];
  if (!data.length && !configuredModel && models.status === "rejected") throw models.reason;
  const selected = data.find((item: any) => item.model === configuredModel || item.id === configuredModel);
  const first = configuredModel ? { ...(selected || {
    id: configuredModel, model: configuredModel, displayName: configuredModel,
    description: "当前 Codex 配置的模型", supportedReasoningEfforts: effort ? [{ reasoningEffort: effort, description: effort }] : [],
    defaultReasoningEffort: effort,
  }), isDefault: true } : undefined;
  return { data: first ? [first, ...data.filter((item: any) => item !== selected).map((item: any) => ({ ...item, isDefault: false }))] : data,
    nextCursor: result?.nextCursor || null, configuredModel, configuredProvider,
    ...(models.status === "rejected" ? { warning: "推荐模型目录暂不可用，已保留当前配置的模型" } : {}) };
}
