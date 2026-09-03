import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { loadConfig } from "./config.js";
import { RelayStore, type UpdatePlatform } from "./store.js";

function option(name: string) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const config = loadConfig();
if (!config.updatePublicKeySpki) throw new Error("AGENT_POCKET_UPDATE_PUBLIC_KEY_SPKI is required");
const manifestJson = readFileSync(resolve(option("--manifest")), "utf8").trim();
const manifestSignature = readFileSync(resolve(option("--signature")), "ascii").trim();
const manifest = JSON.parse(manifestJson) as any;
if (manifest?.schemaVersion !== 1 || !["android", "host"].includes(manifest?.platform)) throw new Error("Invalid update manifest");
const platform = manifest.platform as UpdatePlatform;
const version = String(manifest.version || "");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid update version");
const assetName = String(manifest.asset?.name || "");
const expectedName = platform === "android" ? `Agent-Pocket-${version}-release.apk` : `AgentPocketHost-${version}-windows-x64.exe`;
if (basename(assetName) !== assetName || assetName !== expectedName) throw new Error("Invalid update asset name");
const assetSize = Number(manifest.asset?.size);
const maxBytes = platform === "android" ? 250 * 1024 * 1024 : 512 * 1024 * 1024;
const assetSha256 = String(manifest.asset?.sha256 || "").toLowerCase();
if (!Number.isSafeInteger(assetSize) || assetSize <= 0 || assetSize > maxBytes || !/^[0-9a-f]{64}$/.test(assetSha256)) {
  throw new Error("Invalid update asset metadata");
}
const publicKey = createPublicKey({ key: Buffer.from(config.updatePublicKeySpki, "base64"), format: "der", type: "spki" });
const signature = Buffer.from(manifestSignature, "base64");
if (publicKey.asymmetricKeyType !== "ed25519" || signature.length !== 64
  || !verify(null, Buffer.from(manifestJson, "utf8"), publicKey, signature)) throw new Error("Update manifest signature verification failed");

const relativeAsset = `${platform}/${version}/${assetName}`;
const updateRoot = resolve(config.updatesDir);
const assetPath = resolve(updateRoot, relativeAsset);
if (!assetPath.startsWith(`${updateRoot}${sep}`) || !existsSync(assetPath) || !statSync(assetPath).isFile()) throw new Error("Update asset is missing");
if (statSync(assetPath).size !== assetSize || await sha256File(assetPath) !== assetSha256) throw new Error("Update asset does not match manifest");

const store = new RelayStore(config.dbPath);
try {
  store.publishUpdate({
    platform,
    version,
    versionCode: manifest.versionCode === undefined ? undefined : Number(manifest.versionCode),
    manifestJson,
    manifestSignature,
    assetName,
    assetPath: relativeAsset,
    assetSize,
    assetSha256,
    assetSignature: manifest.asset?.signature,
    createdBy: "release-cli",
  });
  process.stdout.write(`${JSON.stringify({ published: true, platform, version, asset: assetName })}\n`);
} finally {
  store.close();
}
