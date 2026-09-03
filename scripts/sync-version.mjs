import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = readFileSync(join(root, "VERSION"), "utf8").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("VERSION must use x.y.z");
const check = process.argv.includes("--check");

const jsonFiles = [
  "bridge/package.json",
  "relay/package.json",
  "desktop-attach-plugin/.codex-plugin/plugin.json",
];
const lockFiles = ["bridge/package-lock.json", "relay/package-lock.json"];
const textFiles = [
  ["bridge/src/codex.ts", /clientInfo: \{ name: "agent-pocket-bridge", version: "[^"]+" \}/, `clientInfo: { name: "agent-pocket-bridge", version: "${version}" }`],
  ["desktop-attach-plugin/server.mjs", /const PLUGIN_VERSION = "[^"]+";/, `const PLUGIN_VERSION = "${version}";`],
  ["installer/windows/AgentPocketHost.iss", /#define MyAppVersion "[^"]+"/, `#define MyAppVersion "${version}"`],
];

const updates = [];
for (const relative of jsonFiles) {
  const path = join(root, relative);
  const data = JSON.parse(readFileSync(path, "utf8"));
  data.version = version;
  updates.push([path, `${JSON.stringify(data, null, 2)}\n`]);
}
for (const relative of lockFiles) {
  const path = join(root, relative);
  const data = JSON.parse(readFileSync(path, "utf8"));
  data.version = version;
  if (data.packages?.[""]) data.packages[""].version = version;
  updates.push([path, `${JSON.stringify(data, null, 2)}\n`]);
}
for (const [relative, pattern, replacement] of textFiles) {
  const path = join(root, relative);
  const before = readFileSync(path, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before && !before.includes(replacement)) throw new Error(`Version marker missing: ${relative}`);
  updates.push([path, after]);
}

const stale = updates.filter(([path, expected]) => readFileSync(path, "utf8") !== expected);
if (check && stale.length) {
  throw new Error(`Version files are out of sync with VERSION: ${stale.map(([path]) => path.slice(root.length + 1)).join(", ")}`);
}
if (!check) for (const [path, contents] of stale) writeFileSync(path, contents, "utf8");
process.stdout.write(`${check ? "checked" : "updated"} ${updates.length} version files to ${version}\n`);
