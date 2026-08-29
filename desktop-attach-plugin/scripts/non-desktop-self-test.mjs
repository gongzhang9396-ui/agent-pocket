import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stateRoot = mkdtempSync(join(tmpdir(), "agent-pocket-non-desktop-test-"));
const registrationPath = join(stateRoot, "AgentPocket", "desktop-attach.json");
const env = { ...process.env, LOCALAPPDATA: stateRoot, CODEX_THREAD_ID: "example-app-server-thread" };
delete env.CODEX_APP_TOOLS_PIPE_PATH;

const child = spawn(process.execPath, [join(pluginRoot, "server.mjs")], {
  cwd: pluginRoot,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let nextId = 1;
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
    const request = pending.get(message.id);
    if (!request) continue;
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  }
});
child.stderr.on("data", () => {});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "non-desktop-test", version: "1" } });
  const result = await request("tools/call", { name: "desktop_attach_probe", arguments: {} });
  const text = result.content.find((item) => item.type === "text")?.text;
  const payload = JSON.parse(text);
  assert.equal(payload.mode, "not-desktop-host");
  assert.equal(payload.desktopPipeAvailable, false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(existsSync(registrationPath), false);
  console.log(JSON.stringify({ ok: true, mode: payload.mode, registrationCreated: false }));
} finally {
  child.stdin.end();
  child.kill();
  rmSync(stateRoot, { recursive: true, force: true });
}
