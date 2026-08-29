import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(pluginRoot, "server.mjs")], {
  cwd: pluginRoot,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let buffer = "";
const pending = new Map();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  }
});

child.stderr.on("data", () => {});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP smoke test timed out: ${method}`));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function toolPayload(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Tool returned no text payload");
  const payload = JSON.parse(text);
  if (!payload.ok) throw new Error(payload.error || "Tool failed");
  return payload;
}

try {
  if (!process.env.CODEX_APP_TOOLS_PIPE_PATH) throw new Error("Desktop pipe environment is unavailable");
  if (!process.env.CODEX_THREAD_ID && !process.env.CODEX_SESSION_ID) throw new Error("Desktop task context is unavailable");

  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "agent-pocket-smoke", version: "0.1.0" },
  });

  const probe = toolPayload(await request("tools/call", {
    name: "desktop_attach_probe",
    arguments: {},
  }));
  if (!probe.desktopPipeAvailable || !probe.callerContextAvailable) {
    throw new Error("Desktop attachment probe did not receive the required context");
  }

  const required = ["list_threads", "read_thread", "send_message_to_thread"];
  const available = new Set(probe.available.map((item) => item.name));
  for (const name of required) {
    if (!available.has(name)) throw new Error(`Required Desktop tool is unavailable: ${name}`);
  }

  const tasks = toolPayload(await request("tools/call", {
    name: "desktop_attach_list_tasks",
    arguments: { limit: 3 },
  }));
  if (!Array.isArray(tasks.result)) throw new Error("Desktop task list response was malformed");

  console.log(JSON.stringify({
    ok: true,
    mode: probe.mode,
    desktopPipeAvailable: probe.desktopPipeAvailable,
    callerContextAvailable: probe.callerContextAvailable,
    availableTools: probe.available.map((item) => item.name),
    taskListContentItems: tasks.result.length,
  }, null, 2));
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
