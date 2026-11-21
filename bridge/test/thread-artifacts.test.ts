import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadArtifacts, artifactLinks, ARTIFACT_CHUNK_BYTES } from "../src/thread-artifacts.ts";

function history(cwd: string, text: string, id = "chat-a") { return { id, cwd, turns: [{ id: "t", items: [{ id: "m", type: "agentMessage", text }] }] }; }
test("artifact references require assistant links; chunks bind device, chat and unchanged regular files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pocket-artifacts-"));
  try {
    const file = join(dir, "report.txt"); const bytes = Buffer.alloc(ARTIFACT_CHUNK_BYTES + 9, 65); await writeFile(file, bytes);
    const service = new ThreadArtifacts(); const thread = history(dir, "[report](report.txt)");
    const list = await service.list("device-a", thread, [dir], join(dir, "codex")); const item = list.data[0];
    assert.equal(item.size, bytes.length); assert.ok(item.id); assert.equal(item.messageId, "t:m");
    const first = await service.read("device-a", thread.id, item.id, 0, [dir]);
    assert.equal(Buffer.from(first.data, "base64").length, ARTIFACT_CHUNK_BYTES); assert.equal(first.done, false);
    const last = await service.read("device-a", thread.id, item.id, first.nextOffset, [dir]); assert.equal(last.done, true); assert.equal(last.nextOffset, bytes.length);
    await assert.rejects(service.read("device-b", thread.id, item.id, 0, [dir]));
    await assert.rejects(service.read("device-a", "chat-b", item.id, 0, [dir]));
    await assert.rejects(service.read("device-a", thread.id, item.id, -1, [dir]));
    await writeFile(file, "changed"); await assert.rejects(service.read("device-a", thread.id, item.id, 0, [dir]));
    const userOnly = history(dir, ""); userOnly.turns[0].items = [{ id: "x", type: "userMessage", text: "[secret](report.txt)" }];
    assert.deepEqual(artifactLinks(userOnly), []);
    assert.equal(artifactLinks(history(dir, "[x](https://x/a.txt) ![y](data:image/png;base64,abc) [z](file:///secret.txt)")).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("artifact traversal, hidden files, links, hardlinks, oversized files and generated-image cross-chat paths are denied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pocket-artifacts-"));
  try {
    const project = join(dir, "project"), codex = join(dir, "codex"); await mkdir(project); await mkdir(join(codex, "generated_images", "chat-a"), { recursive: true }); await mkdir(join(codex, "generated_images", "chat-b"), { recursive: true });
    await writeFile(join(dir, "secret.txt"), "outside"); await writeFile(join(project, ".env.txt"), "hidden"); await writeFile(join(project, "ok.txt"), "ok");
    await symlink(dir, join(project, "escape"), process.platform === "win32" ? "junction" : "dir");
    await link(join(dir, "secret.txt"), join(project, "hardlink.txt"));
    await writeFile(join(project, "huge.txt"), Buffer.alloc(32 * 1024 * 1024 + 1));
    await writeFile(join(codex, "generated_images", "chat-a", "image.png"), "png"); await writeFile(join(codex, "generated_images", "chat-b", "image.png"), "png");
    const service = new ThreadArtifacts(); const urls = ["../secret.txt", ".env.txt", "escape/secret.txt", "hardlink.txt", "huge.txt", join(codex, "generated_images", "chat-b", "image.png"), join(codex, "generated_images", "chat-a", "image.png"), "ok.txt"];
    const list = await service.list("a", history(project, urls.map(url => `[x](<${url}>)`).join("\n")), [project], codex);
    assert.equal(list.data.length, 8); assert.ok(list.data.slice(0, 6).every(item => !item.id && item.unavailable)); assert.ok(list.data.slice(6).every(item => item.id && !item.unavailable));
    await assert.rejects(service.list("a", history(dir, "[x](secret.txt)"), [project], codex));
    await assert.rejects(service.read("a", "chat-a", list.data[7].id, 0, [join(codex, "generated_images", "chat-b")]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
