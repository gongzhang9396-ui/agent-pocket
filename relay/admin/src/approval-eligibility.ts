export function canApproveDevice(currentAccountId: string, ownerId: string, accountStatus: string, deviceStatus: string) {
  return Boolean(currentAccountId) && currentAccountId === ownerId && accountStatus === "active" && deviceStatus === "pending";
}
