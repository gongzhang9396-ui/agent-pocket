// Uses a fresh CODEX_HOME and a loopback Responses fixture. No real model,
// account, Desktop, or existing Agent Pocket state participates in this probe.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CodexThreadPool } from "../src/codex-pool.ts";
import { BridgeServer } from "../src/server.ts";
import { BridgeStore } from "../src/store.ts";

const command = process.argv.slice(2).find(arg => arg !== "--pool") || "codex";
const root = mkdtempSync(join(tmpdir(), "agent-pocket-thread-sharing-"));
const home = join(root, "codex");
const workspace = join(root, "workspace");
for (const dir of [home, workspace, join(root, "appdata"), join(root, "local")]) mkdirSync(dir);
// Do not inherit API tokens, user homes, hooks, or provider environment settings.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA)$/i.test(key)));
Object.assign(env, { CODEX_HOME: home, HOME: root, USERPROFILE: root,
  APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "local"), TEMP: root, TMP: root });
let modelRequests = 0;
const model = createServer((request, response) => {
  request.resume();
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  const id = `resp_probe_${++modelRequests}`;
  const item = { id: `msg_probe_${modelRequests}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "PROBE_OK", annotations: [] }] };
  const result = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model: "probe-model",
    status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("response.created", { response: { ...result, status: "in_progress", output: [] } });
  event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "PROBE_OK" });
  event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "PROBE_OK" });
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response: result });
  response.end();
});
const clients = [];
function client() {
  const child = spawn(command, ["app-server", "--stdio"], {
    cwd: workspace, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const notifications = [];
  const events = new EventEmitter();
  let nextId = 1;
  let stderr = "";
  let forcedStop = false;
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  const rejectPending = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.on("error", rejectPending);
  const closed = new Promise(resolve => child.once("close", (code) => {
    rejectPending(new Error(`Probe app-server closed: ${code}; ${stderr}`));
    resolve();
  }));
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  createInterface({ input: child.stdout }).on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: "Probe does not execute tools" } });
      return;
    }
    if (message.method) {
      notifications.push(message);
      if (notifications.length > 500) notifications.shift();
      events.emit("notification", message);
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else item.resolve(message.result);
  });
  const api = {
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 12000);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    },
    async initialize() {
      await api.request("initialize", { clientInfo: { name: "agent-pocket-probe", version: "1" }, capabilities: { experimentalApi: true } });
      send({ method: "initialized" });
    },
    waitForNotification(method, predicate) {
      const matches = message => message.method === method && predicate(message.params);
      const existing = notifications.find(matches);
      if (existing) return Promise.resolve(existing.params);
      return new Promise((resolve, reject) => {
        const listener = message => {
          if (!matches(message)) return;
          clearTimeout(timer);
          events.off("notification", listener);
          resolve(message.params);
        };
        const timer = setTimeout(() => {
          events.off("notification", listener);
          reject(new Error(`Timeout: notification ${method}`));
        }, 15000);
        events.on("notification", listener);
      });
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        const timer = setTimeout(() => { forcedStop = true; child.kill(); }, 3000);
        await closed;
        clearTimeout(timer);
      }
      return { graceful: !forcedStop && child.exitCode === 0 };
    },
  };
  clients.push(api);
  return api;
}

async function observe(name, operation) {
  try { return { name, ok: true, value: await operation() }; }
  catch (error) { return { name, ok: false, error: error.message, code: error.code }; }
}

try {
  await new Promise((resolve, reject) => {
    model.once("error", reject);
    model.listen(0, "127.0.0.1", resolve);
  });
  writeFileSync(join(home, "config.toml"), [
    'model = "probe-model"', 'model_provider = "probe"',
    'approval_policy = "never"', 'sandbox_mode = "read-only"',
    'cli_auth_credentials_store = "file"', '[analytics]', 'enabled = false',
    '[model_providers.probe]', 'name = "Isolated probe"',
    `base_url = "http://127.0.0.1:${model.address().port}/v1"`, 'wire_api = "responses"',
    '[model_providers.other]', 'name = "Other isolated provider"',
    `base_url = "http://127.0.0.1:${model.address().port}/v1"`, 'wire_api = "responses"',
  ].join("\n"));
  const version = spawnSync(command, ["--version"], { env, windowsHide: true, encoding: "utf8", timeout: 5000 });
  if (version.error || version.status !== 0) throw new Error("Unable to run codex --version");
  if (process.argv.includes("--pool")) {
    const pool = new CodexThreadPool({ command, codexHome: home, minVersion: "0.153.1", env, cwd: workspace });
    const observed = [];
    pool.on("notification", message => {
      observed.push({ method: message.method, threadId: message.params?.threadId, status: message.params?.status });
      if (observed.length > 30) observed.shift();
    });
    clients.push({ stop: async () => { pool.stop(); } });
    const status = await pool.start();
    if (status.readOnly) throw new Error(status.error || "Pool is read-only");
    const store = new BridgeStore(join(root, "bridge.db"));
    const server = new BridgeServer({ projectRoots: [workspace], dbPath: join(root, "bridge.db"), codexHome: home,
      hostName: "Isolated", bindHost: "127.0.0.1", port: 0, minCodexVersion: "0.153.1", codexCommand: command },
      store, pool, { send: async () => {} });
    clients.push({ stop: async () => { await server.stop(); store.close(); } });
    const turn = async (threadId) => {
      const notifications = [];
      const listener = message => notifications.push(message);
      pool.on("notification", listener);
      try {
        const started = await pool.request("turn/start", { threadId, input: [{ type: "text", text: "Return PROBE_OK without using tools." }] });
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const done = notifications.find(n => n.method === "turn/completed" && n.params.threadId === threadId && n.params.turn.id === started.turn.id);
          if (done) {
            if (done.params.turn.status !== "completed") throw new Error("Pool turn failed");
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error("Pool turn timed out");
      } finally { pool.off("notification", listener); }
    };
    const start = (modelProvider = "probe") => pool.request("thread/start", { cwd: workspace, model: "probe-model", modelProvider, approvalPolicy: "never", sandbox: "read-only" });
    const first = await start("other");
    const second = await start();
    store.setThreadOwner(first.thread.id, "bridge");
    store.setThreadOwner(second.thread.id, "bridge");
    await turn(first.thread.id);
    await turn(second.thread.id);
    const modelList = await server.dispatchRelay("probe-device", "model/list", {});
    if (modelList.data[0]?.model !== "probe-model" || !modelList.data[0]?.isDefault) throw new Error("Configured API model was not the default");
    const inbox = await server.dispatchRelay("probe-device", "thread/list", {});
    if (![first.thread.id, second.thread.id].every(id => inbox.data.some(row => row.id === id))) throw new Error("API tasks missing from native catalog");
    const paged = await server.dispatchRelay("probe-device", "thread/read", { threadId: first.thread.id });
    if (paged.thread.turns.length !== 1 || paged.page.order !== "newest_first") throw new Error("Native read did not use paginated history");
    const apiNotifications = [];
    const apiListener = message => apiNotifications.push(message);
    pool.on("notification", apiListener);
    let apiTaskTurns;
    try {
      const created = await server.dispatchRelay("probe-device", "thread/start", { target: "bridge", cwd: workspace, text: "Return PROBE_OK." });
      const waitTurn = async (turnId) => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const done = apiNotifications.find(n => n.method === "turn/completed" && n.params.turn.id === turnId);
          if (done) { if (done.params.turn.status !== "completed") throw new Error("API Host turn failed"); return; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error("API Host turn timed out");
      };
      await waitTurn(created.turn.id);
      const continued = await server.dispatchRelay("probe-device", "turn/start", { threadId: created.thread.id, text: "Continue with PROBE_OK." });
      await waitTurn(continued.turn.id);
      const history = await server.dispatchRelay("probe-device", "thread/read", { threadId: created.thread.id });
      apiTaskTurns = history.thread.turns.length;
      if (created.thread.execution.backend !== "bridge" || apiTaskTurns !== 2) throw new Error("API-only Host lifecycle lost history");
      await pool.releaseThread(created.thread.id);
    } finally { pool.off("notification", apiListener); }
    const release = await pool.releaseThread(first.thread.id).catch(error => {
      console.error(JSON.stringify({ releaseCheckObserved: observed }));
      throw error;
    });
    const desktopStandIn = client();
    await desktopStandIn.initialize();
    const resumed = await desktopStandIn.request("thread/resume", { threadId: first.thread.id });
    store.setThreadOwner(first.thread.id, "desktop");
    const ownerBeforeRead = store.threadOwner(first.thread.id);
    await server.dispatchRelay("probe-device", "thread/read", { threadId: first.thread.id });
    if (store.threadOwner(first.thread.id) !== ownerBeforeRead) throw new Error("History read changed execution ownership");
    const contender = client();
    await contender.initialize();
    let foreignWriterPreserved = false;
    try { await contender.request("thread/resume", { threadId: first.thread.id }); }
    catch (error) { foreignWriterPreserved = /writer|lock|held/i.test(error.message); }
    if (!foreignWriterPreserved) throw new Error("Read unexpectedly released the foreign writer");
    const next = await desktopStandIn.request("turn/start", { threadId: first.thread.id, input: [{ type: "text", text: "Continue with PROBE_OK." }] });
    const done = await desktopStandIn.waitForNotification("turn/completed", p => p.threadId === first.thread.id && p.turn.id === next.turn.id);
    await turn(second.thread.id);
    const firstHistory = await desktopStandIn.request("thread/read", { threadId: first.thread.id, includeTurns: true });
    const secondHistory = await pool.request("thread/read", { threadId: second.thread.id, includeTurns: true });
    const result = { release, sameThread: resumed.thread.id === first.thread.id, model: resumed.model,
      provider: resumed.modelProvider, continued: done.turn.status === "completed",
      nativeCatalog: true, paginatedHistory: true, configuredApiDefault: true, foreignWriterPreserved,
      apiOnlyHostTurns: apiTaskTurns,
      firstTurns: firstHistory.thread.turns.length, unaffectedTurns: secondHistory.thread.turns.length };
    if (!result.sameThread || !result.continued || result.firstTurns !== 2 || result.unaffectedTurns !== 2) throw new Error("Pooled handoff lost continuity");
    await pool.releaseThread(second.thread.id);
    await pool.closeGracefully();
    console.log(JSON.stringify({ version: version.stdout.trim(), root, scope: "Production thread-pool code with a loopback model; Desktop is represented by a second CLI", modelRequests, result }, null, 2));
  } else {
  const first = client();
  await first.initialize();
  const created = await first.request("thread/start", { cwd: workspace, model: "probe-model", modelProvider: "probe", approvalPolicy: "never", sandbox: "read-only" });
  const threadId = created.thread.id;
  const started = await first.request("turn/start", { threadId, input: [{ type: "text", text: "Return PROBE_OK without using tools." }] });
  const completed = await first.waitForNotification("turn/completed", p => p.threadId === threadId && p.turn.id === started.turn.id);
  if (completed.turn.status !== "completed" || modelRequests < 1) throw new Error("Loopback fixture turn did not complete");
  const second = client();
  await second.initialize();
  const results = [];
  let parallelThreadId;
  results.push(await observe("independent_thread_in_same_home", async () => {
    const parallel = await second.request("thread/start", { cwd: workspace, model: "probe-model", modelProvider: "probe", approvalPolicy: "never", sandbox: "read-only" });
    parallelThreadId = parallel.thread.id;
    const turn = await second.request("turn/start", { threadId: parallelThreadId, input: [{ type: "text", text: "Return PROBE_OK without using tools." }] });
    const done = await second.waitForNotification("turn/completed", p => p.threadId === parallelThreadId && p.turn.id === turn.turn.id);
    if (done.turn.status !== "completed") throw new Error("Independent thread did not complete");
    return { differentThread: parallelThreadId !== threadId, turnCompleted: true };
  }));
  results.push(await observe("read_from_second_writer", async () => {
    const r = await second.request("thread/read", { threadId });
    return { sameThread: r.thread.id === threadId, status: r.thread.status };
  }));
  results.push(await observe("resume_while_first_writer_is_idle", async () => {
    const r = await second.request("thread/resume", { threadId });
    return { sameThread: r.thread.id === threadId, model: r.model, provider: r.modelProvider };
  }));
  results.push(await observe("unsubscribe_first_writer", () => first.request("thread/unsubscribe", { threadId })));
  results.push(await observe("loaded_after_unsubscribe", async () => {
    const r = await first.request("thread/loaded/list");
    return { stillLoaded: r.data.includes(threadId) };
  }));
  results.push(await observe("resume_immediately_after_unsubscribe", async () => {
    const r = await second.request("thread/resume", { threadId });
    return { sameThread: r.thread.id === threadId };
  }));
  const firstExit = await first.stop();
  if (!firstExit.graceful) throw new Error("First probe process required forced cleanup; normal handoff was not verified");
  results.push(await observe("other_thread_survives_release", async () => {
    const r = await second.request("thread/read", { threadId: parallelThreadId, includeTurns: true });
    return { sameThread: r.thread.id === parallelThreadId, historyTurns: r.thread.turns.length };
  }));
  results.push(await observe("resume_after_first_process_exit", async () => {
    const r = await second.request("thread/resume", { threadId });
    const next = await second.request("turn/start", { threadId, input: [{ type: "text", text: "Continue with PROBE_OK without using tools." }] });
    const done = await second.waitForNotification("turn/completed", p => p.threadId === threadId && p.turn.id === next.turn.id);
    const history = await second.request("thread/read", { threadId, includeTurns: true });
    return { sameThread: r.thread.id === threadId, model: r.model, provider: r.modelProvider,
      turnCompleted: done.turn.status === "completed", historyTurns: history.thread.turns.length };
  }));
  const resumed = results.at(-1);
  if (!resumed.ok || !resumed.value.sameThread || !resumed.value.turnCompleted || resumed.value.historyTurns !== 2 || !results[0].ok) process.exitCode = 1;
  console.log(JSON.stringify({ version: version.stdout.trim(), root, modelRequests, firstExit,
    scope: "Synthetic CLI threads and loopback model fixture; not a Desktop test", results }, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await Promise.all(clients.map(c => c.stop()));
  if (model.listening) {
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
  }
  // Leave only synthetic artifacts for inspection; never delete a computed tree.
}
