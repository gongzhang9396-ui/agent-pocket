import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DshRuntime, prepareDshProfile } from '../src/dsh-runtime.ts';
import { sealFreshInstall, verifyRuntime } from '../../dsh-bridge-plugin/runtime-integrity.mjs';
import { privateRuntime } from '../../dsh-bridge-plugin/private-runtime.mjs';

async function fixture(t: any, probe = 'good') {
  const base = await mkdtemp(join(tmpdir(), 'pocket-dsh-runtime-test-'));
  t.after(async () => { const path = resolve(base); assert.ok(path.startsWith(resolve(tmpdir()) + sep) && path.includes('pocket-dsh-runtime-test-')); await rm(path, { recursive: true, force: true }); });
  const runtime = join(base, 'runtime'), cwd = join(base, 'workspace'), home = join(base, 'home');
  await mkdir(join(runtime, 'node_modules/@deepseek-ai/dsh/lib'), { recursive: true }); await mkdir(cwd);
  await privateRuntime(runtime, true);
  await writeFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }));
  await writeFile(join(runtime, 'package-lock.json'), JSON.stringify({ packages: {} }));
  await writeFile(join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), `
    const fs = require('node:fs');
    process.on('disconnect', () => process.exit(0));
    process.on('message', msg => {
      fs.appendFileSync(${JSON.stringify(join(base, 'calls.txt'))}, msg.method + '\\n');
      if (msg.method === 'probe') setTimeout(() => process.send({ type: 'response', id: msg.id,
        ${probe === 'error' ? "error: { code: 'AGENT_ERROR', message: 'fixture probe failed' }" : `result: { protocolVersion: 1, runtimeVersion: '0.2.1-rc.2', capabilities: ${JSON.stringify(probe === 'missing' ? ['approval-waterfall-safe'] : probe === 'missing-web' ? ['approval-waterfall-safe', 'questions-v1'] : ['approval-waterfall-safe', 'questions-v1', 'desktop-web-entry-v1'])} }`} }), 250);
    });
    process.send({ type: 'ready', protocolVersion: 1, runtimeVersion: '0.2.1-rc.2', desktopUrl: ${JSON.stringify(probe === 'missing-url' ? null : probe === 'invalid-url' ? 'https://example.com/' : `http://127.0.0.1:39999/?token=${'a'.repeat(43)}`)} });
  `);
  await sealFreshInstall(runtime);
  return { base, runtime, cwd, home };
}
test('DSH public writes remain closed until the complete capability probe succeeds', async t => {
  const f = await fixture(t), runtime = new DshRuntime([f.cwd], { runtimeRoot: f.runtime, home: f.home });
  runtime.desktopDirectory = join(f.base, 'desktop');
  try {
    const starting = runtime.ensure();
    while (!runtime.ipcReady) await new Promise(r => setTimeout(r, 10));
    assert.equal(runtime.ready, false);
    await assert.rejects(runtime.request('create', {}), (e: any) => e.nameCode === 'AGENT_OFFLINE');
    await starting; assert.equal(runtime.ready, true); assert.equal(runtime.verifiedCapabilities.has('questions-v1'), true);
    assert.equal(await readFile(join(f.base, 'calls.txt'), 'utf8'), 'probe\n');
  } finally { await runtime.stop(); }
  assert.equal(runtime.child, undefined);
});
for (const mode of ['error', 'missing', 'missing-web', 'invalid-url', 'missing-url']) test(`failed DSH ${mode} probe closes its child and never enables mutations`, async t => {
  const f = await fixture(t, mode), runtime = new DshRuntime([f.cwd], { runtimeRoot: f.runtime, home: f.home });
  runtime.desktopDirectory = join(f.base, 'desktop');
  try { await assert.rejects(runtime.ensure()); assert.equal(runtime.ready, false); assert.equal(runtime.ipcReady, false);
    assert.equal(runtime.child, undefined); await assert.rejects(runtime.request('send', {}));
    if (!mode.endsWith('-url')) assert.equal(await readFile(join(f.base, 'calls.txt'), 'utf8'), 'probe\n');
    assert.equal((await readdir(f.base)).includes('desktop'), false);
  } finally { await runtime.stop(); }
});
test('DSH integrity refuses changed, added and redirected executable files', async t => {
  const f = await fixture(t);
  await verifyRuntime(f.runtime);
  const pkg = join(f.runtime, 'node_modules/@deepseek-ai/dsh/package.json');
  const original = await readFile(pkg);
  await writeFile(pkg, '{}'); await assert.rejects(verifyRuntime(f.runtime), /modified/); await writeFile(pkg, original);
  const extra = join(f.runtime, 'node_modules/extra.js');
  await writeFile(extra, 'changed'); await assert.rejects(verifyRuntime(f.runtime), /modified/); await rm(extra);
  const link = join(f.runtime, 'node_modules/outside');
  await symlink(f.cwd, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyRuntime(f.runtime), /leaves its installation/);
});
test('DSH preserves and rejects global or modified user profile patches', async t => {
  const f = await fixture(t); await mkdir(f.home);
  const global = join(f.home, 'cordis.patch.yml'); await writeFile(global, 'preserve-me');
  await assert.rejects(prepareDshProfile(f.home, f.runtime), /全局插件补丁/);
  assert.equal(await readFile(global, 'utf8'), 'preserve-me'); await rm(global);
  await prepareDshProfile(f.home, f.runtime);
  const local = join(f.home, 'profiles/agent-pocket/cordis.patch.yml'); await writeFile(local, 'changed');
  await assert.rejects(prepareDshProfile(f.home, f.runtime), /已更改/);
  assert.equal(await readFile(local, 'utf8'), 'changed');
});
