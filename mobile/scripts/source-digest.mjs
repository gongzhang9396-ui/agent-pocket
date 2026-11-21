import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Release source cannot contain symbolic links');
    const full = join(path, entry.name);
    if (entry.isDirectory()) await walk(full); else if (entry.isFile()) {
      // Flutter regenerates this from pubspec.lock and build mode, including
      // integration_test only for debug tests. It is not hand-written source.
      if (relative(mobile, full).replaceAll('\\', '/') !== 'android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java') files.push(full);
    }
  }
}
for (const folder of ['lib', 'assets', 'scripts', 'android/app/src/main']) await walk(join(mobile, folder));
for (const file of ['pubspec.yaml', 'pubspec.lock', 'android/app/build.gradle.kts', 'android/app/proguard-rules.pro', 'android/settings.gradle.kts', 'android/build.gradle.kts', 'android/gradle.properties', 'android/gradlew', 'android/gradlew.bat', 'android/gradle/wrapper/gradle-wrapper.jar', 'android/gradle/wrapper/gradle-wrapper.properties']) files.push(join(mobile, file));
const digest = createHash('sha256');
const inventory = [];
for (const file of files.sort((left, right) => relative(mobile, left).localeCompare(relative(mobile, right), 'en'))) {
  const hash = createHash('sha256').update(await readFile(file)).digest('hex');
  const path = relative(mobile, file).replaceAll('\\', '/');
  digest.update(`${hash}  ${path}\n`, 'utf8'); inventory.push({ path, sha256: hash });
}
console.log(JSON.stringify({ sourceDigest: digest.digest('hex'), files: inventory }, null, 2));
