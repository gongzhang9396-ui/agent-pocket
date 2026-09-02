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

test("administrative commands may load local state without project roots", () => {
  const config = loadConfig({}, { requireProjectRoots: false });
  assert.deepEqual(config.projectRoots, []);
});

test("relay-only Hosts may request an ephemeral loopback port", () => {
  const config = loadConfig({
    AGENT_POCKET_PROJECT_ROOTS: tmpdir(),
    AGENT_POCKET_PORT: "0",
  });
  assert.equal(config.bindHost, "127.0.0.1");
  assert.equal(config.port, 0);
});

test("attachment storage can be moved independently and otherwise follows the database", () => {
  const base = mkdtempSync(join(tmpdir(), "agent-pocket-attachment-config-"));
  const dbPath = join(base, "state", "bridge.db");
  const defaultConfig = loadConfig({
    AGENT_POCKET_PROJECT_ROOTS: tmpdir(),
    AGENT_POCKET_DB: dbPath,
  });
  assert.equal(defaultConfig.attachmentsPath, join(base, "state", "attachments"));

  const configuredPath = join(base, "large-disk", "attachments");
  const configured = loadConfig({
    AGENT_POCKET_PROJECT_ROOTS: tmpdir(),
    AGENT_POCKET_DB: dbPath,
    AGENT_POCKET_ATTACHMENTS_DIR: configuredPath,
  });
  assert.equal(configured.attachmentsPath, configuredPath);
  assert.equal(configured.dbPath, dbPath);
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
