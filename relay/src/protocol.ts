import { createHash, randomBytes, randomUUID } from "node:crypto";

export const RELAY_PROTOCOL_VERSION = 2;
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const ENROLLMENT_TTL_MS = 5 * 60 * 1000;
export const EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const EVENT_MAX_ROWS_PER_HOST = 20_000;
export const MAX_CIPHERTEXT_CHARS = 2 * 1024 * 1024;
export const MAX_PUBLIC_KEY_CHARS = 512;
export const MAX_KEY_PACKAGE_CHARS = 64 * 1024;

export type AccountRole = "admin" | "user";
export type PrincipalKind = "device" | "host" | "web";

export type CipherEnvelope = {
  accountId: string;
  hostId: string;
  deviceId: string;
  channelId: string;
  counter: number;
  kind: "channel.open" | "channel.data" | "channel.close" | "snapshot.put" | "event.append";
  ciphertext: string;
  eventId?: string;
  eventType?: "attention" | "completed" | "status";
};

const ENVELOPE_KINDS = new Set<CipherEnvelope["kind"]>([
  "channel.open",
  "channel.data",
  "channel.close",
  "snapshot.put",
  "event.append",
]);

const EVENT_TYPES = new Set<NonNullable<CipherEnvelope["eventType"]>>([
  "attention",
  "completed",
  "status",
]);

export class RelayError extends Error {
  constructor(public nameCode: string, message: string, public data?: unknown) {
    super(message);
  }
}

export function token(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function tokenHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function id() {
  return randomUUID();
}

export function normalizeUsername(value: unknown) {
  if (typeof value !== "string") throw new RelayError("INVALID_REQUEST", "用户名格式无效");
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new RelayError("INVALID_REQUEST", "用户名必须为 3 到 32 位字母、数字、点、下划线或短横线");
  }
  return username;
}

export function requiredString(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new RelayError("INVALID_REQUEST", `${name} 格式或长度无效`);
  }
  return value.trim();
}

export function validatePublicKey(value: unknown, name: string) {
  const key = requiredString(value, name, MAX_PUBLIC_KEY_CHARS);
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new RelayError("INVALID_REQUEST", `${name} 不是 base64url`);
  return key;
}

export function validateEnvelope(value: unknown): CipherEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayError("INVALID_REQUEST", "加密信封格式无效");
  }
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (!ENVELOPE_KINDS.has(kind as CipherEnvelope["kind"])) {
    throw new RelayError("INVALID_REQUEST", "加密信封类型无效");
  }
  if (!Number.isSafeInteger(raw.counter) || Number(raw.counter) < 0) {
    throw new RelayError("INVALID_REQUEST", "加密信封 counter 无效");
  }
  const ciphertext = requiredString(raw.ciphertext, "ciphertext", MAX_CIPHERTEXT_CHARS);
  const eventId = raw.eventId === undefined ? undefined : requiredString(raw.eventId, "eventId", 64);
  const eventType = raw.eventType === undefined ? undefined : String(raw.eventType);
  if (eventType !== undefined && !EVENT_TYPES.has(eventType as NonNullable<CipherEnvelope["eventType"]>)) {
    throw new RelayError("INVALID_REQUEST", "事件类型无效");
  }
  if (kind === "event.append" && (!eventId || !eventType)) {
    throw new RelayError("INVALID_REQUEST", "事件信封缺少 eventId 或 eventType");
  }
  if (kind !== "event.append" && (eventId !== undefined || eventType !== undefined)) {
    throw new RelayError("INVALID_REQUEST", "非事件信封不能携带事件字段");
  }
  return {
    accountId: requiredString(raw.accountId, "accountId", 64),
    hostId: requiredString(raw.hostId, "hostId", 64),
    deviceId: requiredString(raw.deviceId, "deviceId", 64),
    channelId: requiredString(raw.channelId, "channelId", 128),
    counter: Number(raw.counter),
    kind: kind as CipherEnvelope["kind"],
    ciphertext,
    eventId,
    eventType: eventType as CipherEnvelope["eventType"],
  };
}
