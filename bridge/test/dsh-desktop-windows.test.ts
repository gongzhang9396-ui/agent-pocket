import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
test('Windows shared desktop entry validates its process and rejects altered ownership records', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'pocket-dsh-launcher-test-'));
  const app = join(base, 'install'), state = join(base, 'AgentPocket'), scripts = join(app, 'scripts');
  const root = join(state, 'dsh-desktop'), runtime = join(base, 'runtime'), home = join(base, 'home');
  await mkdir(scripts, { recursive: true }); await mkdir(state);
  await mkdir(join(app, 'bridge/src'), { recursive: true });
  const entry = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  await mkdir(join(entry, '..'), { recursive: true });
  await writeFile(entry, `const net = require('node:net');
    const server = net.createServer(); server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
    process.on('disconnect',()=>server.close(()=>process.exit(0)));`);
  const launcher = join(scripts, 'open-dsh-desktop.ps1');
  await writeFile(launcher, '\ufeff' + await readFile(new URL('../../installer/windows/scripts/open-dsh-desktop.ps1', import.meta.url), 'utf8'));
  const publisher = pathToFileURL(fileURLToPath(new URL('../../dsh-bridge-plugin/desktop-link.mjs', import.meta.url))).href;
  await writeFile(join(app, 'bridge/src/cli.ts'), `
    import {spawn} from 'node:child_process'; import {writeFile} from 'node:fs/promises';
    import {publishDesktopLink} from ${JSON.stringify(publisher)};
    const started=Date.now();
    const child=spawn(process.execPath,${JSON.stringify([entry, '--profile', 'agent-pocket', '--patch', join(home, 'profiles/agent-pocket/pocket-launch.patch.json'), '--no-open', '--host', '127.0.0.1', '--port', '0'])},
      {windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
    let timer;
    child.once('message',async ({port})=>{
      const status=()=>writeFile(${JSON.stringify(join(state, 'host-runtime.json'))},JSON.stringify({running:true,pid:process.pid,updatedAt:new Date().toISOString()}));
      await status(); timer=setInterval(status,200);
      await publishDesktopLink(${JSON.stringify(root)}, {url:'http://127.0.0.1:'+port+'/?token='+'a'.repeat(43),hostPid:process.pid,runtimePid:child.pid,
        hostStartedAt:Date.now()-process.uptime()*1000,runtimeStartedAt:started,nodeExecutable:process.execPath,runtimeRoot:${JSON.stringify(runtime)},home:${JSON.stringify(home)}});
      process.send({ready:true});
    });
    process.on('disconnect',()=>{clearInterval(timer);child.disconnect();child.once('exit',()=>process.exit(0));});
  `);
  const host = spawn(process.execPath, ['--experimental-strip-types', join(app, 'bridge/src/cli.ts'), 'serve'], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, LOCALAPPDATA: base },
  });
  t.after(async () => {
    if (host.connected) {
      const exited = new Promise<void>(r => host.once('exit', () => r())); host.disconnect();
      await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('fixture did not exit')), 10000).unref())]);
    }
    const path = resolve(base); assert.ok(path.startsWith(resolve(tmpdir()) + sep) && path.includes('pocket-dsh-launcher-test-'));
    await rm(path, { recursive: true, force: true });
  });
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 20000);
    host.once('message', () => { clearTimeout(timer); accept(); }); host.once('exit', () => { clearTimeout(timer); reject(new Error('fixture startup exit')); });
  });
  const validate = () => run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', launcher, '-ValidateOnly'], {
    windowsHide: true, timeout: 15000, env: { ...process.env, LOCALAPPDATA: base }, maxBuffer: 4096,
  });
  const good = await validate(); const result = JSON.parse(good.stdout.trim());
  assert.equal(result.validated, true); assert.equal(result.hostPid, host.pid); assert.doesNotMatch(good.stdout, /token|a{43}|http:/);
  const name = (await readdir(root)).find(name => name.endsWith('.json'))!;
  const file = join(root, name), original = await readFile(file, 'utf8'), record = JSON.parse(original);
  for (const patch of [{ nonce: 'wrong' }, { runtimePid: process.pid }, { home: base }, { runtimeRoot: base },
    { hostStartedAt: 1 }, { runtimeStartedAt: 1 }, { url: `http://127.0.0.1:1/?token=${'a'.repeat(43)}` }]) {
    await writeFile(file, JSON.stringify({ ...record, ...patch })); await assert.rejects(validate());
  }
  await writeFile(file, original);
  const marker = join(root, '.agent-pocket-dsh-desktop-v1');
  await rm(marker); await symlink(home, marker, 'junction'); await assert.rejects(validate()); await rm(marker);
  await writeFile(marker, 'agent-pocket-dsh-desktop-v1\n');
  await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1');$a=Get-Acl -LiteralPath $env:POCKET_TEST_ROOT;$a.SetAccessRuleProtection($false,$true);Set-Acl -LiteralPath $env:POCKET_TEST_ROOT -AclObject $a"],
    { windowsHide: true, timeout: 15000, env: { ...process.env, POCKET_TEST_ROOT: root } });
  await assert.rejects(validate());
});
