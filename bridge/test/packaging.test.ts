import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Windows payload contains every local runtime dependency", () => {
  const bridge = fileURLToPath(new URL("..", import.meta.url));
  const script = readFileSync(new URL("../../installer/windows/build-installer.ps1", import.meta.url), "utf8");
  const list = script.match(/\$bridgeFiles = @\(([\s\S]*?)\n\)/)?.[1];
  assert.ok(list, "Cannot find the Bridge payload allowlist");
  const files = [...list.matchAll(/'([^']+)'/g)].map((match) => resolve(bridge, match[1].replaceAll("\\", "/")));
  const dsh = script.match(/Copy-AllowlistedFiles \(Join-Path \$repoRoot 'dsh-bridge-plugin'\) \$dshStage @\(([\s\S]*?)\n\)/)?.[1];
  assert.ok(dsh, 'Missing DSH plugin payload allowlist');
  const dshFiles = [...dsh.matchAll(/'([^']+)'/g)].map((match) => match[1].replaceAll('\\', '/'));
  for (const required of ['index.mjs', 'core.mjs', 'projection.mjs', 'desktop-link.mjs', 'profile-settings.mjs', 'runtime-integrity.mjs', 'private-runtime.mjs', 'prepare-runtime.mjs', 'runtime/package.json', 'runtime/package-lock.json']) assert.ok(dshFiles.includes(required));
  assert.ok(!dshFiles.some(path => /node_modules|pocket-runtime|dsh-runtime\.json/.test(path)), 'External runtime and state must not enter the payload');
  files.push(...dshFiles.map(path => resolve(bridge, '../dsh-bridge-plugin', path)));
  const staged = new Set(files);
  for (const file of files.filter((path) => /\.(ts|mjs)$/.test(path))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?)['"](\.[^'"]+)['"]/g)) {
      assert.ok(staged.has(resolve(dirname(file), match[1])), `Missing packaged dependency ${match[1]} from ${file}`);
    }
  }
});

test("Desktop plugin payload contains every module imported by the adapter", () => {
  const root = fileURLToPath(new URL("../../desktop-attach-plugin/", import.meta.url));
  const script = readFileSync(new URL("../../installer/windows/build-installer.ps1", import.meta.url), "utf8");
  const list = script.match(/Copy-AllowlistedFiles \(Join-Path \$repoRoot 'desktop-attach-plugin'\) \$pluginStage @\(([\s\S]*?)\n\)/)?.[1];
  assert.ok(list);
  const files = [...list.matchAll(/'([^']+)'/g)].map((match) => resolve(root, match[1].replaceAll("\\", "/")));
  for (const file of files.filter((path) => path.endsWith(".mjs"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?)['"](\.[^'"]+)['"]/g)) {
      assert.ok(files.includes(resolve(dirname(file), match[1])), `Missing plugin dependency: ${match[1]}`);
    }
  }
});
