import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopAttachClient, normalizeDesktopThreadList, parseDesktopAttachRegistration } from "../src/desktop-attach.ts";

function pipeName() {
  return `\\\\.\\pipe\\agent-pocket-desktop-attach-${randomUUID()}`;
}

function fakeDesktopAttach(options: { readOnly?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-desktop-attach-"));
  const registrationPath = join(base, "desktop-attach.json");
  const token = randomBytes(32).toString("base64url");
  const pipe = pipeName();
  const readOnly = options.readOnly === true;
  const calls: any[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (!authenticated) {
          if (message.method !== "attach/hello" || message.params?.token !== token) {
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "AUTH_FAILED" } })}\n`);
            socket.end();
            continue;
          }
          authenticated = true;
          socket.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: 1, readOnly, capabilities: ["attach/probe", "thread/list", "thread/read", "thread/send", "thread/wait"] },
          })}\n`);
          continue;
        }
        calls.push({ method: message.method, params: message.params });
        if (message.method === "attach/probe") {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true, mode: "read-only-poc", available: [] } })}\n`);
        } else if (message.method === "thread/list") {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { contentItems: [{ type: "inputText", text: "{}" }] } })}\n`);
        } else if (message.method === "thread/send") {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { accepted: true } })}\n`);
        } else if (message.method === "thread/wait") {
          socket.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              cursor: message.params?.afterCursor ? "cursor:2" : "cursor:1",
              changed: Boolean(message.params?.afterCursor),
              threadStatus: "idle",
              turnId: "turn-1",
              turnStatus: message.params?.afterCursor ? "completed" : undefined,
              wakeReason: message.params?.afterCursor ? "turnCompleted" : undefined,
              timedOut: !message.params?.afterCursor,
            },
          })}\n`);
        }
      }
    });
  });

  mkdirSync(base, { recursive: true });
  writeFileSync(registrationPath, JSON.stringify({
    protocolVersion: 1,
    instanceId: randomUUID(),
    pipeName: pipe,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    readOnly,
    capabilities: ["attach/probe", "thread/list", "thread/read", "thread/send", "thread/wait"],
  }));
  return { server, pipe, registrationPath, calls };
}

test("validates Desktop Attach registration", () => {
  assert.throws(() => parseDesktopAttachRegistration({ protocolVersion: 1 }));
  assert.throws(() => parseDesktopAttachRegistration({
    protocolVersion: 2, instanceId: "x", pipeName: pipeName(), token: randomBytes(32).toString("base64url"),
    pid: 1, startedAt: new Date().toISOString(), capabilities: [],
  }));
});

test("normalizes Desktop task inbox without exposing non-Codex chats", () => {
  const result = normalizeDesktopThreadList({
    contentItems: [{
      type: "inputText",
      text: JSON.stringify({
        pinnedThreads: [{ id: "p1", kind: "codex", title: "Pinned", summary: "one", cwd: "C:\\Projects", updatedAt: 10, status: "idle" }],
        threads: [
          { id: "p1", kind: "codex", title: "Duplicate", summary: "ignored", cwd: "C:\\Projects", updatedAt: 9, status: "idle" },
          { id: "t1", kind: "codex", title: "Desktop task", summary: "latest", cwd: "C:\\Projects\\demo", updatedAt: 11, status: "active" },
          { id: "c1", kind: "chatgpt", title: "Chat", summary: "not Codex", cwd: "", updatedAt: 12, status: "idle" },
        ],
      }),
    }],
  });
  assert.deepEqual(result.data.map((thread: any) => thread.id), ["p1", "t1"]);
  assert.equal(result.data[0].status.type, "active");
  assert.equal(result.data[0].source, "desktop");
  assert.equal(result.readOnly, false);
  assert.equal(result.data[0].capabilities.send, true);
  assert.equal(result.data[0].capabilities.interrupt, false);
});

test("authenticates and calls Desktop Attach read and restricted send methods", async () => {
  const fake = fakeDesktopAttach();
  await new Promise<void>((resolve, reject) => {
    fake.server.once("error", reject);
    fake.server.listen(fake.pipe, resolve);
  });
  try {
    const client = new DesktopAttachClient({ registrationPath: fake.registrationPath, timeoutMs: 2_000 });
    const probe = await client.probe();
    assert.equal(probe.ok, true);
    const tasks = await client.listThreads(3);
    assert.equal(tasks.contentItems.length, 1);
    const sent = await client.sendMessage("desktop-thread", "continue safely");
    assert.equal(sent.accepted, true);
    assert.deepEqual(fake.calls.at(-1), {
      method: "thread/send",
      params: { threadId: "desktop-thread", text: "continue safely" },
    });
    const baseline = await client.waitThread("desktop-thread", undefined, 0);
    assert.equal(baseline.cursor, "cursor:1");
    assert.equal(baseline.changed, false);
    const changed = await client.waitThread("desktop-thread", baseline.cursor, 500);
    assert.equal(changed.cursor, "cursor:2");
    assert.equal(changed.turnStatus, "completed");
    assert.deepEqual(fake.calls.at(-1), {
      method: "thread/wait",
      params: { threadId: "desktop-thread", afterCursor: "cursor:1", timeoutMs: 500 },
    });
  } finally {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  }
});

test("rejects Desktop writes when registration and handshake are read-only", async () => {
  const fake = fakeDesktopAttach({ readOnly: true });
  await new Promise<void>((resolve, reject) => {
    fake.server.once("error", reject);
    fake.server.listen(fake.pipe, resolve);
  });
  try {
    const client = new DesktopAttachClient({ registrationPath: fake.registrationPath, timeoutMs: 2_000 });
    await assert.rejects(client.sendMessage("desktop-thread", "blocked"), /只读模式/);
    assert.equal(fake.calls.length, 0);
  } finally {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  }
});

test("rejects missing registration without exposing credentials", async () => {
  const client = new DesktopAttachClient({ registrationPath: join(tmpdir(), randomUUID(), "missing.json"), timeoutMs: 50 });
  await assert.rejects(client.probe(), /插件未运行/);
});
