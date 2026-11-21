import assert from "node:assert/strict";
import test from "node:test";
import { desktopStatus } from "../web/src/desktop-status.ts";

test("only a verified Desktop Attach connection reports ready", () => {
  assert.equal(desktopStatus({ desktop: { state: "ready", attachReady: true } }), "ready");
  for (const desktop of [{ state: "ready", attachReady: false }, { state: "ready" }, { state: "closed", processRunning: true }, { state: "starting", processRunning: false }, {}]) {
    assert.equal(desktopStatus({ desktop }), "unknown");
  }
  assert.equal(desktopStatus({ desktop: { state: "closed", processRunning: false, canWake: true } }), "closed");
  assert.equal(desktopStatus({ desktop: { state: "starting", processRunning: true } }), "starting");
  assert.equal(desktopStatus({ desktop: { state: "starting", processRunning: false, safeLaunch: true } }), "starting");
  assert.equal(desktopStatus({ desktop: { state: "disabled", safeLaunch: true } }), "disabled");
  assert.equal(desktopStatus(), "unknown");
});
