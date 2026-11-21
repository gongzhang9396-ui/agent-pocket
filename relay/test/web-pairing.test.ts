import assert from "node:assert/strict";
import test from "node:test";
import { parseHostPairing } from "../web/src/pairing.ts";
import { webHostPairingUrl } from "../../bridge/src/cli.ts";

const enrollment = { id: "12345678-1234-1234-1234-123456789abc", secret: "synthetic-pairing-secret-123456789" };
const origin = "https://relay.example.test";
test("web Host link keeps the existing enrollment in a same-origin fragment; Android URI stays compatible", () => {
  const url = webHostPairingUrl(origin, enrollment);
  assert.equal(new URL(url).search, "");
  assert.deepEqual(parseHostPairing(url, origin), { enrollmentId: enrollment.id, secret: enrollment.secret });
  assert.deepEqual(parseHostPairing(`${enrollment.id}.${enrollment.secret}`, origin), { enrollmentId: enrollment.id, secret: enrollment.secret });
  const app = `agentpocket://relay-host?relay=${encodeURIComponent(origin)}&enrollmentId=${enrollment.id}&secret=${enrollment.secret}`;
  assert.deepEqual(parseHostPairing(app, origin), { enrollmentId: enrollment.id, secret: enrollment.secret });
});
test("web Host link rejects foreign origins, credentials, queries and malformed capabilities", () => {
  const good = webHostPairingUrl(origin, enrollment);
  for (const value of [good.replace(origin, "https://foreign.test"), good.replace("/app/", "/admin/"), good.replace("#", "?tracking=1#"), good.replace("https://", "https://user:pass@"), `${enrollment.id}.short`, "agentpocket://relay-host?relay=https://foreign.test"]) assert.throws(() => parseHostPairing(value, origin));
  for (const value of ["http://relay.example.test", `${origin}/path`, `${origin}?query=1`, `https://user:pass@relay.example.test`]) assert.throws(() => webHostPairingUrl(value, enrollment));
});
