import sodium from "libsodium-wrappers-sumo";
import { b64, bytes, ready, validateAccountPackage, type AccountPackage } from "./crypto";

export type PendingDevice = { id: string; name: string; status: "pending"; signing_public_key: string; encryption_public_key: string; created_at: number | string };
export type DeviceRpc = { request(method: string, params: unknown): Promise<any> };

export function deviceVerificationCode(device: Pick<PendingDevice, "id" | "encryption_public_key">): string {
  const digest = sodium.crypto_hash_sha256(new TextEncoder().encode(`agent-pocket-device-v1\0${device.id}\0${device.encryption_public_key}`));
  return Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase().match(/.{4}/g)!.join(" ");
}

function publicKey(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("设备公钥格式无效");
  const decoded = bytes(value);
  if (decoded.length !== 32 || b64(decoded) !== value) throw new Error("设备公钥格式无效");
  return decoded;
}

export async function pendingDevices(client: DeviceRpc): Promise<PendingDevice[]> {
  await ready();
  const devices = await client.request("device/list", {});
  if (!Array.isArray(devices)) throw new Error("无法读取设备列表");
  return devices.filter((device) => device?.status === "pending").map((device) => {
    if (typeof device.id !== "string" || !device.id || typeof device.name !== "string" || !device.name) throw new Error("设备信息不完整");
    publicKey(device.signing_public_key); publicKey(device.encryption_public_key);
    return { id: device.id, name: device.name, status: "pending", signing_public_key: device.signing_public_key,
      encryption_public_key: device.encryption_public_key, created_at: device.created_at };
  });
}

export async function approvePendingDevice(client: DeviceRpc, selected: PendingDevice, pkg: AccountPackage, account: { signingPublicKey: string; encryptionPublicKey: string }) {
  await ready();
  validateAccountPackage(pkg, account);
  const current = (await pendingDevices(client)).filter((item) => item.id === selected.id);
  if (current.length !== 1 || current[0].name !== selected.name || current[0].signing_public_key !== selected.signing_public_key
    || current[0].encryption_public_key !== selected.encryption_public_key || current[0].created_at !== selected.created_at) {
    throw new Error("设备信息已变化，请刷新后重新确认");
  }
  const plain = new TextEncoder().encode(JSON.stringify(pkg));
  try {
    const keyPackage = b64(sodium.crypto_box_seal(plain, publicKey(current[0].encryption_public_key)));
    return await client.request("device/approve", { deviceId: current[0].id, keyPackage });
  } finally { sodium.memzero(plain); }
}
