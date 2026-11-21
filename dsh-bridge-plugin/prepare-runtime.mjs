import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DSH_VERSION, sealFreshInstall, verifyRuntime } from './runtime-integrity.mjs';
import { privateRuntime } from './private-runtime.mjs';

const stateRoot = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'AgentPocket');
const root = resolve(process.argv[2] || join(stateRoot, 'dsh-runtime', DSH_VERSION));
const here = dirname(fileURLToPath(import.meta.url));
if (existsSync(root)) {
  await verifyRuntime(root); // Never bless or overwrite an existing unverified installation.
} else {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await privateRuntime(root, true);
  await copyFile(join(here, 'runtime', 'package.json'), join(root, 'package.json'));
  await copyFile(join(here, 'runtime', 'package-lock.json'), join(root, 'package-lock.json'));
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('Cannot find npm-cli.js; run this script with npm-installed Node');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, 'ci', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'],
      { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`DSH install failed (${code})`)));
  });
  await sealFreshInstall(root);
}
await mkdir(stateRoot, { recursive: true, mode: 0o700 });
await writeFile(join(stateRoot, 'dsh-runtime.json'), JSON.stringify({ version: 1, root, dshVersion: DSH_VERSION,
  home: resolve(process.env.DSH_HOME || join(homedir(), '.dsh')) }), { mode: 0o600 });
console.log('Verified DeepSeek Harness runtime is ready. Existing DSH installation and credentials were preserved.');
