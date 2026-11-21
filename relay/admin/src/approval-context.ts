import { validateAccountPackage, type AccountPackage } from "../../web/src/crypto";
export { canApproveDevice } from "./approval-eligibility";

export function assertApprovalAccount(expectedAccountId: string, account: {
  id?: string; signingPublicKey: string; encryptionPublicKey: string;
}, pkg: AccountPackage) {
  if (!expectedAccountId || account.id !== expectedAccountId) throw new Error("登录账号与待批准设备不一致");
  validateAccountPackage(pkg, account);
}

