import assert from "node:assert/strict";
import test from "node:test";
import { normalizePublicUrl, startCodexForHost } from "../src/cli.ts";
import { CodexThreadPool } from "../src/codex-pool.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
