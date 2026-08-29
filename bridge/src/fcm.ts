import { readFileSync } from "node:fs";
import { initializeApp, cert, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { sanitizedFcmData } from "./protocol.ts";

export class FcmNotifier {
  app?: App;

  constructor(serviceAccountPath?: string) {
    if (!serviceAccountPath) return;
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));
    this.app = initializeApp({ credential: cert(serviceAccount) }, `agent-pocket-${Date.now()}`);
  }

  async send(tokens: string[], data: Record<string, unknown>) {
    if (!this.app || tokens.length === 0) return;
    const safe = sanitizedFcmData(data);
    await getMessaging(this.app).sendEachForMulticast({ tokens, data: safe });
  }
}
