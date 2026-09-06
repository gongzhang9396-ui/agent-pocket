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
  const staged = new Set(files);
  for (const file of files.filter((path) => path.endsWith(".ts"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?)['"](\.[^'"]+)['"]/g)) {
      assert.ok(staged.has(resolve(dirname(file), match[1])), `Missing packaged dependency ${match[1]} from ${file}`);
    }
  }
});
