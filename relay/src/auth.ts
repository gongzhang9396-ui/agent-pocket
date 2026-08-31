import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { RelayError } from "./protocol.js";

export type PasswordCost = { N: number; r: number; p: number; maxmem: number };

function scrypt(password: string, salt: Buffer, keyLength: number, cost: PasswordCost) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, cost, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export const PRODUCTION_PASSWORD_COST: PasswordCost = {
  N: 1 << 17,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
};

const SCRYPT_KEY_BYTES = 64;
const SCRYPT_SALT_BYTES = 16;
const MAX_SCRYPT_N = 1 << 18;
const MAX_SCRYPT_R = 16;
const MAX_SCRYPT_P = 4;

function validCost(N: number, r: number, p: number) {
  return Number.isSafeInteger(N) && N >= 1 << 10 && N <= MAX_SCRYPT_N && (N & (N - 1)) === 0
    && Number.isSafeInteger(r) && r >= 1 && r <= MAX_SCRYPT_R
    && Number.isSafeInteger(p) && p >= 1 && p <= MAX_SCRYPT_P;
}

export function validatePassword(password: unknown) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new RelayError("INVALID_REQUEST", "密码长度必须为 12 到 128 位");
  }
  return password;
}

export async function hashPassword(password: string, cost = PRODUCTION_PASSWORD_COST) {
  validatePassword(password);
  if (!validCost(cost.N, cost.r, cost.p)) throw new RelayError("INVALID_REQUEST", "scrypt 参数无效");
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEY_BYTES, cost);
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, n, r, p, saltText, hashText] = encoded.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !saltText || !hashText) return false;
  const N = Number(n);
  const rValue = Number(r);
  const pValue = Number(p);
  if (!validCost(N, rValue, pValue)) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    if (salt.length !== SCRYPT_SALT_BYTES || expected.length !== SCRYPT_KEY_BYTES) return false;
    const cost = {
      N,
      r: rValue,
      p: pValue,
      maxmem: Math.max(256 * 1024 * 1024, 256 * N * rValue),
    };
    const actual = await scrypt(password, salt, expected.length, cost);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
