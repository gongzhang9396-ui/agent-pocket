#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { RelayError } from "./protocol.js";
import { RelayServer } from "./server.js";
import { RelayStore } from "./store.js";

function usage() {
  console.log("Agent Pocket Relay v2\n\n用法:\n  npm run dev\n  npm run bootstrap\n  node dist/cli.js serve\n  node dist/cli.js bootstrap\n  node dist/cli.js recover-device <relay-url> <account-id> <device-id> <recovery-file>");
}

async function main() {
  const command = process.argv[2] || "serve";
  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "recover-device") {
    const { recoverDevice } = await import("./recovery.js");
    await recoverDevice(process.argv.slice(3));
    return;
  }
  const config = loadConfig();
  const store = new RelayStore(config.dbPath);
  if (command === "bootstrap") {
    try {
      const bootstrap = store.createBootstrap();
      console.log(`管理员初始化链接（15 分钟有效，仅可使用一次）：\n${config.publicUrl}/bootstrap#${bootstrap.id}.${bootstrap.secret}`);
    } finally {
      store.close();
    }
    return;
  }
  if (command !== "serve") {
    store.close();
    usage();
    process.exitCode = 2;
    return;
  }
  const server = new RelayServer(config, store);
  await server.start();
  console.log(`Agent Pocket Relay v2 listening on ${config.bindHost}:${config.port}`);
  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    stopPromise ||= (async () => {
      try {
        await server.stop();
      } finally {
        store.close();
      }
    })();
    return stopPromise;
  };
  const shutdown = () => void stop().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  if (error instanceof RelayError) console.error(`${error.nameCode}: ${error.message}`);
  else console.error(error);
  process.exitCode = 1;
});
