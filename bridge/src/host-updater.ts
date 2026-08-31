import { createHash, createPublicKey, verify } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { compareVersions } from "./config.ts";

const DEFAULT_MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_PROOF_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 30_000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type HostUpdatePolicy = {
  schemaVersion: 1;
  currentVersion: string;
  apiUrl: string;
  publicKeySpki: string;
  maxInstallerBytes?: number;
};

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type ReleasePayload = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type HostUpdateResult =
  | { status: "up-to-date"; currentVersion: string; latestVersion: string }
  | { status: "no-compatible-release"; currentVersion: string; latestVersion?: string }
  | { status: "ready"; currentVersion: string; version: string; file: string; sha256: string; size: number };

function strictVersion(value: unknown, name: string) {
  if (typeof value !== "string") throw new Error(`${name} 无效`);
  const version = value.trim().replace(/^v/, "");
  if (!VERSION_PATTERN.test(version)) throw new Error(`${name} 无效`);
  return version;
}

function httpsUrl(value: unknown, name: string) {
  if (typeof value !== "string") throw new Error(`${name} 无效`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} 必须是完整 HTTPS URL`); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${name} 必须是无凭据和片段的完整 HTTPS URL`);
  }
  return parsed;
}

function decodeBase64(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized || !BASE64_PATTERN.test(normalized) || normalized.length % 4 !== 0) throw new Error(`${name} 格式无效`);
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) throw new Error(`${name} 格式无效`);
  return decoded;
}

export function parseHostUpdatePolicy(value: unknown): HostUpdatePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Host 更新策略无效");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) throw new Error("Host 更新策略版本不兼容");
  const currentVersion = strictVersion(input.currentVersion, "当前 Host 版本");
  const apiUrl = httpsUrl(input.apiUrl, "更新 API").href;
  if (typeof input.publicKeySpki !== "string") throw new Error("更新公钥无效");
  const publicKeyBytes = decodeBase64(input.publicKeySpki, "更新公钥");
  const publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("更新公钥必须是 Ed25519");
  let maxInstallerBytes: number | undefined;
  if (input.maxInstallerBytes !== undefined) {
    if (!Number.isSafeInteger(input.maxInstallerBytes) || Number(input.maxInstallerBytes) < 1024 * 1024 || Number(input.maxInstallerBytes) > DEFAULT_MAX_INSTALLER_BYTES) {
      throw new Error("Host 安装包大小上限无效");
    }
    maxInstallerBytes = Number(input.maxInstallerBytes);
  }
  return { schemaVersion: 1, currentVersion, apiUrl, publicKeySpki: publicKeyBytes.toString("base64"), maxInstallerBytes };
}

export function hostUpdateStatement(version: string, filename: string, sha256: string, size: number) {
  const normalizedVersion = strictVersion(version, "更新版本");
  if (basename(filename) !== filename || filename !== `AgentPocketHost-${normalizedVersion}-windows-x64.exe`) {
    throw new Error("Host 安装包文件名无效");
  }
  const normalizedSha = sha256.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalizedSha)) throw new Error("Host 安装包 SHA-256 无效");
  if (!Number.isSafeInteger(size) || size <= 0 || size > DEFAULT_MAX_INSTALLER_BYTES) throw new Error("Host 安装包大小无效");
  return JSON.stringify(["agent-pocket-host-update-v1", normalizedVersion, filename, normalizedSha, size]);
}

function parseChecksum(value: string, filename: string) {
  const line = value.trim();
  const match = /^([0-9a-fA-F]{64})\s+\*?([^\r\n]+)$/.exec(line);
  if (!match || match[2] !== filename) throw new Error("Host 更新校验文件无效");
  return match[1].toLowerCase();
}

function parseAsset(value: unknown): ReleaseAsset | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const asset = value as Record<string, unknown>;
  if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string" || !Number.isSafeInteger(asset.size)) return undefined;
  return { name: asset.name, browser_download_url: asset.browser_download_url, size: Number(asset.size) };
}

async function responseBytes(response: Response, sourceUrl: URL, maxBytes: number) {
  if (!response.ok) throw new Error(`Host 更新下载失败 (${response.status})`);
  httpsUrl(response.url || sourceUrl.href, "更新响应 URL");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Host 更新响应超过大小限制");
  if (!response.body) throw new Error("Host 更新响应为空");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Host 更新响应超过大小限制");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function fetchBytes(fetchImpl: FetchLike, url: URL, maxBytes: number, accept: string) {
  const response = await fetchImpl(url, {
    headers: { Accept: accept, "User-Agent": "Agent-Pocket-Host-Updater" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return responseBytes(response, url, maxBytes);
}

async function fetchReleaseMetadata(fetchImpl: FetchLike, url: URL) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Agent-Pocket-Host-Updater" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return undefined;
  return responseBytes(response, url, MAX_METADATA_BYTES);
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function downloadInstaller(fetchImpl: FetchLike, url: URL, partPath: string, maxBytes: number) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/octet-stream", "User-Agent": "Agent-Pocket-Host-Updater" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Host 安装包下载失败 (${response.status})`);
  httpsUrl(response.url || url.href, "安装包响应 URL");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Host 安装包超过大小限制");
  if (!response.body) throw new Error("Host 安装包响应为空");

  rmSync(partPath, { force: true });
  const fd = openSync(partPath, "wx", 0o600);
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Host 安装包超过大小限制");
      }
      const bytes = Buffer.from(value);
      hash.update(bytes);
      writeSync(fd, bytes);
    }
  } finally {
    closeSync(fd);
  }
  return { size: total, sha256: hash.digest("hex") };
}

function findAsset(assets: ReleaseAsset[], name: string) {
  return assets.find((asset) => asset.name === name);
}

export async function checkForHostUpdate(options: {
  policyPath: string;
  outputDir: string;
  fetchImpl?: FetchLike;
}): Promise<HostUpdateResult> {
  const policy = parseHostUpdatePolicy(JSON.parse(readFileSync(resolve(options.policyPath), "utf8")));
  const fetchImpl = options.fetchImpl || fetch;
  const apiUrl = httpsUrl(policy.apiUrl, "更新 API");
  const metadataBytes = await fetchReleaseMetadata(fetchImpl, apiUrl);
  if (!metadataBytes) return { status: "no-compatible-release", currentVersion: policy.currentVersion };
  const metadata = JSON.parse(metadataBytes.toString("utf8")) as ReleasePayload;
  if (metadata.draft === true || metadata.prerelease === true) {
    return { status: "no-compatible-release", currentVersion: policy.currentVersion };
  }
  let latestVersion: string;
  try { latestVersion = strictVersion(metadata.tag_name, "GitHub Release 版本"); } catch {
    return { status: "no-compatible-release", currentVersion: policy.currentVersion };
  }
  if (compareVersions(latestVersion, policy.currentVersion) <= 0) {
    return { status: "up-to-date", currentVersion: policy.currentVersion, latestVersion };
  }

  const assets = Array.isArray(metadata.assets) ? metadata.assets.flatMap((asset) => parseAsset(asset) || []) : [];
  const filename = `AgentPocketHost-${latestVersion}-windows-x64.exe`;
  const installer = findAsset(assets, filename);
  const checksumAsset = findAsset(assets, `${filename}.sha256`);
  const signatureAsset = findAsset(assets, `${filename}.sig`);
  if (!installer || !checksumAsset || !signatureAsset) {
    return { status: "no-compatible-release", currentVersion: policy.currentVersion, latestVersion };
  }
  const maxInstallerBytes = policy.maxInstallerBytes || DEFAULT_MAX_INSTALLER_BYTES;
  if (!Number.isSafeInteger(installer.size) || installer.size <= 0 || installer.size > maxInstallerBytes) throw new Error("GitHub Release 中的 Host 安装包大小无效");
  const installerUrl = httpsUrl(installer.browser_download_url, "Host 安装包 URL");
  const checksumUrl = httpsUrl(checksumAsset.browser_download_url, "Host 校验文件 URL");
  const signatureUrl = httpsUrl(signatureAsset.browser_download_url, "Host 签名文件 URL");

  const [checksumBytes, signatureBytes] = await Promise.all([
    fetchBytes(fetchImpl, checksumUrl, MAX_PROOF_BYTES, "text/plain"),
    fetchBytes(fetchImpl, signatureUrl, MAX_PROOF_BYTES, "text/plain"),
  ]);
  const expectedSha256 = parseChecksum(checksumBytes.toString("utf8"), filename);
  const signature = decodeBase64(signatureBytes.toString("utf8"), "Host 更新签名");
  if (signature.length !== 64) throw new Error("Host 更新签名长度无效");
  const statement = hostUpdateStatement(latestVersion, filename, expectedSha256, installer.size);
  const publicKey = createPublicKey({ key: Buffer.from(policy.publicKeySpki, "base64"), format: "der", type: "spki" });
  if (!verify(null, Buffer.from(statement, "utf8"), publicKey, signature)) throw new Error("Host 更新签名验证失败");

  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const targetPath = join(outputDir, filename);
  const partPath = `${targetPath}.part`;
  try {
    if (existsSync(targetPath) && statSync(targetPath).size === installer.size && await sha256File(targetPath) === expectedSha256) {
      return { status: "ready", currentVersion: policy.currentVersion, version: latestVersion, file: targetPath, sha256: expectedSha256, size: installer.size };
    }
    rmSync(targetPath, { force: true });
    const downloaded = await downloadInstaller(fetchImpl, installerUrl, partPath, maxInstallerBytes);
    if (downloaded.size !== installer.size || downloaded.sha256 !== expectedSha256) throw new Error("Host 安装包完整性校验失败");
    renameSync(partPath, targetPath);
    return { status: "ready", currentVersion: policy.currentVersion, version: latestVersion, file: targetPath, sha256: expectedSha256, size: installer.size };
  } catch (error) {
    rmSync(partPath, { force: true });
    throw error;
  }
}
