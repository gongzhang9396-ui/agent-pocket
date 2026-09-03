import { resolve } from "node:path";
import { RelayError } from "./protocol.js";

export type RelayConfig = {
  bindHost: string;
  port: number;
  dbPath: string;
  publicUrl: string;
  adminDir: string;
  updatesDir: string;
  updatePublicKeySpki?: string;
  firebaseServiceAccount?: string;
};

function port(value: string | undefined) {
  const parsed = Number(value ?? 8790);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new RelayError("CONFIG_INVALID", "RELAY_PORT 必须是有效端口");
  }
  return parsed;
}

export function loadConfig(env = process.env, cwd = process.cwd()): RelayConfig {
  const publicUrl = (env.AGENT_POCKET_RELAY_URL || "http://127.0.0.1:8790").replace(/\/$/, "");
  const parsedUrl = new URL(publicUrl);
  const local = parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost";
  if (parsedUrl.protocol !== "https:" && !(local && parsedUrl.protocol === "http:")) {
    throw new RelayError("CONFIG_INVALID", "Relay 公网地址必须使用 HTTPS");
  }
  const bindHost = env.AGENT_POCKET_RELAY_BIND || "127.0.0.1";
  if (bindHost !== "127.0.0.1" && bindHost !== "::1") {
    throw new RelayError("CONFIG_INVALID", "Relay 只能监听 loopback 地址");
  }
  return {
    bindHost,
    port: port(env.AGENT_POCKET_RELAY_PORT),
    dbPath: resolve(cwd, env.AGENT_POCKET_RELAY_DB || "data/relay.db"),
    publicUrl,
    adminDir: resolve(cwd, env.AGENT_POCKET_RELAY_ADMIN_DIR || "admin/dist"),
    updatesDir: resolve(cwd, env.AGENT_POCKET_RELAY_UPDATES_DIR || "data/updates"),
    updatePublicKeySpki: env.AGENT_POCKET_UPDATE_PUBLIC_KEY_SPKI?.trim() || undefined,
    firebaseServiceAccount: env.AGENT_POCKET_FIREBASE_SERVICE_ACCOUNT
      ? resolve(cwd, env.AGENT_POCKET_FIREBASE_SERVICE_ACCOUNT)
      : undefined,
  };
}
