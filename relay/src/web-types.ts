/** Public wire contracts shared by the Relay web API and browser client. */
export type WebAuthState = "password_unverified" | "account_activation_required" | "totp_enrollment_required" | "totp_required" | "totp_verified" | "key_migration_required" | "device_proof_pending" | "local_locked" | "ready" | "session_expired" | "device_revoked";
export type TotpEnrollment = { algorithm: "SHA1"; digits: 6; period: 30; secret: string; otpauthUri: string; recoveryCodes?: string[] };
export type WebDevice = { id: string; name: string; status: "pending" | "approved" | "revoked"; signingPublicKey: string; encryptionPublicKey: string; trusted?: boolean };
export type WebKeyPackage = { version: 1; algorithm: "argon2id+xchacha20poly1305"; salt: string; nonce: string; kdf: { opsLimit: number; memLimit: number; algorithm: number }; ciphertext: string; accountPublicKeyFingerprint: string; stale?: boolean };
export type MigrationOperation = { operationId: string; expectedVersion: number; keyPackageVersion?: number; status: "submitted" | "succeeded" | "failed" | "unknown"; error?: string };
export type WsTicket = { ticket: string; expiresAt: number; sessionId?: string; deviceId?: string };
export type OperationReceipt = { operationId: string; clientMessageId?: string; status: "submitted" | "succeeded" | "failed" | "unknown"; result?: unknown; error?: unknown };
export type CapabilityMatrix = { send?: boolean; steer?: boolean; interrupt?: boolean; approval?: boolean; question?: boolean; plan?: boolean; goal?: boolean; attachments?: boolean; desktopWriter?: boolean };
export type SyncCursor = { hostId: string; revision: number; eventSeq: number; updatedAt?: number };
export type AttachmentBudget = { count: number; imageBytes: number; fileBytes: number; totalBytes: number; envelopeBytes: number; maxCount: 3; maxImageBytes: 460800; maxFileBytes: 524288; maxTotalBytes: 819200 };
