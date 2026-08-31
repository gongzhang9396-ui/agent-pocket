import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./config.ts";
import { CodexAppServer } from "./codex.ts";
import { DesktopAttachClient } from "./desktop-attach.ts";
import { FcmNotifier } from "./fcm.ts";
import { checkForHostUpdate } from "./host-updater.ts";
import { BridgeServer } from "./server.ts";
import { BridgeStore } from "./store.ts";
import { RelayConnector, beginHostEnrollment, waitForHostEnrollment } from "./relay-connector.ts";
import { loadHostIdentity } from "./relay-crypto.ts";

function usage() {
  console.log("Agent Pocket Bridge\n\n  serve\n  relay-enroll [https-url]\n  relay-status\n  host-update-check [--policy <file>] [--output <directory>]\n  pair [wss-url]\n  devices\n  revoke <device-id>\n  desktop-probe");
}

function optionValue(argv: string[], name: string) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数`);
  return value;
}

export async function writePairingPng(uri: string, pairingId: string) {
  try {
    const module = await import("qrcode");
    const qr = module.default ?? module;
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const outputDir = join(localAppData, "AgentPocket");
    mkdirSync(outputDir, { recursive: true });
    const outputFile = join(outputDir, `pairing-${pairingId}.png`);
    await qr.toFile(outputFile, uri, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 4,
      width: 1024,
    });
    try {
      const explorer = spawn("explorer.exe", [outputFile], { detached: true, stdio: "ignore" });
      explorer.unref();
    } catch {
      // Opening the file is a convenience; the file path is still printed below.
    }
    return outputFile;
  } catch {
    return undefined;
  }
}

export async function printPairingQr(uri: string) {
  try {
    const module = await import("qrcode-terminal");
    const qr = module.default ?? module;
    await new Promise<void>((resolve) => {
      qr.generate(uri, { small: false }, (output: string) => {
        console.log(`\n${output}`);
        resolve();
      });
    });
    return;
  } catch {
    // Optional dependency may be unavailable; continue with the other local fallback.
  }
  const qr = spawnSync("qrencode", ["-t", "UTF8", uri], { encoding: "utf8", shell: false });
  if (qr.status === 0 && qr.stdout) {
    console.log(`\n${qr.stdout}`);
  } else {
    console.log("\n未找到本地二维码生成器，请使用手动配对码；不会把配对内容上传到第三方服务。");
  }
}

export function normalizePublicUrl(value: string | undefined) {
  if (!value) throw new Error("请先配置 AGENT_POCKET_WSS_URL，或执行 pair wss://你的安全中继地址/专用路径");
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("安全中继地址必须是完整的 wss:// URL");
  }
  if (endpoint.protocol !== "wss:" || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("安全中继地址必须是无用户名、密码和片段的完整 wss:// URL");
  }
  return endpoint.href;
}

function savedTunnelUrl() {
  try {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const file = join(localAppData, "AgentPocket", "tunnel", "tunnel.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { publicUrl?: unknown };
    return typeof parsed.publicUrl === "string" ? parsed.publicUrl : undefined;
  } catch {
    return undefined;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || ["-h", "--help", "help"].includes(command)) return usage();

  if (command === "desktop-probe") {
    const desktop = new DesktopAttachClient();
    const probe = await desktop.probe();
    const tasks = await desktop.listThreads(3);
    console.log(JSON.stringify({
      connected: true,
      readOnly: probe.bridgeWritable !== true,
      mode: probe.mode,
      availableTools: Array.isArray(probe.available) ? probe.available.map((item: any) => item.name) : [],
      taskListContentItems: Array.isArray(tasks.contentItems) ? tasks.contentItems.length : 0,
    }, null, 2));
    return;
  }

  if (command === "host-update-check") {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const policyPath = optionValue(argv, "--policy") || process.env.AGENT_POCKET_UPDATE_POLICY || join(installRoot, "update-policy.json");
    const outputDir = optionValue(argv, "--output") || process.env.AGENT_POCKET_UPDATE_DIR || join(localAppData, "AgentPocket", "updates");
    const result = await checkForHostUpdate({ policyPath, outputDir });
    console.log(JSON.stringify(result));
    return;
  }

  // Pairing and device administration only need the local state database.
  // Keep the strict project-root requirement on the long-running Bridge.
  const config = loadConfig(process.env, { requireProjectRoots: command === "serve" });
  const store = new BridgeStore(config.dbPath);

  if (command === "relay-enroll") {
    const relayUrl = argv[1] || config.relayUrl;
    if (!relayUrl) throw new Error("缺少 Relay 地址；请执行 relay-enroll https://你的Relay域名");
    const started = await beginHostEnrollment(relayUrl, config.hostName, config.relayIdentityPath);
    const pngFile = await writePairingPng(started.enrollment.pairUri, started.enrollment.id);
    console.log(`Relay：${relayUrl}\n有效期：5 分钟\nHost：${config.hostName}`);
    if (pngFile) console.log(`\n已生成二维码图片并尝试打开：${pngFile}`);
    console.log("\n请用已登录 Agent Pocket v2 的手机扫码确认这台电脑：");
    await printPairingQr(started.enrollment.pairUri);
    await waitForHostEnrollment(relayUrl, config.relayIdentityPath, started.identity, started.enrollment);
    console.log("\nHost 已绑定。重新启动 Agent Pocket Bridge 后将自动连接 Relay。");
    store.close();
    return;
  }
  if (command === "relay-status") {
    const identity = loadHostIdentity(config.relayIdentityPath);
    console.log(JSON.stringify(identity ? {
      enrolled: Boolean(identity.hostToken && identity.hostId && identity.accountId),
      relayUrl: identity.relayUrl,
      hostName: identity.hostName,
      hostId: identity.hostId,
      accountId: identity.accountId,
      lastBridgeSeq: identity.lastBridgeSeq,
    } : { enrolled: false }, null, 2));
    store.close();
    return;
  }

  if (command === "pair") {
    const endpoint = normalizePublicUrl(argv[1] || config.publicUrl || savedTunnelUrl());
    const pairing = store.createPairing();
    const uri = `agentpocket://pair?endpoint=${encodeURIComponent(endpoint)}&pairingId=${encodeURIComponent(pairing.id)}&secret=${encodeURIComponent(pairing.secret)}`;
    const pngFile = await writePairingPng(uri, pairing.id);
    console.log(`有效期：5 分钟\nBridge：${endpoint}\n手动配对码：${pairing.id}.${pairing.secret}`);
    if (pngFile) console.log(`\n已生成二维码图片并尝试打开：${pngFile}`);
    console.log("\n配对二维码（手机扫码配对）：");
    await printPairingQr(uri);
    console.log(`\n配对链接（二维码不可用时可复制到配对码框）：\n${uri}`);
    store.close();
    return;
  }
  if (command === "devices") {
    console.table(store.listDevices());
    store.close();
    return;
  }
  if (command === "revoke") {
    const id = argv[1];
    if (!id) throw new Error("缺少 device-id");
    console.log(store.revokeDevice(id) ? "设备已撤销" : "设备不存在或已撤销");
    store.close();
    return;
  }
  if (command !== "serve") {
    store.close();
    throw new Error(`未知命令：${command}`);
  }

  const codex = new CodexAppServer({
    command: config.codexCommand,
    codexHome: config.codexHome,
    minVersion: config.minCodexVersion,
  });
  const status = await codex.start();
  const bridge = new BridgeServer(
    config,
    store,
    codex,
    new FcmNotifier(config.firebaseServiceAccount),
    new DesktopAttachClient(),
  );
  await bridge.start();
  const relayIdentity = loadHostIdentity(config.relayIdentityPath);
  const relayUrl = config.relayUrl || relayIdentity?.relayUrl;
  let relayConnector: RelayConnector | undefined;
  if (relayUrl && relayIdentity?.hostToken) {
    relayConnector = new RelayConnector(relayUrl, config.relayIdentityPath, relayIdentity, bridge, store);
    relayConnector.on("status", (status) => writeSync(1, `Agent Pocket Relay：${status.connected ? "已连接" : `已断开（${status.error || "正在重连"}）`}\n`));
    relayConnector.start();
  } else if (relayUrl) {
    writeSync(1, "Agent Pocket Relay：尚未绑定，请执行 relay-enroll\n");
  }
  writeSync(1, `Agent Pocket Bridge：http://${config.bindHost}:${config.port}（Codex ${status.version}${status.readOnly ? "，只读" : ""}）\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await relayConnector?.stop();
    await bridge.stop();
    codex.stop();
    store.close();
  };
  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
