import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { hostUpdateStatement } from "../src/host-updater.ts";

test("release signer emits a policy and matching detached Ed25519 signature", () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-signer-"));
  const keyFile = join(base, "update-private.pem");
  const policyFile = join(base, "update-policy.json");
  const installer = join(base, "AgentPocketHost-0.3.0-windows-x64.exe");
  const signer = resolve("..", "installer", "windows", "scripts", "sign-host-update.mjs");
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }));
  writeFileSync(installer, "installer fixture");

  const policyRun = spawnSync(process.execPath, [
    signer, "policy", "--version", "0.3.0", "--api-url", "https://api.example.test/releases/latest",
    "--output", policyFile, "--key-file", keyFile,
  ], { encoding: "utf8" });
  assert.equal(policyRun.status, 0, policyRun.stderr);

  const signRun = spawnSync(process.execPath, [
    signer, "sign", "--version", "0.3.0", "--file", installer, "--key-file", keyFile,
  ], { encoding: "utf8" });
  assert.equal(signRun.status, 0, signRun.stderr);

  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.currentVersion, "0.3.0");
  const sha256 = createHash("sha256").update(readFileSync(installer)).digest("hex");
  assert.equal(readFileSync(`${installer}.sha256`, "ascii"), `${sha256}  AgentPocketHost-0.3.0-windows-x64.exe\n`);
  const signature = Buffer.from(readFileSync(`${installer}.sig`, "ascii").trim(), "base64");
  const publicKey = createPublicKey({ key: Buffer.from(policy.publicKeySpki, "base64"), format: "der", type: "spki" });
  const statement = hostUpdateStatement("0.3.0", "AgentPocketHost-0.3.0-windows-x64.exe", sha256, readFileSync(installer).length);
  assert.equal(verify(null, Buffer.from(statement), publicKey, signature), true);
});
