import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile, symlink, mkdir, utimes, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { BridgeServer } from "../src/server.ts";
import { BridgeStore } from "../src/store.ts";
import { AttachmentTransfers, UPLOAD_CHUNK, UPLOAD_FILE_MAX } from "../src/attachment-transfers.ts";

function input(bytes: Buffer, extra = {}) { return { operationId: "send-1", slot: "file-1", filename: "example.txt", mimeType: "text/plain", size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"), token: randomBytes(32).toString("base64url"), ...extra }; }
async function fixture(fn: (root: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "pocket-v2-"));
  try { await fn(join(base, "uploads")); } finally { await rm(base, { recursive: true, force: true }); }
}
test("upload resumes across Host restart; duplicate chunks are checked; task/device/operation binding is enforced", () => fixture(async root => {
  let service = new AttachmentTransfers(root);
  const bytes = randomBytes(UPLOAD_CHUNK + 11), params = input(bytes), target = { cwd: "project", threadId: "chat-a" };
  const first = await service.begin("phone-a", params, target), ref = { id: first.id, token: params.token };
  assert.equal((await service.begin("phone-a", params, target)).id, first.id);
  const block = { ...ref, offset: 0, data: bytes.subarray(0, UPLOAD_CHUNK).toString("base64") };
  await service.write("phone-a", block);
  service = new AttachmentTransfers(root);
  assert.equal((await service.status("phone-a", ref)).offset, UPLOAD_CHUNK);
  await service.write("phone-a", block);
  await assert.rejects(service.write("phone-a", { ...block, data: Buffer.alloc(UPLOAD_CHUNK).toString("base64") }));
  await assert.rejects(service.status("phone-b", ref));
  await assert.rejects(service.status("phone-a", { ...ref, token: "bad" }));
  await service.write("phone-a", { ...ref, offset: UPLOAD_CHUNK, data: bytes.subarray(UPLOAD_CHUNK).toString("base64") });
  await service.finish("phone-a", ref);
  await assert.rejects(service.claim("phone-a", [ref], "other-send", target));
  await assert.rejects(service.claim("phone-a", [ref], params.operationId, { ...target, threadId: "chat-b" }));
  const result = await service.claim("phone-a", [ref], params.operationId, target);
  assert.deepEqual(await readFile(result[0].path), bytes);
  await assert.rejects(service.abort("phone-a", ref));
  await assert.rejects(service.claim("phone-a", [ref], params.operationId, target));
}));
test("20 MiB exact limit, 3 files, quota reservations, cancellation and hash mismatch", () => fixture(async root => {
  const bytes = Buffer.alloc(UPLOAD_FILE_MAX, 97), params = input(bytes);
  const service = new AttachmentTransfers(root, { deviceQuota: UPLOAD_FILE_MAX * 3, globalQuota: UPLOAD_FILE_MAX * 3 });
  const first = await service.begin("phone", params, { cwd: "project" }); const ref = { id: first.id, token: params.token };
  await assert.rejects(service.begin("phone", { ...params, slot: "over", size: UPLOAD_FILE_MAX + 1 }, { cwd: "project" }));
  for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK) {
    await service.write("phone", { ...ref, offset, data: bytes.subarray(offset, offset + UPLOAD_CHUNK).toString("base64") });
  }
  assert.equal((await service.finish("phone", ref)).ready, true);
  for (const slot of ["file-2", "file-3"]) await service.begin("phone", { ...params, slot }, { cwd: "project" });
  await assert.rejects(service.begin("phone", { ...params, slot: "file-4" }, { cwd: "project" }));
  await assert.rejects(service.begin("other", { ...params, operationId: "other-op" }, { cwd: "project" }));
  await service.abort("phone", ref); await assert.rejects(service.status("phone", ref));
  const bad = input(Buffer.from("abc"), { operationId: "bad", sha256: "0".repeat(64) });
  const begun = await service.begin("phone", bad, { cwd: "project" }), badRef = { id: begun.id, token: bad.token };
  await service.write("phone", { ...badRef, offset: 0, data: "YWJj" }); await assert.rejects(service.finish("phone", badRef));
}));
test("cleanup retains active and unknown task references; unfinished uploads expire; files cannot be replaced by links", () => fixture(async root => {
  let now = 1000, state: "active" | "ended" | "unknown" = "active";
  const service = new AttachmentTransfers(root, { now: () => now, taskState: async () => state, operationState: () => "succeeded" });
  const params = input(Buffer.from("abc")), target = { cwd: "project", threadId: "chat" };
  const item = await service.begin("phone", params, target), ref = { id: item.id, token: params.token };
  await service.write("phone", { ...ref, offset: 0, data: "YWJj" }); await service.finish("phone", ref);
  const [file] = await service.claim("phone", [ref], params.operationId, target);
  now += 2 * 60 * 60 * 1000; await service.cleanup(); assert.equal((await service.status("phone", ref)).committed, true);
  state = "unknown"; now += 2 * 60 * 60 * 1000; await service.cleanup();
  state = "ended"; now += 30 * 60 * 1000; await service.cleanup(); await service.status("phone", ref);
  now += 31 * 60 * 1000; await service.cleanup(); await assert.rejects(service.status("phone", ref));
  const pending = input(Buffer.from("pending"), { operationId: "pending" });
  const upload = await service.begin("phone", pending, { cwd: "project" });
  now += 2 * 60 * 60 * 1000; await service.cleanup(); await assert.rejects(service.status("phone", { id: upload.id, token: pending.token }));
  // Separate root protects against destructive adoption of arbitrary data.
  await writeFile(join(root, "unrelated.txt"), "keep"); assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "keep");
  assert.ok(file.path.startsWith(root));
}));
test("failed sends to existing active tasks release claimed quota after one hour, unknown sends retain it", () => fixture(async root => {
  let now = 1000, operation: "failed" | "unknown" = "unknown";
  const service = new AttachmentTransfers(root, { now: () => now, taskState: async () => "active", operationState: () => operation, deviceQuota: 3 });
  const params = input(Buffer.from("abc")), target = { cwd: "project", threadId: "long-lived" };
  const item = await service.begin("phone", params, target), ref = { id: item.id, token: params.token };
  await service.write("phone", { ...ref, offset: 0, data: "YWJj" }); await service.finish("phone", ref);
  await service.claim("phone", [ref], params.operationId, target);
  now += 2 * 60 * 60_000; await service.cleanup(); await service.status("phone", ref);
  await assert.rejects(service.begin("phone", input(Buffer.from("a"), { operationId: "later" }), target), /额度已满/);
  operation = "failed"; await service.cleanup();
  await assert.rejects(service.status("phone", ref));
  assert.equal((await service.begin("phone", input(Buffer.from("abc"), { operationId: "later" }), target)).size, 3);
}));
test("interrupted first commit and orphan cleanup cannot poison healthy uploads", () => fixture(async root => {
  const service = new AttachmentTransfers(root), params = input(Buffer.from("abc"));
  const item = await service.begin("phone", params, { cwd: "project" });
  const ref = { id: item.id, token: params.token };
  await unlink(join(root, item.id, "content.txt"));
  assert.equal((await service.status("phone", ref)).offset, 0);
  const orphan = join(root, "11111111-1111-4111-8111-111111111111"); await mkdir(orphan); await writeFile(join(orphan, "content.txt"), "partial");
  const past = new Date(Date.now() - 2 * 60 * 60_000); await utimes(orphan, past, past);
  await service.cleanup(); await assert.rejects(readFile(join(orphan, "content.txt")));
  await service.write("phone", { ...ref, offset: 0, data: "YWJj" }); await service.finish("phone", ref);
  const link = join(root, item.id, "content.txt"); await unlink(link); await symlink(join(root, ".agent-pocket-uploads-v2"), link, "file");
  await assert.rejects(service.finish("phone", ref));
}));
test("Bridge dispatch consumes v2 uploads once, binds a created task and preserves its receipt", () => fixture(async root => {
  const store = new BridgeStore(join(root, "bridge.db"));
  class Codex extends EventEmitter {
    activeTurns = new Map<string, string>(); readOnly = false; calls: any[] = [];
    assertWritable() {} markTurn(thread: string, turn: string) { this.activeTurns.set(thread, turn); }
    async request(method: string, params: any) { this.calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "created", cwd: root } };
      if (method === "turn/start") return { turn: { id: "turn" } }; return {}; }
  }
  const codex = new Codex(), server = new BridgeServer({ dbPath: join(root, "bridge.db"), projectRoots: [root], codexHome: root } as any, store, codex as any, {} as any);
  try {
    const bytes = Buffer.from("file data"), params = input(bytes), target = { cwd: root };
    const item = await server.dispatchRelay("phone", "attachment/begin", { ...params, ...target });
    const ref = { id: item.id, token: params.token };
    await server.dispatchRelay("phone", "attachment/write", { ...ref, offset: 0, data: bytes.toString("base64") });
    await server.dispatchRelay("phone", "attachment/finish", ref);
    const send = { cwd: root, text: "inspect", operationId: params.operationId, attachmentIds: [ref] };
    const result = await server.dispatchRelay("phone", "thread/start", send);
    const repeated = await server.dispatchRelay("phone", "thread/start", send);
    assert.equal(result.thread.id, "created"); assert.equal(repeated.thread.id, "created");
    assert.equal(codex.calls.filter(call => call.method === "thread/start").length, 1);
    const attachedInput = codex.calls.find(call => call.method === "turn/start").params.input;
    assert.ok(attachedInput.some((item: any) => item.text?.includes("file data") === false && item.text?.includes("Host 临时路径")));
    assert.equal((await server.dispatchRelay("phone", "operation/get", { operationId: params.operationId })).status, "succeeded");
    const manifest = JSON.parse(await readFile(join(`${root}/attachments-v2`, ref.id, "manifest.json"), "utf8"));
    assert.equal(manifest.threadId, "created");
    await assert.rejects(server.dispatchRelay("other", "attachment/status", ref));
  } finally { await server.stop(); store.close(); }
}));
