import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkForHostUpdate, hostUpdateStatement } from "../src/host-updater.ts";

function response(value: string | Buffer, url: string) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const result = new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

function fixture(options: { corruptInstaller?: boolean; corruptSignature?: boolean; insecureInstaller?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-updater-"));
  const policyPath = join(base, "update-policy.json");
  const outputDir = join(base, "updates");
  const currentVersion = "0.2.0";
  const version = "0.3.0";
  const filename = `AgentPocketHost-${version}-windows-x64.exe`;
  const installer = Buffer.from("signed host installer fixture", "utf8");
  const deliveredInstaller = options.corruptInstaller ? Buffer.from("tampered host installer", "utf8") : installer;
  const sha256 = createHash("sha256").update(installer).digest("hex");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeySpki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const statement = hostUpdateStatement(version, filename, sha256, installer.length);
  const signature = sign(null, Buffer.from(statement), privateKey);
  if (options.corruptSignature) signature[0] ^= 0xff;
  const apiUrl = "https://api.example.test/releases/latest";
  const installerUrl = options.insecureInstaller ? "http://downloads.example.test/host.exe" : "https://downloads.example.test/host.exe";
  const checksumUrl = "https://downloads.example.test/host.exe.sha256";
  const signatureUrl = "https://downloads.example.test/host.exe.sig";
  const release = {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: filename, browser_download_url: installerUrl, size: installer.length },
      { name: `${filename}.sha256`, browser_download_url: checksumUrl, size: 100 },
      { name: `${filename}.sig`, browser_download_url: signatureUrl, size: 100 },
    ],
  };
  writeFileSync(policyPath, JSON.stringify({ schemaVersion: 1, currentVersion, apiUrl, publicKeySpki }));
  const values = new Map<string, string | Buffer>([
    [apiUrl, JSON.stringify(release)],
    [checksumUrl, `${sha256}  ${filename}\n`],
    [signatureUrl, `${signature.toString("base64")}\n`],
    [installerUrl, deliveredInstaller],
  ]);
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const value = values.get(url);
    if (value === undefined) return new Response("missing", { status: 404 });
    return response(value, url);
  };
  return { base, policyPath, outputDir, currentVersion, version, filename, installer, sha256, calls, fetchImpl };
}

test("downloads a Host update only after Ed25519 and SHA-256 verification", async () => {
  const value = fixture();
  const result = await checkForHostUpdate(value);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.version, value.version);
  assert.equal(result.sha256, value.sha256);
  assert.deepEqual(readFileSync(result.file), value.installer);
  assert.equal(existsSync(`${result.file}.part`), false);
  assert.equal(value.calls.length, 4);

  const reused = await checkForHostUpdate(value);
  assert.equal(reused.status, "ready");
  assert.equal(value.calls.filter((url) => url.endsWith("host.exe")).length, 1);
});

test("rejects a bad update signature before downloading the installer", async () => {
  const value = fixture({ corruptSignature: true });
  await assert.rejects(checkForHostUpdate(value), /签名验证失败/);
  assert.equal(value.calls.some((url) => url.endsWith("host.exe")), false);
  assert.equal(existsSync(join(value.outputDir, `${value.filename}.part`)), false);
});

test("removes partial files when the installer does not match the signed checksum", async () => {
  const value = fixture({ corruptInstaller: true });
  await assert.rejects(checkForHostUpdate(value), /完整性校验失败/);
  assert.equal(existsSync(join(value.outputDir, value.filename)), false);
  assert.equal(existsSync(join(value.outputDir, `${value.filename}.part`)), false);
});

test("rejects insecure asset URLs and ignores releases that are not newer", async () => {
  const insecure = fixture({ insecureInstaller: true });
  await assert.rejects(checkForHostUpdate(insecure), /HTTPS URL/);

  const current = fixture();
  const policy = JSON.parse(readFileSync(current.policyPath, "utf8"));
  policy.currentVersion = current.version;
  writeFileSync(current.policyPath, JSON.stringify(policy));
  const result = await checkForHostUpdate(current);
  assert.deepEqual(result, { status: "up-to-date", currentVersion: current.version, latestVersion: current.version });
  assert.equal(current.calls.length, 1);
});

test("treats a repository with no releases as having no compatible update", async () => {
  const value = fixture();
  const result = await checkForHostUpdate({
    policyPath: value.policyPath,
    outputDir: value.outputDir,
    fetchImpl: async () => new Response("missing", { status: 404 }),
  });
  assert.deepEqual(result, { status: "no-compatible-release", currentVersion: value.currentVersion });
});
