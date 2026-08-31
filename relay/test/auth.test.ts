import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/auth.js";
import { sanitizedFcmData } from "../src/fcm.js";
import { validateEnvelope } from "../src/protocol.js";
import { LoginThrottle } from "../src/rate-limit.js";

const TEST_COST = { N: 1 << 10, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

test("scrypt hashes verify and malformed cost fields fail closed", async () => {
  const encoded = await hashPassword("this-is-a-long-password", TEST_COST);
  assert.equal(await verifyPassword("this-is-a-long-password", encoded), true);
  assert.equal(await verifyPassword("wrong-password-value", encoded), false);
  assert.equal(await verifyPassword("anything", "scrypt$999999999$999$9$AA$AA"), false);
  assert.equal(await verifyPassword("anything", "scrypt$1024$8$1$AA$AA"), false);
});

test("event envelopes reject unknown metadata and non-events reject event fields", () => {
  const base = { accountId: "a", hostId: "h", deviceId: "h", channelId: "events", counter: 0, ciphertext: "AA" };
  assert.throws(() => validateEnvelope({ ...base, kind: "event.append", eventId: "e", eventType: "secret-source" }), /事件类型无效/);
  assert.throws(() => validateEnvelope({ ...base, kind: "snapshot.put", eventId: "e" }), /非事件信封/);
});

test("FCM data contains routing metadata only", () => {
  assert.deepEqual(sanitizedFcmData({ hostId: "host", eventId: "event", type: "attention" }), {
    hostId: "host",
    eventId: "event",
    type: "attention",
  });
});

test("login throttle bounds source and account tracking entries", () => {
  const throttle = new LoginThrottle({ maxEntries: 3, freeFailures: 100 });
  throttle.failed("first", 1);
  throttle.failed("second", 2);
  throttle.failed("third", 3);
  throttle.failed("fourth", 4);
  assert.equal(throttle.size(), 3);
  throttle.failed("fifth", 5);
  assert.equal(throttle.size(), 3);
});
