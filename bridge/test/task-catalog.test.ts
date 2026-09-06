import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskCatalog, listEffectiveModels } from "../src/task-catalog.ts";

const unsupported = () => Object.assign(new Error("Method not found"), { codexError: { code: -32601 } });

test("large native turns paginate by bytes without losing items when new replies arrive", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pocket-large-history-"));
  const items = Array.from({ length: 110 }, (_, i) => ({
    id: `item-${i}`, type: "commandExecution", command: "inspect", aggregatedOutput: "中".repeat(9_000), status: "completed",
  }));
  const newest = { id: "newest", status: "completed", items };
  const older = { id: "older", status: "completed", items: [{ id: "old-message", type: "agentMessage", text: "older answer" }] };
  let appendedTurn = false;
  const client = { request: async (method: string, params: any) => method === "thread/read"
    ? { thread: { id: "task", cwd } }
    : params.cursor ? { data: [older], nextCursor: null } : { data: appendedTurn
      ? [{ id: "arrived-turn", items: [{ id: "arrived-message", type: "agentMessage", text: "new" }] }, newest]
      : [newest], nextCursor: "native-older" } };
  const catalog = new TaskCatalog(client as any, [cwd], (thread) => thread);
  let page = await catalog.read("task");
  const ids: string[] = [];
  let pages = 0;
  const expected = [...items.map((item) => item.id), "old-message"].sort();
  while (true) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 768 * 1024, "wire page must fit the encrypted transport budget");
    ids.push(...page.thread.turns.flatMap((turn: any) => turn.items.map((item: any) => item.id)));
    if (++pages === 1) {
      newest.items.push({ ...items[0], id: "arrived-after-read" });
      appendedTurn = true;
    }
    if (!page.page.hasMore) break;
    assert.ok(pages < 12, "pagination must make progress");
    page = await catalog.read("task", page.page.nextCursor!);
  }
  assert.ok(pages > 2);
  assert.deepEqual(ids.sort(), expected);
  assert.equal(new Set(ids).size, ids.length);
});

test("legacy full history is also byte paginated and a single huge item fails with a bounded error", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pocket-legacy-large-"));
  const items = Array.from({ length: 90 }, (_, i) => ({ id: `item-${i}`, type: "agentMessage", text: "x".repeat(20_000) }));
  const catalog = new TaskCatalog({ request: async (method: string, params: any) => {
    if (method === "thread/turns/list") throw unsupported();
    return { thread: { id: "task", cwd, turns: params.includeTurns ? [{ id: "turn", items }] : [] } };
  } } as any, [cwd], (thread) => thread);
  let page = await catalog.read("task");
  const seen: string[] = [];
  let pages = 0;
  do {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 768 * 1024);
    seen.push(...page.thread.turns.flatMap((turn: any) => turn.items.map((item: any) => item.id)));
    if (!page.page.hasMore) break;
    assert.ok(++pages < 10);
    page = await catalog.read("task", page.page.nextCursor!);
  } while (true);
  assert.deepEqual(seen.sort(), items.map((item) => item.id).sort());
  items.push({ id: "huge", type: "agentMessage", text: "x".repeat(1024 * 1024) });
  await assert.rejects(catalog.read("task"), (error: any) => error.nameCode === "RESPONSE_TOO_LARGE");
});

test("list cursors cannot switch readers or search queries", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pocket-list-cursor-"));
  const calls: any[] = [];
  const catalog = new TaskCatalog({ request: async (_method: string, params: any) => {
    calls.push(params);
    return { data: [{ id: "task", cwd }], nextCursor: params.cursor ? null : "native-page-2" };
  } } as any, [cwd], (thread) => thread);
  const first = await catalog.list(undefined, "term", 1);
  await catalog.list(first.nextCursor!, "term", 1);
  assert.equal(calls.at(-1).cursor, "native-page-2");
  await assert.rejects(catalog.list(first.nextCursor!, "different", 1), (error: any) => error.nameCode === "INVALID_REQUEST");
  await assert.rejects(catalog.list("desktop-cursor", "term", 1), (error: any) => error.nameCode === "INVALID_REQUEST");
  assert.equal(calls.length, 2);
});

test("catalog fills a filtered page across providers without loading a writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-catalog-"));
  const allowed = join(root, "allowed"); mkdirSync(allowed);
  const calls: any[] = [];
  const catalog = new TaskCatalog({ request: async (method: string, params: any) => {
    calls.push({ method, params });
    return params.cursor ? { data: [{ id: "api-task", cwd: allowed, modelProvider: "custom" }], nextCursor: null }
      : { data: [{ id: "outside", cwd: root }], nextCursor: "next" };
  } } as any, [allowed], (thread) => thread);
  const result = await catalog.list(undefined, undefined, 1);
  assert.deepEqual(result.data.map((row) => row.id), ["api-task"]);
  assert.equal(result.excluded, 1);
  assert.equal(result.nextCursor, null);
  assert.ok(calls.every((call) => call.method === "thread/list"));
  assert.deepEqual(calls[0].params.modelProviders, []);
  assert.ok(calls[0].params.sourceKinds.includes("appServer"));
});

test("history cursors bind the native reader and task, and paths are checked before paging", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pocket-pages-"));
  const calls: any[] = [];
  const client = { request: async (method: string, params: any) => {
    calls.push({ method, params });
    return method === "thread/read" ? { thread: { id: params.threadId, cwd } }
      : { data: [{ id: params.cursor || "new", items: [] }], nextCursor: params.cursor ? null : "old" };
  } };
  const catalog = new TaskCatalog(client as any, [cwd], (thread) => thread);
  const latest = await catalog.read("task");
  assert.equal(latest.page.order, "newest_first");
  assert.equal(latest.page.hasMore, true);
  assert.equal(calls[0].params.includeTurns, false);
  assert.equal(calls[1].params.limit, 10);
  const older = await catalog.read("task", latest.page.nextCursor!);
  assert.equal(older.thread.turns[0].id, "old");
  const before = calls.length;
  await assert.rejects(catalog.read("other", latest.page.nextCursor!), (error: any) => error.nameCode === "INVALID_REQUEST");
  assert.equal(calls.length, before);
  const denied = new TaskCatalog(client as any, [], (thread) => thread);
  await assert.rejects(denied.read("task"), (error: any) => error.nameCode === "PATH_DENIED");
  assert.equal(calls.at(-1).method, "thread/read");
  assert.ok(calls.every((call) => ["thread/read", "thread/turns/list"].includes(call.method)));
});

test("only explicit unsupported pagination falls back to full history", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pocket-old-cli-"));
  let pageError = new Error("Transport lost");
  let fullReads = 0;
  const catalog = new TaskCatalog({ request: async (method: string, params: any) => {
    if (method === "thread/turns/list") throw pageError;
    if (params.includeTurns) fullReads++;
    return { thread: { id: "task", cwd, turns: [] } };
  } } as any, [cwd], (thread) => thread);
  await assert.rejects(catalog.read("task"), /Transport lost/);
  assert.equal(fullReads, 0);
  pageError = unsupported();
  assert.equal((await catalog.read("task")).page.order, "newest_first");
  assert.equal(fullReads, 1);
});

test("configured API model survives directory failure without leaking config", async () => {
  const client = { request: async (method: string) => {
    if (method === "model/list") throw new Error("directory unavailable");
    return { config: { model: "vendor-model", model_provider: "vendor", model_reasoning_effort: "high",
      model_providers: { vendor: { base_url: "PRIVATE_URL", experimental_bearer_token: "SECRET" } } }, origins: "PRIVATE_PATH" };
  } };
  const result = await listEffectiveModels(client as any, {});
  assert.equal(result.data[0].id, "vendor-model");
  assert.equal(result.data[0].isDefault, true);
  assert.equal(result.configuredProvider, "vendor");
  assert.ok(!/PRIVATE|SECRET/.test(JSON.stringify(result)));
  await assert.rejects(listEffectiveModels(client as any, { cursor: "next" }), /directory unavailable/);
});

test("configured model is the single default and later model pages are not augmented", async () => {
  const client = { request: async (method: string, params: any) => method === "config/read"
    ? { config: { model: "custom" } }
    : { data: params.cursor ? [{ id: "third" }] : [{ id: "official", isDefault: true }, { id: "custom", displayName: "Custom" }], nextCursor: "next" } };
  const result = await listEffectiveModels(client as any, {});
  assert.deepEqual(result.data.map((row: any) => row.id), ["custom", "official"]);
  assert.equal(result.data.filter((row: any) => row.isDefault).length, 1);
  assert.deepEqual((await listEffectiveModels(client as any, { cursor: "next" })).data, [{ id: "third" }]);
});
