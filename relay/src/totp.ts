import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function randomTotpSecret(bytes = 20) {
  const input = randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string) {
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const char of value.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "")) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("TOTP secret is not base32");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}

export function totpCode(secret: string, step = Math.floor(Date.now() / 1000 / 30)) {
  const key = decodeBase32(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, "0");
}

export function verifyTotp(secret: string, value: unknown, lastStep = -1) {
  if (typeof value !== "string" || !/^\d{6}$/.test(value)) return undefined;
  const current = Math.floor(Date.now() / 1000 / 30);
  for (const step of [current - 1, current, current + 1]) {
    if (step <= lastStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    const actual = Buffer.from(value);
    if (timingSafeEqual(expected, actual)) return step;
  }
  return undefined;
}

export function recoveryCodeHash(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

export function createRecoveryCodes(count = 10) {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const code = String(randomBytes(6).readUIntBE(0, 6) % 1_000_000_000_000).padStart(12, "0");
    codes.push(code);
    hashes.push(recoveryCodeHash(code));
  }
  return { codes, hashes };
}

export function otpauthUri(issuer: string, username: string, secret: string) {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${username}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
