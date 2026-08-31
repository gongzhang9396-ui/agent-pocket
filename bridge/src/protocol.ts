import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const MAX_COMMAND_BYTES = 256 * 1024;
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
export const EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const EVENT_MAX_ROWS = 20_000;

export const ErrorName = {
  AUTH_FAILED: "AUTH_FAILED",
  VERSION_UNSUPPORTED: "VERSION_UNSUPPORTED",
  PATH_DENIED: "PATH_DENIED",
  THREAD_BUSY: "THREAD_BUSY",
  THREAD_BUSY_EXTERNAL: "THREAD_BUSY_EXTERNAL",
  EVENT_GAP: "EVENT_GAP",
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  HOST_MAINTENANCE: "HOST_MAINTENANCE",
} as const;

const errorNumber: Record<string, number> = {
  AUTH_FAILED: -32001,
  VERSION_UNSUPPORTED: -32002,
  PATH_DENIED: -32003,
  THREAD_BUSY: -32004,
  THREAD_BUSY_EXTERNAL: -32005,
  EVENT_GAP: -32006,
  INVALID_REQUEST: -32602,
  NOT_FOUND: -32007,
  HOST_MAINTENANCE: -32008,
};

export class RpcError extends Error {
  nameCode: string;
  data: unknown;

  constructor(nameCode: string, message: string, data?: unknown) {
    super(message);
    this.nameCode = nameCode;
    this.data = data;
  }

  toJson() {
    return {
      code: errorNumber[this.nameCode] ?? -32603,
      message: this.message,
      data: { name: this.nameCode, detail: this.data },
    };
  }
}

export type BridgeEvent = {
  seq?: number;
  eventId: string;
  type: string;
  threadId?: string;
  turnId?: string;
  at: string;
  payload: unknown;
};

export function newEvent(type: string, params: Record<string, unknown> = {}): BridgeEvent {
  const { threadId, turnId, ...payload } = params;
  return {
    eventId: randomUUID(),
    type,
    threadId: typeof threadId === "string" ? threadId : undefined,
    turnId: typeof turnId === "string" ? turnId : undefined,
    at: new Date().toISOString(),
    payload,
  };
}

export function truncateUtf8(value: unknown, maxBytes: number) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { value: text, truncated: false, originalBytes: bytes.length };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { value: bytes.subarray(0, end).toString("utf8"), truncated: true, originalBytes: bytes.length };
}

export function sanitizedFcmData(input: Record<string, unknown>) {
  return {
    hostId: String(input.hostId ?? ""),
    sessionId: String(input.sessionId ?? ""),
    eventId: String(input.eventId ?? ""),
    type: String(input.type ?? ""),
  };
}

export function toRpcError(error: unknown) {
  if (error instanceof RpcError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RpcError("INTERNAL", message);
}
