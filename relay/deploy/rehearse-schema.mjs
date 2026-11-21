// Run only against a private, consistent copy. Never pass the live database.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [snapshot, working, oldModule, newModule] = process.argv.slice(2);
assert(snapshot && working && oldModule && newModule && snapshot !== working);
assert(!existsSync(working), "working copy must be new");
function fingerprint(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const values = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().filter(row => !(name === "meta" && row.key === "schemaVersion"));
    values[name] = { rows: rows.length, hash: createHash("sha256").update(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())).digest("hex") };
  }
  const version = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get().value;
  db.close(); return { values, version };
}
const before = fingerprint(snapshot); assert.equal(before.version, "2");
copyFileSync(snapshot, working);
const { RelayStore: NewStore } = await import(pathToFileURL(newModule).href);
new NewStore(working).close();
const upgraded = fingerprint(working); assert.equal(upgraded.version, "3");
for (const [name, value] of Object.entries(before.values)) assert.deepEqual(upgraded.values[name], value, `legacy rows changed: ${name}`);
new NewStore(working).close(); assert.deepEqual(fingerprint(working), upgraded, "repeated migration changed rows");
const { RelayStore: OldStore } = await import(pathToFileURL(oldModule).href);
assert.throws(() => new OldStore(working), /schema|版本/i);
for (const suffix of ["", "-wal", "-shm"]) rmSync(working + suffix, { force: true });
copyFileSync(snapshot, working); new OldStore(working).close();
assert.deepEqual(fingerprint(working), before, "old binary cannot restore its exact schema/rows");
console.log(JSON.stringify({ ok: true, from: 2, to: 3, legacyTablesVerified: Object.keys(before.values).length, restoredWithOldStore: true, integrity: "ok" }));
