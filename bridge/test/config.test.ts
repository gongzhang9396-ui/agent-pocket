import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertAllowedCwd, loadConfig } from "../src/config.ts";
import { RpcError } from "../src/protocol.ts";

test("project roots must be configured explicitly", () => {
  assert.throws(
    () => loadConfig({}),
    /AGENT_POCKET_PROJECT_ROOTS/,
  );
  assert.throws(
    () => loadConfig({ AGENT_POCKET_PROJECT_ROOTS: "   " }),
    /AGENT_POCKET_PROJECT_ROOTS/,
  );
});

test("cwd must stay inside a canonical project root", () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-path-"));
  const root = join(base, "allowed");
  const project = join(root, "project");
  const outside = join(base, "outside");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside);
  assert.equal(assertAllowedCwd(project, [root]), project);
  assert.throws(() => assertAllowedCwd(outside, [root]), (error: unknown) => error instanceof RpcError && error.nameCode === "PATH_DENIED");

  const link = join(root, "escape");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => assertAllowedCwd(link, [root]), (error: unknown) => error instanceof RpcError && error.nameCode === "PATH_DENIED");
});

test("cwd must be absolute and exist", () => {
  assert.throws(() => assertAllowedCwd("relative", [tmpdir()]));
  assert.throws(() => assertAllowedCwd(join(tmpdir(), "definitely-missing-agent-pocket"), [tmpdir()]));
});
