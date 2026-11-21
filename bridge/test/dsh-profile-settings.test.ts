import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { profileSettings, readProfileSettings } from '../../dsh-bridge-plugin/profile-settings.mjs';
import { prepareDshProfile } from '../src/dsh-runtime.ts';

const model = { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' } };
const providers = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { openai: { apiKeyEnv: 'POCKET_DSH_TEST_KEY' } } } };
const welcome = { id: 'ui-settings-general', name: '@deepseek-ai/dsh-client-ui-settings-general', config: { welcomeNoticeVersion: '2026-09-28.1' } };
async function fixture(t: any) {
  const base = await mkdtemp(join(tmpdir(), 'pocket-dsh-settings-test-'));
  t.after(async () => { const path = resolve(base); assert.ok(path.startsWith(resolve(tmpdir()) + sep) && path.includes('pocket-dsh-settings-test-')); await rm(path, { recursive: true, force: true }); });
  const home = join(base, 'home'), runtime = join(base, 'runtime');
  await mkdir(join(runtime, 'node_modules'), { recursive: true }); await mkdir(join(home, 'profiles/web'), { recursive: true });
  return { base, home, runtime, native: join(home, 'profiles/web/cordis.patch.yml'), local: join(home, 'profiles/agent-pocket/cordis.patch.yml') };
}
test('DSH imports official model settings without importing plugin composition or approvals', () => {
  const rows = profileSettings([model, providers, welcome, { id: 'approval', config: { policy: 'auto' } }, { insert: [{ id: 'purge' }] }]);
  assert.deepEqual(rows.map(row => row.id), ['agent-default-model', 'llm-pi-ai', 'ui-settings-general']);
  assert.ok(rows.every(row => !Object.hasOwn(row, 'name')));
  assert.equal(rows[1].config.providers.openai.apiKeyEnv, 'POCKET_DSH_TEST_KEY');
  for (const row of [{ ...model, name: 'foreign-module' }, { ...model, insert: [] }, { ...model, disabled: false },
    { ...providers, config: { providers: { openai: { apiKey: 'raw' } } } }, { ...welcome, config: { script: 'no' } }]) assert.throws(() => profileSettings([row], true));
  assert.throws(() => profileSettings([model, model]));
  assert.throws(() => profileSettings([{ id: 'approval', config: {} }], true));
  assert.throws(() => profileSettings([{ ...providers, config: JSON.parse('{"providers":{"__proto__":{}}}') }]));
  const cycle: any = {}; cycle.nested = cycle;
  assert.throws(() => profileSettings([{ ...providers, config: cycle }]));
});
test('DSH keeps native settings untouched and supports persisted official Pocket UI settings across restarts', async t => {
  const f = await fixture(t), source = JSON.stringify([model, providers, welcome]);
  await writeFile(f.native, source);
  const patch = await prepareDshProfile(f.home, f.runtime);
  let rows = JSON.parse(await readFile(patch, 'utf8'));
  assert.equal(rows.find((row: any) => row.id === 'agent-default-model').config.model, 'gpt-6.1-sol');
  assert.equal(rows.find((row: any) => row.id === 'approval').config.policy, 'ask');
  await writeFile(f.local, JSON.stringify([welcome, { ...model, config: { provider: 'openai', model: 'user-choice' } }]));
  await prepareDshProfile(f.home, f.runtime);
  rows = JSON.parse(await readFile(patch, 'utf8'));
  assert.equal(rows.find((row: any) => row.id === 'agent-default-model').config.model, 'user-choice');
  assert.ok(rows.find((row: any) => row.id === 'llm-pi-ai').config.providers.openai);
  assert.equal(await readFile(f.native, 'utf8'), source);
  const unsafe = JSON.stringify([{ id: 'approval', config: { policy: 'auto' } }]);
  await writeFile(f.local, unsafe); await assert.rejects(prepareDshProfile(f.home, f.runtime), /已更改/);
  assert.equal(await readFile(f.local, 'utf8'), unsafe);
});
test('DSH rejects unsafe or malformed YAML without echoing credential-bearing diagnostics', { skip: !process.env.AGENT_POCKET_DSH_TEST_RUNTIME }, async t => {
  const f = await fixture(t), runtime = process.env.AGENT_POCKET_DSH_TEST_RUNTIME!;
  await writeFile(f.native, '- id: llm-pi-ai\n  config:\n    providers:\n      openai:\n        apiKeyEnv: POCKET_DSH_TEST_KEY\n');
  assert.equal((await readProfileSettings(f.native, runtime))[0].config.providers.openai.apiKeyEnv, 'POCKET_DSH_TEST_KEY');
  for (const source of ['- id: llm-pi-ai\n  config: !!js/function "function(){ return \'SECRET_TEST_VALUE\' }"',
    '- id: llm-pi-ai\n  config: &a {providers: *a}', '- id: llm-pi-ai\n  config: {providers: {}, providers: {SECRET_TEST_VALUE: {}}}']) {
    await writeFile(f.native, source);
    await assert.rejects(readProfileSettings(f.native, runtime), (error: any) => !error.message.includes('SECRET_TEST_VALUE'));
  }
});
