import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFileSync, statSync, writeFileSync } from "node:fs";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function option(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && (!value || value.startsWith("--"))) throw new Error(`${name} is required`);
  return value;
}

function versionOption() {
  const version = option("--version");
  if (!VERSION_PATTERN.test(version)) throw new Error("--version must use x.y.z");
  return version;
}

function privateKey() {
  const keyFile = option("--key-file", false) || process.env.AGENT_POCKET_HOST_UPDATE_SIGNING_KEY_FILE;
  const keyText = process.env.AGENT_POCKET_HOST_UPDATE_SIGNING_KEY || (keyFile ? readFileSync(resolve(keyFile), "utf8") : undefined);
  if (!keyText) throw new Error("Set AGENT_POCKET_HOST_UPDATE_SIGNING_KEY or provide --key-file");
  const key = createPrivateKey(keyText);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The Host update signing key must be Ed25519");
  return key;
}

function statement(version, filename, sha256, size) {
  const expected = `AgentPocketHost-${version}-windows-x64.exe`;
  if (basename(filename) !== filename || filename !== expected) throw new Error(`Installer name must be ${expected}`);
  return JSON.stringify(["agent-pocket-host-update-v1", version, filename, sha256, size]);
}

const command = process.argv[2];
const key = privateKey();
const publicKey = createPublicKey(key);
const publicKeySpki = publicKey.export({ format: "der", type: "spki" }).toString("base64");

if (command === "policy") {
  const version = versionOption();
  const apiUrl = new URL(option("--api-url"));
  if (apiUrl.protocol !== "https:" || apiUrl.username || apiUrl.password || apiUrl.hash) throw new Error("--api-url must be a credential-free HTTPS URL");
  const output = resolve(option("--output"));
  const policy = {
    schemaVersion: 1,
    currentVersion: version,
    apiUrl: apiUrl.href,
    publicKeySpki,
    maxInstallerBytes: 512 * 1024 * 1024,
  };
  writeFileSync(output, `${JSON.stringify(policy, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, currentVersion: version, publicKeySpki })}\n`);
} else if (command === "sign") {
  const version = versionOption();
  const file = resolve(option("--file"));
  const filename = basename(file);
  const size = statSync(file).size;
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  const declaration = statement(version, filename, sha256, size);
  const signature = sign(null, Buffer.from(declaration, "utf8"), key);
  if (!verify(null, Buffer.from(declaration, "utf8"), publicKey, signature)) throw new Error("Signing self-check failed");
  writeFileSync(`${file}.sha256`, `${sha256}  ${filename}\n`, "ascii");
  writeFileSync(`${file}.sig`, `${signature.toString("base64")}\n`, "ascii");
  process.stdout.write(`${JSON.stringify({ file, version, sha256, size, signatureFile: `${file}.sig`, publicKeySpki })}\n`);
} else {
  throw new Error("Usage: sign-host-update.mjs <policy|sign> [options]");
}
