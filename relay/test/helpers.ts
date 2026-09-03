import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayStore } from "../src/store.js";

export function tempStore() {
  const directory = mkdtempSync(join(tmpdir(), "agent-pocket-relay-"));
  const path = join(directory, "relay.db");
  const store = new RelayStore(path);
  return {
    directory,
    path,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function account(store: RelayStore, suffix: string, role: "admin" | "user" = "user") {
  return store.createAccount({
    username: `user-${suffix}`,
    displayName: `User ${suffix}`,
    passwordHash: "unused",
    role,
    signingPublicKey: `sign-${suffix}`,
    encryptionPublicKey: `box-${suffix}`,
    escrowCiphertext: `escrow-${suffix}`,
  });
}

export function device(store: RelayStore, accountId: string, suffix: string) {
  return store.createDevice({
    accountId,
    name: `Phone ${suffix}`,
    signingPublicKey: `device-sign-${suffix}`,
    encryptionPublicKey: `device-box-${suffix}`,
    approved: true,
  });
}

export function host(store: RelayStore, accountId: string, deviceId: string, suffix: string) {
  const enrollment = store.startHostEnrollment(`PC ${suffix}`, `host-sign-${suffix}`, `host-box-${suffix}`);
  store.approveHostEnrollment(accountId, deviceId, enrollment.id, enrollment.secret, `PC ${suffix}`, `host-key-${suffix}`);
  return store.completeHostEnrollment(enrollment.id, enrollment.secret);
}
