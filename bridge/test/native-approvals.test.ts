import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopNativeApprovals, approvalSnapshot } from "../../desktop-attach-plugin/native-approvals.mjs";

function frame(value: any) {
  const payload = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.length); return Buffer.concat([head, payload]);
}

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ap-native-approval-"));
  const path = process.platform === "win32" ? `\\\\.\\pipe\\ap-native-test-${randomUUID()}` : join(cwd, "test.sock");
  const sockets = new Set<net.Socket>(); const writes: any[] = []; const connections: string[] = [];
  const command: any = { id: 7, method: "item/commandExecution/requestApproval", params: {
    threadId: "t", turnId: "turn-1", itemId: "cmd-1", command: "echo fixture", cwd, reason: "Test only",
    availableDecisions: ["accept", "decline", "cancel", "acceptForSession"] } };
  const state: any = { id: "t", cwd, requests: [command], turns: [{ turnId: "turn-1", items: [] }] };
  const behavior = { owner: "desktop-owner", version: 11, broadcastOwner: "", host: "local", mode: "normal", afterSnapshot: "" };
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let data = Buffer.alloc(0); const clientId = randomUUID(); connections.push(clientId);
    const reply = (value: any) => { const buf = frame(value); socket.write(buf.subarray(0, 2)); socket.write(buf.subarray(2)); };
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4 && data.length >= data.readUInt32LE(0) + 4) {
        const size = data.readUInt32LE(0); const m = JSON.parse(data.subarray(4, size + 4).toString()); data = data.subarray(size + 4);
        const response = (result: any = {}, owner?: string) => reply({ type: "response", requestId: m.requestId,
          resultType: "success", result, ...(owner ? { handledByClientId: owner } : {}) });
        if (m.method === "initialize") { assert.equal(m.version, 0); assert.equal(m.sourceClientId, null); response({ clientId }); }
        else if (m.method === "thread-owner-discovery") { assert.equal(m.version, 1); assert.deepEqual(m.params, { hostId: "local", conversationId: "t" }); response({}, behavior.owner); }
        else if (m.method === "thread-stream-following-changed") {
          if (!m.params.following) continue;
          assert.equal(m.sourceClientId, clientId); assert.deepEqual(m.targetClientIds, [behavior.owner]);
          if (behavior.mode === "oversized") { const head = Buffer.alloc(4); head.writeUInt32LE(128 * 1024 * 1024); socket.write(head); continue; }
          if (behavior.mode === "invalid-json") { socket.write(Buffer.from([1, 0, 0, 0, 123])); continue; }
          const snapshot = { type: "broadcast", sourceClientId: behavior.broadcastOwner || behavior.owner,
            targetClientIds: [clientId], method: "thread-stream-state-changed", version: behavior.version,
            params: { hostId: behavior.host, conversationId: "t", change: { type: "snapshot", revision: 3, conversationState: state } } };
          if (behavior.afterSnapshot) {
            const patch = { ...snapshot, params: { ...snapshot.params, change: { type: "patches", baseRevision: 3, revision: 4, patches: [] } } };
            socket.write(Buffer.concat([frame(snapshot), frame(patch)]));
          } else reply(snapshot);
        } else if (m.method?.startsWith("thread-follower-")) {
          assert.equal(m.sourceClientId, clientId); assert.equal(m.targetClientId, behavior.owner);
          assert.equal(m.version, 1, "local follower uses version 1, never remote version 2");
          assert.equal(m.params.conversationId, "t"); writes.push(m);
          if (behavior.mode === "drop") socket.destroy();
          else if (behavior.mode !== "timeout") response({}, behavior.mode === "wrong-ack-owner" ? "other-owner" : behavior.owner);
        } else if (m.type !== "client-discovery-response") assert.fail("unexpected writer operation");
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const native = new DesktopNativeApprovals({ pipePath: path, timeoutMs: 120 });
  return { cwd, command, state, behavior, native, writes, connections,
    async input(decision = "allowOnce") { const s = await native.read("t", cwd); return { threadId: "t", cwd,
      ownerClientId: s.ownerClientId, requestId: s.requests[0].id, fingerprint: s.requests[0].fingerprint, decision }; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test("native command/file approval uses a new follower connection and the original owner, never another writer", async () => {
  const f = await fixture();
  try {
    const input = await f.input();
    assert.deepEqual(await f.native.respond(input), { ok: true, decision: "allowOnce" });
    assert.equal(f.connections.length, 2); assert.notEqual(f.connections[0], f.connections[1]);
    assert.equal(f.writes[0].method, "thread-follower-command-approval-decision");
    assert.equal(f.writes[0].params.requestId, 7); assert.equal(f.writes[0].params.decision, "accept");
    f.command.id = "7"; f.command.method = "item/fileChange/requestApproval";
    f.command.params.changes = [{ path: "example.txt", kind: { type: "update" }, diff: "-old\n+new" }];
    await f.native.respond(await f.input("deny"));
    assert.equal(f.writes[1].params.requestId, "7"); assert.equal(f.writes[1].method, "thread-follower-file-approval-decision");
    assert.equal(f.writes[1].params.decision, "decline");
  } finally { await f.close(); }
});

test("native refuses disappeared, changed, restricted, cross-owner and out-of-scope approvals before writing", async () => {
  const f = await fixture();
  try {
    const input = await f.input();
    for (const change of [() => f.state.requests = [], () => f.command.params.command = "different",
      () => f.behavior.owner = "new-owner", () => f.command.params.availableDecisions = ["decline"],
      () => f.command.params._meta = { "openai/userVerification": {} }]) {
      const saved = structuredClone(f.command); change();
      await assert.rejects(f.native.respond(input), (error: any) => error.delivery === "not_sent");
      Object.assign(f.command, saved); f.state.requests = [f.command]; f.behavior.owner = "desktop-owner";
    }
    await assert.rejects(f.native.respond({ ...input, decision: "acceptForSession" }));
    await assert.rejects(f.native.respond({ ...input, requestId: "7" }));
    await assert.rejects(f.native.read("t", tmpdir()));
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test("native fail-closed framing, version, host, owner, patch and identity checks", async () => {
  const f = await fixture();
  try {
    for (const [key, value] of [["version", 12], ["host", "remote"], ["broadcastOwner", "wrong-owner"],
      ["afterSnapshot", "patch"], ["mode", "oversized"], ["mode", "invalid-json"]] as const) {
      const original = f.behavior[key]; (f.behavior as any)[key] = value;
      await assert.rejects(f.native.read("t", f.cwd)); (f.behavior as any)[key] = original;
    }
    assert.equal(f.writes.length, 0);
    const snapshot = approvalSnapshot(f.state, "owner", "t", f.cwd);
    assert.deepEqual(snapshot.requests[0].allowedDecisions, ["allowOnce", "deny", "cancel"]);
    delete f.command.params.availableDecisions;
    assert.deepEqual(approvalSnapshot(f.state, "owner", "t", f.cwd).requests[0].allowedDecisions,
      ["allowOnce", "deny", "cancel"], "only the pinned local v1 optional-field default is supported");
    for (const value of [null, {}, "accept", []]) {
      f.command.params.availableDecisions = value;
      assert.equal(approvalSnapshot(f.state, "owner", "t", f.cwd).requests[0].available, false);
    }
    f.command.params.availableDecisions = ["acceptForSession"];
    assert.equal(approvalSnapshot(f.state, "owner", "t", f.cwd).requests[0].available, false);
    f.command.method = "item/permissions/requestApproval";
    assert.equal(approvalSnapshot(f.state, "owner", "t", f.cwd).requests[0].available, false);
    f.state.requests = []; f.state.turns[0].items.push({ ...f.command });
    assert.equal(approvalSnapshot(f.state, "owner", "t", f.cwd).requests.length, 0, "history is not a pending request");
  } finally { await f.close(); }
});

test("lost or foreign native acknowledgements are unknown, never safe-to-retry failures", async () => {
  const f = await fixture();
  try {
    for (const mode of ["timeout", "drop", "wrong-ack-owner"]) {
      const input = await f.input(); f.behavior.mode = mode;
      await assert.rejects(f.native.respond(input), (error: any) => error.delivery === "unknown");
      f.behavior.mode = "normal";
    }
    assert.equal(f.writes.length, 3);
  } finally { await f.close(); }
});

test("canonical turn history supplies details only for a current native request", async () => {
  const f = await fixture();
  try {
    delete f.command.params.command; delete f.command.params.turnId;
    f.state.turnHistory = { kind: "canonical", history: {
      entitiesByKey: { turn: { turnId: "turn-1", items: {
        entitiesByKey: { command: { id: "cmd-1", command: "echo canonical" } },
        islands: [{ entries: [{ value: "command" }] }] } } },
      islands: [{ entries: [{ value: "turn" }] }] } };
    const card = (await f.native.read("t", f.cwd)).requests[0];
    assert.equal(card.available, true); assert.equal(card.params.command, "echo canonical");
    assert.equal(card.params.turnId, "turn-1");
    f.state.requests = [];
    assert.deepEqual((await f.native.read("t", f.cwd)).requests, []);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});
