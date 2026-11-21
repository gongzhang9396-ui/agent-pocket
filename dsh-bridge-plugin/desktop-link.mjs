import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { privateRuntime } from './private-runtime.mjs';

const MARKER = '.agent-pocket-dsh-desktop-v1';
const MARKER_TEXT = 'agent-pocket-dsh-desktop-v1\n';

export function desktopUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\r\n\0]/.test(value)) throw new Error('Invalid DeepSeek desktop URL');
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.pathname !== '/' || url.hash || url.searchParams.size !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('token') || '')) {
    throw new Error('DeepSeek desktop requires its owned loopback launch URL');
  }
  return url.href;
}

/** Each runtime owns a distinct file. Its exit cannot remove a newer runtime's
 * launch link. The token stays in this private local directory and parent IPC. */
export async function publishDesktopLink(root, input) {
  const url = desktopUrl(input.url);
  for (const id of [input.hostPid, input.runtimePid]) if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid desktop owner');
  for (const time of [input.hostStartedAt, input.runtimeStartedAt]) if (!Number.isFinite(time) || time <= 0) throw new Error('Invalid desktop owner time');
  for (const path of [input.nodeExecutable, input.runtimeRoot, input.home]) {
    if (typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/.test(path)) throw new Error('Invalid desktop process path');
  }
  const parent = await lstat(dirname(root));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('DeepSeek desktop parent is unsafe');
  try { await lstat(root); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Publish only a completely marked, private directory. A crash before the
    // rename leaves no half-initialized final directory to block the next boot.
    const temporary = await mkdtemp(join(dirname(root), '.dsh-desktop-'));
    try {
      await privateRuntime(temporary, true);
      await writeFile(join(temporary, MARKER), MARKER_TEXT, { flag: 'wx', mode: 0o600 });
      try { await rename(temporary, root); } catch (renameError) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(renameError.code)) throw renameError;
        // A concurrent publisher must pass the same ownership checks below.
        await lstat(root);
      }
    } finally {
      await unlink(join(temporary, MARKER)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('DeepSeek desktop directory is unsafe');
  const marker = join(root, MARKER);
  const markerStat = await lstat(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size !== Buffer.byteLength(MARKER_TEXT)
    || await readFile(marker, 'utf8') !== MARKER_TEXT) throw new Error('DeepSeek desktop directory is not Pocket-owned');
  // Only this dedicated directory is protected. New files inherit its DACL.
  await privateRuntime(root, true);
  const nonce = randomUUID();
  const file = join(root, `host-${input.hostPid}-runtime-${input.runtimePid}-${nonce}.json`);
  const temporary = `${file}.tmp`;
  const payload = JSON.stringify({ version: 1, ...input, url, nonce });
  if (Buffer.byteLength(payload) > 8192) throw new Error('DeepSeek desktop record is too large');
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(payload); } finally { await handle.close(); }
  try { await rename(temporary, file); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return { file, nonce };
}

export async function removeDesktopLink(link) {
  if (!link) return;
  try {
    const stat = await lstat(link.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return;
    const owner = JSON.parse(await readFile(link.file, 'utf8'));
    if (owner.nonce === link.nonce) await unlink(link.file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
