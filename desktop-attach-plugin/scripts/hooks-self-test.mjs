import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8"));
const events = Object.keys(config.hooks || {});
assert.deepEqual(events, ["SessionStart"]);

const groups = config.hooks.SessionStart;
assert.equal(groups.length, 1);
assert.equal(groups[0].matcher, "^(startup|resume|clear)$");
assert.equal(groups[0].hooks.length, 1);
assert.deepEqual(groups[0].hooks[0], {
  type: "mcp_tool",
  server: "agent_pocket_desktop_attach",
  tool: "desktop_attach_probe",
  input: {},
  timeout: 12,
  statusMessage: "Connecting Agent Pocket to Codex Desktop",
});

console.log(JSON.stringify({ ok: true, events, tool: groups[0].hooks[0].tool }));
