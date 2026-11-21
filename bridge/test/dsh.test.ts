import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BridgeStore } from '../src/store.ts';
import { BridgeServer } from '../src/server.ts';
import { DshAgent } from '../src/dsh.ts';
import { RpcError } from '../src/protocol.ts';
import { dshProtocolError } from '../../dsh-bridge-plugin/index.mjs';

class FixtureRuntime extends EventEmitter {
  ready = true; startup = undefined; error = '';
  calls: any[] = []; threads = new Map<string, any>(); accepted = new Set<string>();
  loseCreate = false; loseSend = false; loseAnswer = false;
  busyAfterSend = false;
  requests: any[] = [];
  ensure = async () => {};
  stop = async () => {};
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'probe') return { runtimeVersion: 'fixture', models: [], capabilities: ['approval-waterfall-safe'] };
    if (method === 'list') return { data: [...this.threads.values()] };
    if (method === 'create') {
      const thread = { id: `dsh:${params.sessionId}`, agentId: 'dsh', cwd: params.cwd, execution: { backend: 'dsh', capabilities: { send: true } } };
      this.threads.set(thread.id, thread);
      if (this.loseCreate) throw new RpcError('OPERATION_UNKNOWN', 'lost create acknowledgement');
      return { thread };
    }
    if (method === 'send') {
      this.accepted.add(params.operationId);
      if (this.busyAfterSend) { const error = dshProtocolError({ code: 'session/agent-busy', message: 'native internals' }); throw new RpcError(error.code, error.message); }
      if (this.loseSend) throw new RpcError('OPERATION_UNKNOWN', 'lost send acknowledgement');
      return { threadId: params.threadId, turn: { id: 'dsh-turn-1' } };
    }
    if (method === 'read') return { thread: { ...this.threads.get(params.threadId), turns: [] }, page: { order: 'oldest_first', hasMore: false } };
    if (method === 'operation') return { accepted: this.accepted.has(params.operationId) };
    if (method === 'interactions') return { requests: this.requests, execution: { backend: 'dsh', capabilities: { approval: true, question: true } } };
    if (method === 'respond') { if (this.loseAnswer) throw new RpcError('OPERATION_UNKNOWN', 'lost approval acknowledgement'); return { ok: true }; }
    return { ok: true };
  }
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ap-dsh-server-')), db = join(root, 'bridge.db');
  const store = new BridgeStore(db), runtime = new FixtureRuntime();
  const dsh = new DshAgent(store, [root], { runtime: runtime as any });
  const codex = Object.assign(new EventEmitter(), { readOnly: false, activeTurns: new Map(),
    pinThread: () => assert.fail('DSH must never pin Codex'),
    request: async (method: string) => { if (method === 'model/list') return { data: [] }; assert.fail('DSH must never route to Codex'); } });
  const server = new BridgeServer({ dbPath: db, bindHost: '127.0.0.1', port: 0, projectRoots: [root], codexHome: root, codexCommand: 'unused', minCodexVersion: '1', hostName: 'fixture' },
    store, codex as any, { send: async () => {} } as any, undefined, undefined, dsh);
  return { root, db, store, runtime, dsh, server, rpc: (method: string, params: any = {}) => server.dispatchRelay('phone', method, params),
    close: async () => { await server.stop(); store.close(); } };
}
test('DSH advertises an independent agent and routes standard operationId writes exactly once', async () => {
  const c = setup();
  try {
    assert.ok((await c.rpc('agent/list')).data.some((row: any) => row.id === 'dsh'));
    const params = { agentId: 'dsh', target: 'bridge', cwd: c.root, text: 'first', operationId: 'create-one' };
    const created = await c.rpc('thread/start', params);
    assert.match(created.thread.id, /^dsh:pocket-/); assert.equal(c.store.getOperation('create-one')?.backend, 'dsh');
    assert.deepEqual(await c.rpc('thread/start', params), created);
    assert.equal(c.runtime.calls.filter(c => c.method === 'create').length, 1);
    assert.equal(c.runtime.calls.filter(c => c.method === 'send').length, 1);
    assert.equal(c.runtime.calls.find(c => c.method === 'send')?.params.operationId, 'create-one');
    await assert.rejects(c.rpc('thread/start', { ...params, text: 'different' }), (e: any) => e.nameCode === 'CONFLICT');
    assert.equal((await c.rpc('thread/list', { agentId: 'dsh' })).data.length, 1);
  } finally { await c.close(); }
});
test('DSH rejects Codex-only controls and unknown namespaces before any Codex call', async () => {
  const c = setup();
  try {
    await assert.rejects(c.rpc('goal/set', { threadId: 'dsh:one', objective: 'no', operationId: 'goal' }), /DeepSeek/);
    await assert.rejects(c.rpc('thread/start', { agentId: 'dsh', cwd: c.root, text: 'no', files: [{}], operationId: 'files' }), /附件/);
    await assert.rejects(c.rpc('turn/start', { threadId: 'another:one', text: 'no', operationId: 'unknown' }), /未知 Agent/);
    assert.equal(c.runtime.calls.length, 0);
  } finally { await c.close(); }
});
test('lost DSH send acknowledgement is reconciled by durable requestId without replaying the prompt', async () => {
  const c = setup(); c.runtime.loseSend = true;
  try {
    const params = { agentId: 'dsh', cwd: c.root, text: 'one prompt', operationId: 'lost' };
    await assert.rejects(c.rpc('thread/start', params), (e: any) => e.nameCode === 'OPERATION_UNKNOWN');
    assert.equal(c.store.getOperation('lost')?.status, 'unknown');
    const receipt = await c.rpc('operation/get', { operationId: 'lost' }); assert.equal(receipt.status, 'succeeded');
    assert.equal((await c.rpc('thread/start', params)).thread.id, receipt.result.thread.id);
    assert.equal(c.runtime.calls.filter(c => c.method === 'create').length, 1);
    assert.equal(c.runtime.calls.filter(c => c.method === 'send').length, 1);
  } finally { await c.close(); }
});
test('lost DSH create acknowledgement never sends or creates a replacement session on retry', async () => {
  const c = setup(); c.runtime.loseCreate = true;
  try {
    const params = { agentId: 'dsh', cwd: c.root, text: 'not sent', operationId: 'create-lost' };
    await assert.rejects(c.rpc('thread/start', params), (e: any) => e.nameCode === 'OPERATION_UNKNOWN');
    await c.rpc('operation/get', { operationId: 'create-lost' });
    await assert.rejects(c.rpc('thread/start', params));
    assert.equal(c.runtime.calls.filter(c => c.method === 'create').length, 1);
    assert.equal(c.runtime.calls.filter(c => c.method === 'send').length, 0);
  } finally { await c.close(); }
});
test('native busy after inbox persistence reconciles the accepted continuation without replay', async () => {
  const c = setup(); c.runtime.busyAfterSend = true;
  const threadId = 'dsh:existing';
  c.runtime.threads.set(threadId, { id: threadId, cwd: c.root });
  try {
    const params = { threadId, text: 'one continuation', operationId: 'busy-after-persist' };
    await assert.rejects(c.rpc('turn/start', params), (e: any) => e.nameCode === 'OPERATION_UNKNOWN');
    assert.equal(c.store.getOperation(params.operationId)?.status, 'unknown');
    assert.equal((await c.rpc('operation/get', { operationId: params.operationId })).status, 'succeeded');
    await c.rpc('turn/start', params);
    assert.equal(c.runtime.calls.filter(c => c.method === 'send').length, 1);
    assert.equal(dshProtocolError({ code: 'session/writer-held' }).code, 'THREAD_BUSY_EXTERNAL');
  } finally { await c.close(); }
});
test('DSH pending interactions retain exact type, fingerprint and once-only approval across operations', async () => {
  const c = setup();
  c.runtime.requests = [{ id: 'approval-one', kind: 'approval', threadId: 'dsh:one', fingerprint: 'fp', summary: 'write?' }];
  try {
    const snapshot = await c.rpc('thread/interactions', { threadId: 'dsh:one' }); assert.equal(snapshot.items[0].available, true);
    await assert.rejects(c.rpc('question/respond', { threadId: 'dsh:one', requestId: 'approval-one', answers: {}, operationId: 'wrong-type' }), (e: any) => e.nameCode === 'INVALID_REQUEST');
    await c.rpc('approval/respond', { threadId: 'dsh:one', requestId: 'approval-one', decision: 'allowOnce', operationId: 'answer' });
    assert.equal(c.runtime.calls.find(c => c.method === 'respond')?.params.fingerprint, 'fp');
    await c.rpc('approval/respond', { threadId: 'dsh:one', requestId: 'approval-one', decision: 'allowOnce', operationId: 'answer-again' });
    assert.equal(c.runtime.calls.filter(c => c.method === 'respond').length, 1);
    await assert.rejects(c.rpc('approval/respond', { threadId: 'dsh:one', requestId: 'approval-one', decision: 'deny', operationId: 'conflicting' }), (e: any) => e.nameCode === 'CONFLICT');
  } finally { await c.close(); }
});
test('unknown DSH approval cannot be resubmitted under a new operationId', async () => {
  const c = setup(); c.runtime.loseAnswer = true;
  c.runtime.requests = [{ id: 'approval-unknown', kind: 'approval', threadId: 'dsh:one', fingerprint: 'fp' }];
  try {
    await c.rpc('thread/interactions', { threadId: 'dsh:one' });
    await assert.rejects(c.rpc('approval/respond', { threadId: 'dsh:one', requestId: 'approval-unknown', decision: 'allowOnce', operationId: 'one' }), (e: any) => e.nameCode === 'OPERATION_UNKNOWN');
    await assert.rejects(c.rpc('approval/respond', { threadId: 'dsh:one', requestId: 'approval-unknown', decision: 'allowOnce', operationId: 'two' }), (e: any) => e.nameCode === 'OPERATION_UNKNOWN');
    assert.equal(c.runtime.calls.filter(c => c.method === 'respond').length, 1);
    assert.equal((await c.rpc('thread/interactions', { threadId: 'dsh:one' })).items[0].available, false);
  } finally { await c.close(); }
});
