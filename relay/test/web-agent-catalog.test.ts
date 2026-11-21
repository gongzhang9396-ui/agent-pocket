import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTaskCatalog } from '../web/src/task-catalog.ts';
import { agentName, threadCapabilities } from '../web/src/workspace-data.ts';
import { verifiedReceipt } from '../web/src/pending-writes.ts';

test('web loads each advertised Agent independently and includes older DSH pages', async () => {
  const calls: any[] = [];
  const catalog = await loadTaskCatalog({}, async (method, params) => {
    calls.push({ method, params });
    if (method === 'agent/list') return { data: [{ id: 'codex' }, { id: 'dsh' }] };
    if (params.agentId === 'codex') return { data: [{ id: 'codex', updatedAt: 2 }] };
    return params.cursor ? { data: [{ id: 'dsh:older', updatedAt: 1 }] } : { data: [{ id: 'dsh:newer', updatedAt: 3 }], nextCursor: 'older' };
  });
  assert.deepEqual(catalog.data.map(row => row.id), ['dsh:newer', 'codex', 'dsh:older']);
  assert.equal(calls.length, 4);
  assert.equal(agentName(catalog.data[0]), 'DeepSeek');
});
test('DSH identity never inherits Codex permissions even with a bridge source', () => {
  const task = { id: 'dsh:a', agentId: 'dsh', source: 'bridge' };
  assert.equal(agentName(task), 'DeepSeek');
  assert.equal(threadCapabilities(task).attachments, false); assert.equal(threadCapabilities(task).steer, false);
  assert.equal(agentName({ id: 'dsh:a' }), 'DeepSeek');
});
test('legacy web Host fallback omits agentId and cursor loops fail visibly', async () => {
  await loadTaskCatalog({}, async (method, params) => {
    if (method === 'agent/list') throw Object.assign(new Error('unknown method'), { code: -32601 });
    if (method === 'model/list') return { data: [] };
    assert.equal(params.agentId, undefined); return { data: [] };
  });
  await assert.rejects(loadTaskCatalog({}, async (method) => method === 'agent/list' ? { data: [{ id: 'dsh' }] } : { data: [], nextCursor: 'same' }), /游标/);
});
test('catalog refuses cross-agent namespace collisions and receipts retain their operation identity', async () => {
  await assert.rejects(loadTaskCatalog({}, async method => method === 'agent/list'
    ? { data: [{ id: 'codex' }, { id: 'dsh' }] } : { data: [{ id: 'same' }] }), /任务标识/);
  await assert.rejects(loadTaskCatalog({}, async method => method === 'agent/list'
    ? { data: [{ id: 'codex' }] } : { data: [{ id: 'dsh:one' }] }), /任务标识/);
  assert.throws(() => verifiedReceipt({ operationId: 'other', status: 'succeeded' }, 'original'), /回执不匹配/);
  assert.equal(verifiedReceipt({ operationId: 'original', status: 'unknown' }, 'original').status, 'unknown');
});
