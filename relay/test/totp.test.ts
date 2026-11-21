import assert from "node:assert/strict";
import test from "node:test";
import { createRecoveryCodes, otpauthUri, totpCode, verifyTotp } from "../src/totp.js";

test("TOTP matches RFC 6238 SHA-1 vector", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpCode(secret, Math.floor(59 / 30)), "287082");
  assert.equal(totpCode(secret, Math.floor(1111111100 / 30)), "081804");
  assert.match(otpauthUri("Agent Pocket", "alice", secret), /^otpauth:\/\/totp\//);
});

test("TOTP rejects a replayed time step and recovery codes are one-time hashes", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const step = Math.floor(Date.now() / 1000 / 30);
  const code = totpCode(secret, step);
  const accepted = verifyTotp(secret, code, -1);
  assert.equal(accepted, step);
  assert.equal(verifyTotp(secret, code, step), undefined);
  const recovery = createRecoveryCodes();
  assert.equal(recovery.codes.length, 10);
  assert.equal(new Set(recovery.codes).size, 10);
  assert.equal(recovery.hashes[0].length, 64);
});
