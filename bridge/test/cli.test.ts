import assert from "node:assert/strict";
import test from "node:test";
import { normalizePublicUrl, startCodexForHost, webHostPairingUrl, writePairingPng, writeWebPairingLink } from "../src/cli.ts";
import { CodexThreadPool } from "../src/codex-pool.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";

test("normalizes a secure relay URL with a private path", () => {
  assert.equal(
    normalizePublicUrl("wss://agent.example.com/private-path"),
    "wss://agent.example.com/private-path",
  );
});

test("rejects insecure or ambiguous relay URLs", () => {
  for (const value of [
    undefined,
    "ws://agent.example.com/private-path",
    "wss://",
    "wss://user:password@agent.example.com/private-path",
    "wss://agent.example.com/private-path#fragment",
    "wss://agent.example.com.evil.test@evil.test/private-path",
  ]) {
    assert.throws(() => normalizePublicUrl(value));
  }
});

test("Host starts with Codex unavailable so a Grok-only installation remains usable", async () => {
  const codex = new CodexThreadPool({ command: join(tmpdir(), "ap-missing-codex-executable"), codexHome: tmpdir(), minVersion: "1" });
  const status = await startCodexForHost(codex);
  assert.equal(status.readOnly, true);
  assert.match(status.error!, /其他 Agent/);
  assert.equal(codex.child, undefined);
});

test("web pairing QR and link never overwrite the legacy App QR", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ap-pairing-fixture-")); const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = directory;
  try {
    const enrollment = { id: "12345678-1234-1234-1234-123456789abc", secret: "synthetic-pair-secret-123456789" };
    const app = `agentpocket://relay-host?enrollmentId=${enrollment.id}&secret=${enrollment.secret}`;
    const web = webHostPairingUrl("https://relay.example.test", enrollment);
    const appFile = await writePairingPng(app, enrollment.id, false); assert.ok(appFile); const before = readFileSync(appFile);
    const webFile = await writePairingPng(web, `${enrollment.id}-web`, false); assert.ok(webFile); assert.notEqual(appFile, webFile);
    assert.equal(existsSync(webFile), true); assert.deepEqual(readFileSync(appFile), before);
    assert.equal(readFileSync(writeWebPairingLink(web, enrollment.id), "utf8"), web);
    assert.equal(new URL(web).search, ""); assert.match(new URL(web).hash, /^#pair=/);
  } finally { if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous; rmSync(directory, { recursive: true, force: true }); }
});
