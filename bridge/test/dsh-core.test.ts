import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PocketDsh } from '../../dsh-bridge-plugin/core.mjs';
import { eventItems, projectPage } from '../../dsh-bridge-plugin/projection.mjs';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pocket-dsh-')), outside = mkdtempSync(join(tmpdir(), 'pocket-dsh-outside-'));
  const agent = { id: 'one', status: 'idle', session: { header: { cwd: root }, append() {} } };
  const rows: any[] = [{ sessionId: 'one', cwd: root, updatedAt: 1, projections: { values: { title: 'existing' } } }, { sessionId: 'outside', cwd: outside, updatedAt: 2 }];
  const events: any[] = [], calls: any[] = [], selected: any[] = [];
  let now = 1;
  const catalog = { default: { provider: 'local', model: 'model' }, groups: [{ id: 'local', name: 'local', models: [{ id: 'model', name: 'model', reasoning: { efforts: [{ id: 'low', name: '低' }] } }] }] };
  const api: any = {
    list: async () => ({ items: rows }), resolveAgent: async () => ({ agent }),
    modelCatalog: async () => catalog, projections: async () => ({ values: {} }),
    prompt: async (params: any) => { calls.push(params); return { accepted: true }; },
    cancel: () => { calls.push('cancel'); return { accepted: true }; },
    agents: { selectionFor: () => ({ current: { provider: 'local', model: 'model' } }),
      selectForNextRequest: (_: any, selection: any) => selected.push(selection),
      serializeImageAdmission: (_: any, action: any) => action() },
    follow: async function* (_: any, signal: AbortSignal) { yield { type: 'snapshot' }; if (!signal.aborted) await new Promise(r => signal.addEventListener('abort', r, { once: true })); },
  };
  const ctx: any = { sessionController: api, agents: { get: (id: string) => id === agent.id ? agent : undefined },
    sessions: { get: (id: string) => id === agent.id ? agent.session : undefined },
    sessionProjections: { stateOf: () => ({ openTurnStartSeq: 1, lastTurn: 2 }) },
    llm: { resolveCallConfig: async (v: any) => v },
    userQuestions: { answer: () => true }, agentDefaultModel: { saveSelection: () => assert.fail('must never save global model') } };
  const core = new PocketDsh(ctx, [root], { version: '0.2.1-rc.2', derive: (event: any) => event.data.message || event.data },
    (type: string, payload: any) => events.push({ type, ...payload }), { now: () => now, leaseMs: 100, interactionMs: 1000 });
  return { core, root, outside, agent, api, ctx, events, calls, selected, rows, tick: (n = 101) => { now += n; core.expire(); } };
}

test('DSH cold catalog enforces project roots and does not activate Agents', async () => {
  const c = setup(); c.api.resolveAgent = () => assert.fail('cold reads cannot activate');
  try { assert.deepEqual((await c.core.call('list', {})).data.map((r: any) => r.id), ['dsh:one']); }
  finally { c.core.close(); }
});
test('DSH resolves canonical roots and refuses a junction escape', async () => {
  const c = setup();
  try { const link = join(c.root, 'outside'); symlinkSync(c.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => c.core.allowed(link), (e: any) => e.code === 'PATH_DENIED'); }
  finally { c.core.close(); }
});
test('DSH does not claim unwatched or forged Agent approvals', async () => {
  const c = setup(); let delegated = 0;
  try {
    const next = async () => { delegated++; return 'rejected'; };
    assert.equal(await c.core.claim('approval', { agent: c.agent, toolName: 'write' }, next), 'rejected');
    c.core.watch('dsh:one', 'phone');
    assert.equal(await c.core.claim('approval', { agent: { ...c.agent }, toolName: 'write' }, next), 'rejected');
    assert.equal(delegated, 2); assert.equal(c.events.length, 0);
  } finally { c.core.close(); }
});
test('DSH grants only exact one-shot approval; duplicate and conflicting replies are fenced', async () => {
  const c = setup();
  try {
    c.core.watch('dsh:one', 'phone');
    const wait = c.core.claim('approval', { agent: c.agent, toolName: 'write', reason: 'one write' }, () => assert.fail('claimed request delegated'));
    await new Promise(setImmediate);
    const request = c.events.find(e => e.type === 'approval.request');
    const params = { threadId: 'dsh:one', requestId: request.id, fingerprint: request.fingerprint, decision: 'allowOnce' };
    await assert.rejects(c.core.respond({ ...params, fingerprint: 'wrong' }), (e: any) => e.code === 'INVALID_REQUEST');
    await assert.rejects(c.core.respond({ ...params, decision: 'alwaysAllow' }), (e: any) => e.code === 'INVALID_REQUEST');
    await c.core.respond(params); assert.equal(await wait, 'allowed-once');
    assert.equal((await c.core.respond(params)).duplicate, true);
    await assert.rejects(c.core.respond({ ...params, decision: 'deny' }), (e: any) => e.code === 'CONFLICT');
  } finally { c.core.close(); }
});
test('DSH claimed approval fails closed after lease expiry and never delegates', async () => {
  const c = setup();
  try { c.core.watch('dsh:one', 'phone'); const wait = c.core.claim('approval', { agent: c.agent, toolName: 'write' }, () => assert.fail('cannot delegate after claim'));
    await new Promise(setImmediate);
    c.tick(); assert.equal(await wait, 'unavailable'); assert.equal(c.core.pending.size, 0); }
  finally { c.core.close(); }
});
test('old unwatch cannot remove a newer view lease', async () => {
  const c = setup();
  try { c.core.watch('dsh:one', 'phone', 'old'); c.core.watch('dsh:one', 'phone', 'new');
    await c.core.call('unwatch', { threadId: 'dsh:one', deviceId: 'phone', leaseId: 'old' }); assert.equal(c.core.liveView('one'), true); }
  finally { c.core.close(); }
});
test('an unwatch tombstone prevents a delayed watch from reviving a closed view', async () => {
  const c = setup(); let release: (() => void) | undefined;
  c.api.list = () => new Promise(resolve => { release = () => resolve({ items: c.rows }); });
  try {
    const late = c.core.call('watch', { threadId: 'dsh:one', deviceId: 'phone', leaseId: 'old' });
    await c.core.call('unwatch', { threadId: 'dsh:one', deviceId: 'phone', leaseId: 'old' });
    release!(); await late; assert.equal(c.core.liveView('one'), false);
    c.core.watch('dsh:one', 'phone', 'new'); assert.equal(c.core.liveView('one'), true);
  } finally { c.core.close(); }
});
test('DSH durable operation receipts use the real user source rpcId', async () => {
  const c = setup(); c.core.snapshot = async () => ({ cursor: 3 });
  c.api.page = async () => ({ records: [{ event: { type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'user', rpcId: 'original' } }] } } }], hasMore: false });
  try { assert.deepEqual(await c.core.findOperation({ threadId: 'dsh:one', operationId: 'original' }), { accepted: true });
    assert.deepEqual(await c.core.findOperation({ threadId: 'dsh:one', operationId: 'another' }), { accepted: false }); }
  finally { c.core.close(); }
});

test('a failed follow allocation cannot leave an approval view lease behind', async () => {
  const c = setup();
  try {
    for (let i = 0; i < 16; i++) { c.core.follows.set(`occupied-${i}`, new AbortController()); c.core.watch(`dsh:occupied-${i}`, 'phone', 'live'); }
    await assert.rejects(c.core.call('watch', { threadId: 'dsh:one', deviceId: 'phone', leaseId: 'new' }), (e: any) => e.code === 'THREAD_BUSY');
    assert.equal(c.core.liveView('one'), false);
    assert.equal(await c.core.claim('approval', { agent: c.agent }, async () => 'rejected'), 'rejected');
  } finally { c.core.close(); }
});
test('DSH binds catalog and live Agent to the same canonical project', async () => {
  const c = setup(), second = join(c.root, 'second'); mkdirSync(second);
  try {
    c.agent.session.header.cwd = second;
    await assert.rejects(c.core.send({ threadId: 'dsh:one', operationId: 'mismatch', text: 'no' }), (e: any) => e.code === 'THREAD_BUSY_EXTERNAL');
    c.core.watch('dsh:one', 'phone');
    assert.equal(await c.core.claim('approval', { agent: c.agent }, async () => 'rejected'), 'rejected'); assert.equal(c.calls.length, 0);
  } finally { c.core.close(); }
});
test('DSH abort and runtime disconnect settle live questions without answering them', async () => {
  const c = setup(), abort = new AbortController();
  c.core.watch('dsh:one', 'phone');
  const wait = c.core.claim('question', { agent: c.agent, questions: [{ id: 'q', question: '?' }], signal: abort.signal }, () => assert.fail('delegated'));
  await new Promise(setImmediate);
  abort.abort(); await assert.rejects(wait, (e: any) => e.code === 'ASK_CANCELLED');
  const second = c.core.claim('approval', { agent: c.agent, toolName: 'write' }, () => assert.fail('delegated'));
  await new Promise(setImmediate);
  c.core.close(); assert.equal(await second, 'unavailable');
});
test('DSH questions preserve option labels and free text, rejecting incomplete batches', async () => {
  const c = setup();
  try {
    const questions = [{ id: 'q', question: '?', options: [{ label: 'yes' }] }];
    assert.deepEqual(c.core.answerQuestions(questions, { q: { answers: ['yes'] } }), { answers: [{ id: 'q', selected: ['yes'] }] });
    assert.deepEqual(c.core.answerQuestions(questions, { q: { answers: ['custom'] } }), { answers: [{ id: 'q', selected: [], custom: 'custom' }] });
    assert.throws(() => c.core.answerQuestions(questions, {}), (e: any) => e.code === 'INVALID_REQUEST');
  } finally { c.core.close(); }
});
test('DSH model selection is local, validated and fenced on unsupported versions', async () => {
  const c = setup();
  try {
    await c.core.send({ threadId: 'dsh:one', operationId: 'op', deviceId: 'phone', text: 'hi', model: '["local","model"]', effort: 'low' });
    assert.deepEqual(c.selected, [{ provider: 'local', model: 'model', reasoningEffort: 'low' }]); assert.equal(c.calls[0].requestId, 'op');
    await assert.rejects(c.core.select(c.agent, '["local","missing"]'), (e: any) => e.code === 'INVALID_REQUEST');
    c.core.localModels = false;
    await assert.rejects(c.core.select(c.agent, '["local","model"]'), (e: any) => e.code === 'VERSION_UNSUPPORTED');
  } finally { c.core.close(); }
});
test('DSH interrupt and steer reject a stale turn without cancelling new work', async () => {
  const c = setup();
  try {
    await assert.rejects(c.core.interrupt({ threadId: 'dsh:one', turnId: 'dsh-turn-1' }), (e: any) => e.code === 'THREAD_BUSY_EXTERNAL');
    await assert.rejects(c.core.send({ threadId: 'dsh:one', operationId: 'op', deviceId: 'phone', text: 'hi', mode: 'steer', expectedTurnId: 'dsh-turn-1' }), (e: any) => e.code === 'THREAD_BUSY_EXTERNAL');
    assert.equal(c.calls.length, 0);
  } finally { c.core.close(); }
});
test('DSH history includes only visible user/assistant text, excludes private context and reasoning', () => {
  const derive = (e: any) => e.data;
  assert.deepEqual(eventItems({ seq: 1, surfaceOp: 'append', data: { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'PRIVATE' }] } }, derive), []);
  const items = eventItems({ seq: 2, surfaceOp: 'append', data: { role: 'assistant', source: { kind: 'model', replayState: 'SECRET' }, content: [{ type: 'text', text: 'visible' }, { type: 'reasoning', text: 'PRIVATE' }] } }, derive);
  assert.equal(items[0].text, 'visible'); assert.doesNotMatch(JSON.stringify(items), /PRIVATE|SECRET/);
});
test('one large Unicode DSH message pages completely without truncation or split surrogates', () => {
  const text = 'hello😀世界'.repeat(18000), event = { seq: 7, surfaceOp: 'append', data: { turn: 1, role: 'assistant', content: [{ type: 'text', text }] } };
  const derive = (e: any) => e.data; const parts: any[] = []; let cursor;
  do { const page = projectPage([{ event }], derive, cursor, 7, 'dsh:one'); parts.unshift(...page.turns.flatMap((t: any) => t.items)); cursor = page.next; } while (cursor);
  assert.equal(parts.map(i => i.text).join(''), text); assert.equal(new Set(parts.map(i => i.id)).size, parts.length);
});
