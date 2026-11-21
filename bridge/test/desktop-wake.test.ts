import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BridgeServer, spawnDesktopApplication } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

test("desktop process launch handles asynchronous errors and only reports successful spawn", async () => {
  const commands: unknown[][] = [];
  const start = (fail: boolean) => ((...args: unknown[]) => {
    commands.push(args); const child = new EventEmitter() as any; child.unref = () => { child.unreferenced = true; };
    queueMicrotask(() => fail ? child.emit("error", new Error("fixture spawn failure")) : child.emit("spawn"));
    return child;
  }) as any;
  await assert.rejects(spawnDesktopApplication(start(true)), /fixture spawn failure/);
  await spawnDesktopApplication(start(false));
  assert.equal(commands[0][0], "explorer.exe");
  assert.deepEqual(commands[0][1], ["shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App"]);
  assert.deepEqual(commands[0][2], { detached: true, stdio: "ignore", windowsHide: true });
});

function fixture() {
  const server = Object.create(BridgeServer.prototype) as BridgeServer;
  server.config = { desktopIntegrationEnabled: true } as any;
  server.desktopPlatform = "win32"; server.desktopLaunchUntil = 0;
  server.codex = { readOnly: false, version: "fixture" } as any;
  server.isDesktopProcessRunning = async () => false;
  return server;
}

test("concurrent requests share one launch and cooldown prevents rapid repeated launches", async () => {
  const server = fixture(); let calls = 0; let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  server.startDesktopProcess = async () => { calls++; await barrier; };
  const first = server.launchDesktop(); const second = server.launchDesktop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1); release();
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, b);
  assert.equal(a.desktop.state, "starting"); assert.equal(a.desktop.processRunning, false);
  assert.ok(server.desktopLaunchUntil - Date.now() >= 45_000, "Host cooldown must outlast the client's waiting window");
  assert.equal((await server.hostRuntime()).desktop.canWake, false);
  await server.launchDesktop(); assert.equal(calls, 1);
});

test("failed startup is reported without reserving a false running state", async () => {
  const server = fixture(); server.startDesktopProcess = async () => { throw new Error("fixture"); };
  await assert.rejects(server.launchDesktop(), /无法请求启动/);
  const result = await server.hostRuntime(); assert.equal(result.desktop.state, "closed"); assert.equal(result.desktop.canWake, true);
});

test("disabled Desktop integration cannot be launched or advertised", async () => {
  const server = fixture(); server.config.desktopIntegrationEnabled = false; let launched = false;
  server.startDesktopProcess = async () => { launched = true; };
  assert.equal((await server.hostRuntime()).desktop.canWake, false);
  assert.equal((await server.hostRuntime()).desktop.state, "disabled");
  await assert.rejects(server.launchDesktop(), /未启用/); assert.equal(launched, false);
  assert.equal(server.capabilities().includes("desktop-wake-v1"), false);
  assert.equal(loadConfig({ AGENT_POCKET_DESKTOP_INTEGRATION_ENABLED: "0" }, { requireProjectRoots: false }).desktopIntegrationEnabled, false);
});
