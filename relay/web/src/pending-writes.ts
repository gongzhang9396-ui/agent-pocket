// Routing/receipt identifiers only. Never persist prompts, answers, attachments,
// approval payloads, tokens, keys or decrypted task content here.
export type PendingWrite = { operationId: string; hostId: string; threadId: string; requestId?: string; kind?: "create" };
export function verifiedReceipt(receipt: any, operationId: string) {
  if (!receipt || receipt.operationId !== operationId) throw new Error('操作回执不匹配，原操作结果仍待确认');
  return receipt;
}
export function pendingKey(accountId: string, deviceId: string) { return `agent-pocket-web-pending:${accountId}:${deviceId}`; }
export function readPending(key: string): PendingWrite[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((entry) => entry && typeof entry.operationId === "string" && typeof entry.hostId === "string" && typeof entry.threadId === "string").slice(0, 100) : [];
  } catch { return []; }
}
export function savePending(key: string, record: PendingWrite) {
  try {
    const current = readPending(key).filter((entry) => entry.operationId !== record.operationId);
    const { operationId, hostId, threadId, requestId, kind } = record;
    sessionStorage.setItem(key, JSON.stringify([...current, { operationId, hostId, threadId, requestId, kind }]));
  } catch { /* Restricted storage: the in-memory receipt and unload guard remain. */ }
}
export function removePending(key: string, operationId: string) {
  try { sessionStorage.setItem(key, JSON.stringify(readPending(key).filter((entry) => entry.operationId !== operationId))); } catch { /* restricted storage */ }
}
