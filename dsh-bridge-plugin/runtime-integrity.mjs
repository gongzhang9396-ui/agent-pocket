import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { privateRuntime } from './private-runtime.mjs';

export const DSH_VERSION = '0.2.1-rc.2';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function inventory(root) {
  const files = {};
  const paths = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(path);
        if (!target.startsWith(resolve(root, 'node_modules') + sep)) throw new Error('DSH runtime link leaves its installation');
        files[relative(root, path).replaceAll('\\', '/')] = 'link:' + relative(root, target).replaceAll('\\', '/');
        continue; // npm .bin aliases are never used to launch this runtime.
      }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error('Unexpected DSH runtime file type');
    }
  }
  await walk(join(root, 'node_modules'));
  let next = 0;
  await Promise.all(Array.from({ length: 24 }, async () => {
    while (next < paths.length) {
      const path = paths[next++], digest = createHash('sha256');
      for await (const bytes of createReadStream(path)) digest.update(bytes);
      files[relative(root, path).replaceAll('\\', '/')] = digest.digest('hex');
    }
  }));
  files['package-lock.json'] = hash(await readFile(join(root, 'package-lock.json')));
  return files;
}
export async function sealFreshInstall(root) {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  for (const pkg of Object.values(lock.packages ?? {})) {
    if (pkg.resolved && (!pkg.resolved.startsWith('https://registry.npmjs.org/') || !pkg.integrity?.startsWith('sha512-'))) {
      throw new Error('DSH dependencies must come from integrity-checked npm registry tarballs');
    }
  }
  const manifest = { version: 1, dshVersion: DSH_VERSION, files: await inventory(root) };
  await writeFile(join(root, 'pocket-runtime.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  return manifest;
}
export async function verifyRuntime(root) {
  await privateRuntime(root);
  const status = await lstat(root);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('DSH runtime must be a real installation directory');
  const manifest = JSON.parse(await readFile(join(root, 'pocket-runtime.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.dshVersion !== DSH_VERSION || !manifest.files) throw new Error('DSH runtime integrity metadata is incompatible');
  const actual = await inventory(root);
  const entries = Object.entries(actual);
  if (entries.length !== Object.keys(manifest.files).length || entries.some(([path, digest]) => manifest.files[path] !== digest)) {
    throw new Error('DSH runtime was modified; prepare a new verified installation');
  }
  const cli = join(root, 'node_modules', '@deepseek-ai', 'dsh');
  const pkg = JSON.parse(await readFile(join(cli, 'package.json'), 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh' || pkg.version !== DSH_VERSION) throw new Error('Unsupported DSH runtime version');
  return { cli, version: DSH_VERSION };
}
