import { readFileSync } from "node:fs";
import { cert, initializeApp, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { RelayError, requiredString } from "./protocol.js";

export type RelayPush =
  | { hostId: string; eventId: string; type: "attention" | "completed" | "status" }
  | { type: "update_available"; platform: "android" | "host"; version: string };

export function sanitizedFcmData(value: RelayPush): Record<string, string> {
  if (value.type === "update_available") {
    if (value.platform !== "android" && value.platform !== "host") throw new RelayError("INVALID_REQUEST", "更新平台无效");
    if (!/^\d+\.\d+\.\d+$/.test(value.version)) throw new RelayError("INVALID_REQUEST", "更新版本无效");
    return { type: value.type, platform: value.platform, version: value.version };
  }
  if (!["attention", "completed", "status"].includes(value.type)) {
    throw new RelayError("INVALID_REQUEST", "FCM 事件类型无效");
  }
  return {
    hostId: requiredString(value.hostId, "hostId", 64),
    eventId: requiredString(value.eventId, "eventId", 64),
    type: value.type,
  };
}

export class FcmNotifier {
  private readonly app?: App;

  constructor(serviceAccountPath?: string) {
    if (!serviceAccountPath) return;
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));
    this.app = initializeApp({ credential: cert(serviceAccount) }, `agent-pocket-relay-${Date.now()}`);
  }

  async send(tokens: string[], data: RelayPush) {
    if (!this.app || tokens.length === 0) return;
    await getMessaging(this.app).sendEachForMulticast({ tokens, data: sanitizedFcmData(data) });
  }
}
