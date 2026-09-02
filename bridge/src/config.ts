import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { RpcError, ErrorName } from "./protocol.ts";

export type BridgeConfig = {
  bindHost: string;
  port: number;
  dbPath: string;
  attachmentsPath?: string;
  codexHome: string;
  codexCommand: string;
  minCodexVersion: string;
  projectRoots: string[];
  firebaseServiceAccount?: string;
  hostName: string;
  publicUrl?: string;
  relayUrl?: string;
  relayIdentityPath: string;
  runtimeStatusPath?: string;
  maintenancePath?: string;
};

export function loadConfig(
  env = process.env,
  options: { requireProjectRoots?: boolean } = {},
): BridgeConfig {
  const local = env.LOCALAPPDATA || tmpdir();
  const configuredRoots = env.AGENT_POCKET_PROJECT_ROOTS;
  const requireProjectRoots = options.requireProjectRoots !== false;
  if (requireProjectRoots && !configuredRoots?.trim()) {
    throw new Error("缺少 AGENT_POCKET_PROJECT_ROOTS；请显式配置允许访问的项目根目录");
  }
  const roots = (configuredRoots || "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value));
  if (requireProjectRoots && roots.length === 0) {
    throw new Error("AGENT_POCKET_PROJECT_ROOTS 至少需要包含一个项目根目录");
  }
  const dbPath = resolve(env.AGENT_POCKET_DB || join(local, "AgentPocket", "bridge.db"));
  const attachmentsPath = resolve(
    env.AGENT_POCKET_ATTACHMENTS_DIR?.trim() || join(dirname(dbPath), "attachments"),
  );
  return {
    bindHost: "127.0.0.1",
    port: Number(env.AGENT_POCKET_PORT || 8787),
    dbPath,
    attachmentsPath,
    codexHome: resolve(env.CODEX_HOME || join(homedir(), ".codex")),
    codexCommand: env.AGENT_POCKET_CODEX || "codex",
    minCodexVersion: env.AGENT_POCKET_MIN_CODEX || "0.150.0-alpha.8",
    projectRoots: roots,
    firebaseServiceAccount: env.AGENT_POCKET_FIREBASE_SERVICE_ACCOUNT,
    hostName: env.AGENT_POCKET_HOST_NAME || hostname(),
    publicUrl: env.AGENT_POCKET_WSS_URL,
    relayUrl: env.AGENT_POCKET_RELAY_URL,
    relayIdentityPath: resolve(env.AGENT_POCKET_RELAY_IDENTITY || join(local, "AgentPocket", "relay-host.json")),
    runtimeStatusPath: resolve(env.AGENT_POCKET_RUNTIME_STATUS || join(local, "AgentPocket", "host-runtime.json")),
    maintenancePath: resolve(env.AGENT_POCKET_MAINTENANCE || join(local, "AgentPocket", "host-maintenance.json")),
  };
}

function canonicalExisting(path: string) {
  if (!existsSync(path)) throw new RpcError(ErrorName.PATH_DENIED, "路径不存在或无法访问");
  return realpathSync.native(path);
}

export function assertAllowedCwd(input: unknown, roots: string[]) {
  if (typeof input !== "string" || !input.trim()) {
    throw new RpcError(ErrorName.PATH_DENIED, "cwd 必须是绝对路径");
  }
  if (!isAbsolute(input)) throw new RpcError(ErrorName.PATH_DENIED, "cwd 必须是绝对路径");
  const cwd = canonicalExisting(resolve(input));
  const allowed = roots.some((root) => {
    const actualRoot = canonicalExisting(root);
    const rel = relative(actualRoot, cwd);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!allowed) throw new RpcError(ErrorName.PATH_DENIED, "路径不在项目白名单内");
  return cwd;
}

export function listProjects(roots: string[], maxDepth = 3) {
  const found = new Map<string, { id: string; name: string; cwd: string }>();
  const visit = (path: string, depth: number) => {
    if (depth > maxDepth || !existsSync(path)) return;
    let stat;
    try { stat = statSync(path); } catch { return; }
    if (!stat.isDirectory()) return;
    if (existsSync(join(path, ".git"))) {
      const cwd = realpathSync.native(path);
      found.set(cwd.toLowerCase(), { id: cwd, name: basename(cwd), cwd });
      return;
    }
    if (depth === maxDepth) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) visit(join(path, entry.name), depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export function compareVersions(actual: string, minimum: string) {
  const nums = (value: string) => (value.match(/\d+/g) || []).slice(0, 4).map(Number);
  const a = nums(actual);
  const b = nums(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
