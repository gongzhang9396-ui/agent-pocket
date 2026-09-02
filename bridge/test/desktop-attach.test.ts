import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DesktopAttachClient,
  normalizeDesktopProjectList,
  normalizeDesktopThreadList,
  normalizeDesktopThreadRead,
  parseDesktopAttachRegistration,
} from "../src/desktop-attach.ts";

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
            result: { protocolVersion: 1, readOnly, capabilities: ["attach/probe", "project/list", "thread/list", "thread/read", "thread/create", "thread/send", "thread/wait"] },
          })}\n`);
          continue;
        }
        calls.push({ method: message.method, params: message.params });
        if (message.method === "attach/probe") {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true, mode: "read-only-poc", available: [] } })}\n`);
        } else if (message.method === "project/list") {
          socket.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              contentItems: [{ type: "inputText", text: JSON.stringify({
                projects: [{ projectId: "project-1", projectKind: "local", label: "Demo", path: "C:\\Projects\\demo" }],
              }) }],
            },
          })}\n`);
        } else if (message.method === "thread/list") {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { contentItems: [{ type: "inputText", text: "{}" }] } })}\n`);
        } else if (message.method === "thread/read") {
          socket.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              contentItems: [{ type: "inputText", text: JSON.stringify({
                thread: {
                  id: message.params?.threadId,
                  kind: "codex",
                  title: "Desktop task",
                  preview: "latest",
                  cwd: "C:\\Projects\\demo",
                  status: { type: "idle" },
                },
                turns: [{ id: "turn-1", status: "completed", items: [] }],
              }) }],
            },
          })}\n`);
        } else if (message.method === "thread/create") {
          socket.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              source: "desktop",
              hostId: "local",
              thread: { id: "desktop-created", cwd: message.params?.cwd, source: "desktop" },
            },
          })}\n`);
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
    capabilities: ["attach/probe", "project/list", "thread/list", "thread/read", "thread/create", "thread/send", "thread/wait"],
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
          { id: "a1", kind: "codex", title: "Archived", summary: "hidden", cwd: "C:\\Projects", updatedAt: 13, status: "idle", archived: true },
          { id: "a2", kind: "codex", title: "Also archived", summary: "hidden", cwd: "C:\\Projects", updatedAt: 14, status: "idle", archivedAt: "2026-09-02T00:00:00Z" },
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

test("normalizes only valid local Desktop projects", () => {
  const result = normalizeDesktopProjectList({
    contentItems: [{
      type: "inputText",
      text: JSON.stringify({
        projects: [
          { projectId: "local-1", projectKind: "local", label: "Demo", path: "C:\\Projects\\demo" },
          { projectId: "local-1", projectKind: "local", label: "Duplicate", path: "C:\\Projects\\other" },
          { projectId: "remote-1", projectKind: "remote", label: "Remote", path: "C:\\Projects\\remote" },
          { projectId: "", projectKind: "local", label: "Missing id", path: "C:\\Projects\\bad" },
          { projectId: "relative", projectKind: "local", label: "Relative", path: "relative\\path" },
        ],
      }),
    }],
  });
  assert.deepEqual(result.data, [{ id: "local-1", name: "Demo", cwd: "C:\\Projects\\demo", source: "desktop" }]);
});

test("normalizes Desktop task reads and nests top-level turns for Android", () => {
  const result = normalizeDesktopThreadRead({
    contentItems: [{
      type: "inputText",
      text: JSON.stringify({
        thread: {
          id: "desktop-thread",
          kind: "codex",
          title: "Desktop task",
          preview: "latest",
          cwd: "C:\\Projects\\demo",
          status: { type: "idle" },
        },
        turns: [{ id: "turn-1", status: "completed", items: [] }],
      }),
    }],
  }, "desktop-thread");
  assert.equal(result.thread.id, "desktop-thread");
  assert.equal(result.thread.name, "Desktop task");
  assert.equal(result.thread.source, "desktop");
  assert.equal(result.thread.turns.length, 1);
  assert.equal(result.thread.capabilities.interrupt, false);
  assert.throws(() => normalizeDesktopThreadRead({
    contentItems: [{ type: "inputText", text: JSON.stringify({ thread: { id: "other", kind: "codex", cwd: "C:\\Projects\\demo" } }) }],
  }, "desktop-thread"), /ID 不匹配/);
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
    const projects = await client.listProjectsNormalized();
    assert.deepEqual(projects.data, [{ id: "project-1", name: "Demo", cwd: "C:\\Projects\\demo", source: "desktop" }]);
    const tasks = await client.listThreads(3);
    assert.equal(tasks.contentItems.length, 1);
    const read = await client.readThreadNormalized("desktop-thread", 5, "older:1");
    assert.equal(read.thread.id, "desktop-thread");
    assert.equal(read.thread.turns.length, 1);
    assert.deepEqual(fake.calls.at(-1), {
      method: "thread/read",
      params: { threadId: "desktop-thread", turnLimit: 5, cursor: "older:1" },
    });
    const created = await client.createThread("C:\\Projects\\demo", "new task", "gpt-test", "high", "local");
    assert.equal(created.thread.id, "desktop-created");
    assert.deepEqual(fake.calls.at(-1), {
      method: "thread/create",
      params: {
        cwd: "C:\\Projects\\demo",
        text: "new task",
        model: "gpt-test",
        effort: "high",
        workspaceMode: "local",
      },
    });
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
    const projects = await client.listProjectsNormalized();
    assert.equal(projects.data.length, 1);
    await assert.rejects(client.createThread("C:\\Projects\\demo", "blocked"), /只读模式/);
    await assert.rejects(client.sendMessage("desktop-thread", "blocked"), /只读模式/);
    assert.deepEqual(fake.calls, [{ method: "project/list", params: {} }]);
  } finally {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  }
});

test("rejects missing registration without exposing credentials", async () => {
  const client = new DesktopAttachClient({ registrationPath: join(tmpdir(), randomUUID(), "missing.json"), timeoutMs: 50 });
  await assert.rejects(client.probe(), /插件未运行/);
});
