import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { desktopUrl, publishDesktopLink, removeDesktopLink } from '../../dsh-bridge-plugin/desktop-link.mjs';

const url = `http://127.0.0.1:39999/?token=${'a'.repeat(43)}`;
const info = { url, hostPid: 101, runtimePid: 202, hostStartedAt: Date.now(), runtimeStartedAt: Date.now(),
  nodeExecutable: process.execPath, runtimeRoot: resolve('fixture-runtime'), home: resolve('fixture-home') };
async function fixture(t: any) {
  const base = await mkdtemp(join(tmpdir(), 'pocket-dsh-desktop-test-'));
  t.after(async () => { const path = resolve(base); assert.ok(path.startsWith(resolve(tmpdir()) + sep) && path.includes('pocket-dsh-desktop-test-')); await rm(path, { recursive: true, force: true }); });
  return { base, root: join(base, 'desktop') };
}
test('DSH desktop links accept only the exact local authenticated root', () => {
  assert.equal(desktopUrl(url), url);
  for (const invalid of [url.replace('127.0.0.1', 'example.com'), url.replace('http:', 'file:'), url.replace('/?', '/other?'),
    url + '#fragment', url + '&other=1', url.replace('a'.repeat(43), 'short'), url.replace('127.0.0.1', 'user@127.0.0.1'), url + '\n']) {
    assert.throws(() => desktopUrl(invalid));
  }
});
test('DSH desktop publication is private and cleanup cannot remove another runtime link', async t => {
  const { root } = await fixture(t);
  const first = await publishDesktopLink(root, info);
  const second = await publishDesktopLink(root, { ...info, runtimePid: 203 });
  assert.notEqual(first.file, second.file);
  assert.equal(JSON.parse(await readFile(first.file, 'utf8')).url, url);
  await removeDesktopLink({ ...first, nonce: 'wrong' }); assert.equal((await lstat(first.file)).isFile(), true);
  await removeDesktopLink(first); await assert.rejects(lstat(first.file), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(second.file, 'utf8')).runtimePid, 203);
  await removeDesktopLink(second);
});
test('DSH desktop publication refuses an unrelated directory or junction', async t => {
  const { base, root } = await fixture(t); await mkdir(root);
  await writeFile(join(root, 'user-file'), 'preserve');
  await assert.rejects(publishDesktopLink(root, info));
  assert.equal(await readFile(join(root, 'user-file'), 'utf8'), 'preserve');
  const link = join(base, 'linked');
  await symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(publishDesktopLink(link, info), /unsafe/);
});
test('DSH desktop directory publication supports concurrent starts', async t => {
  const { root } = await fixture(t);
  const links = await Promise.all([publishDesktopLink(root, info), publishDesktopLink(root, { ...info, runtimePid: 204 })]);
  for (const link of links) { assert.equal(JSON.parse(await readFile(link.file, 'utf8')).nonce, link.nonce); await removeDesktopLink(link); }
});
