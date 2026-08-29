import assert from "node:assert/strict";
import test from "node:test";
import { normalizePublicUrl } from "../src/cli.ts";

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
