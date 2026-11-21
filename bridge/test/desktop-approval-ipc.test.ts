import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopAttachClient, DESKTOP_APPROVAL_CAPABILITY } from "../src/desktop-attach.ts";

test("authenticated Attach gates native approval capability and preserves delivery certainty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-approval-ipc-"));
  const path = `\\\\.\\pipe\\agent-pocket-desktop-attach-${randomUUID()}`;
  const token = randomBytes(32).toString("base64url"); const registrationPath = join(dir, "registration.json");
  const caps = ["thread/approvals", "approval/respond", "thread/send", "thread/create", DESKTOP_APPROVAL_CAPABILITY];
  let mode = "success"; let writes = 0; const sockets = new Set<net.Socket>();
  writeFileSync(registrationPath, JSON.stringify({ protocolVersion: 1, instanceId: randomUUID(), pipeName: path,
    token, pid: process.pid, startedAt: new Date().toISOString(), readOnly: false, capabilities: caps }));
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {});
    socket.setEncoding("utf8"); let buffer = ""; let authenticated = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"); const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const response = (body: any) => socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }) + "\n");
        if (message.method === "attach/hello") {
          assert.equal(message.params.token, token); authenticated = true;
          response({ result: { protocolVersion: 1, readOnly: mode === "read-only", capabilities: mode === "old" ? [] : caps } }); continue;
        }
        assert.equal(authenticated, true); writes++;
        if (mode === "not-sent") response({ error: { code: -32000, message: "stale", data: { code: "DESKTOP_APPROVAL_STALE", delivery: "not_sent" } } });
        else if (mode === "unknown") response({ error: { code: -32000, message: "lost acknowledgement", data: { delivery: "unknown" } } });
        else if (mode === "drop") socket.destroy();
        else response({ result: { ok: true, decision: message.params.decision } });
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const client = new DesktopAttachClient({ registrationPath, timeoutMs: 200 });
  const params = { threadId: "t", cwd: dir, ownerClientId: "owner", requestId: 10, fingerprint: "a".repeat(64), decision: "deny" };
  try {
    assert.equal((await client.respondApproval(params)).ok, true);
    for (const failure of ["not-sent", "unknown", "drop", "old", "read-only"]) {
      mode = failure; const before = writes;
      await assert.rejects(client.respondApproval(params), (error: any) => error.delivery === (["unknown", "drop"].includes(mode) ? "unknown" : "not_sent"));
      if (mode === "old" || mode === "read-only") assert.equal(writes, before);
    }
    for (const action of [() => client.sendMessage("t", "fixture"), () => client.createThread(dir, "fixture")]) {
      for (const failure of ["not-sent", "unknown", "drop", "old", "read-only"]) {
        mode = failure; const before = writes;
        await assert.rejects(action(), (error: any) => error.delivery === (["unknown", "drop"].includes(mode) ? "unknown" : "not_sent"));
        if (mode === "old" || mode === "read-only") assert.equal(writes, before);
      }
    }
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
