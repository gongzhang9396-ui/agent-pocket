import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationMessages } from '../web/src/workspace-data.ts';
import { currentProgress, itemActivity } from '../web/src/thread-activity.ts';
import { applyWorkspaceEvent, mergeWorkspaceRead } from '../web/src/workspace-live.ts';

const detail = () => ({ thread: { id: 'task', status: 'active', turns: [{ id: 'turn', status: 'inProgress', items: [] as any[] }] } });
const event = (type: string, payload: any, turnId = 'turn') => ({ threadId: 'task', turnId, type, payload });

test('history displays public summaries, plans and tools without exposing raw reasoning', () => {
  const value = detail();
  value.thread.turns[0].items = [
    { id: 'r', type: 'reasoning', summary: ['检查入口', { text: '定位失败请求' }], content: ['PRIVATE'], encryptedContent: 'SECRET' },
    { id: 'p', type: 'plan', text: '检查并修复' },
    { id: 't', type: 'mcpToolCall', tool: 'read_file', status: 'inProgress', arguments: { secret: 'ARGUMENT' } },
  ];
  const rows = conversationMessages(value);
  assert.deepEqual(rows.map(row => row.activity?.title), ['思考摘要', '执行计划', '调用工具']);
  assert.equal(rows[0].text, '检查入口\n\n定位失败请求');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|SECRET|ARGUMENT/);
  assert.equal(itemActivity({ type: 'reasoning', content: ['PRIVATE'] })?.text, '');
  assert.equal(currentProgress(value)?.text, 'read_file');
});

test('activity snapshots replace by stable identity, scoped to task and turn', () => {
  const update = (text: string) => event('activity.updated', { item: { id: 'r', type: 'reasoning', summary: [text], status: 'inProgress' } });
  let value = applyWorkspaceEvent(detail(), update('检查'));
  value = applyWorkspaceEvent(value, update('检查入口'));
  assert.equal(conversationMessages(value).length, 1);
  assert.equal(conversationMessages(value)[0].text, '检查入口');
  assert.equal(applyWorkspaceEvent(value, { ...update('其他'), threadId: 'other' }), undefined);
  const merged = mergeWorkspaceRead(detail(), value, new Set(['r']));
  assert.equal(conversationMessages(merged)[0].text, '检查入口');
  assert.equal(conversationMessages(mergeWorkspaceRead(detail(), value, new Set())).length, 0);
});

test('command output survives lifecycle updates and plans update in place', () => {
  let value = applyWorkspaceEvent(detail(), event('command.updated', { item: { id: 'c', type: 'commandExecution', command: 'npm test', status: 'inProgress' } }));
  value = applyWorkspaceEvent(value, event('command.updated', { itemId: 'c', delta: 'passed' }));
  value = applyWorkspaceEvent(value, event('command.updated', { item: { id: 'c', type: 'commandExecution', status: 'completed' } }));
  assert.equal(conversationMessages(value)[0].text, 'npm test\npassed');
  const plan = (status: string) => event('plan.updated', { plan: [{ step: '运行检查', status }] });
  value = applyWorkspaceEvent(value, plan('inProgress'));
  assert.equal(currentProgress(value)?.text, '运行检查');
  value = applyWorkspaceEvent(value, plan('completed'));
  assert.equal(conversationMessages(value).length, 2);
  const merged = mergeWorkspaceRead(detail(), value, new Set());
  assert.match(conversationMessages(merged)[0].text, /✓ 运行检查/);
});

test('completion beats a history read started before the terminal event', () => {
  const done = applyWorkspaceEvent(detail(), event('turn.status', { status: 'completed' }));
  assert.equal(currentProgress(done), undefined);
  assert.equal(currentProgress(mergeWorkspaceRead(detail(), done, new Set(['turn:turn']))), undefined);
  assert.equal(currentProgress(mergeWorkspaceRead(detail(), done, new Set())), undefined);
  const failed = applyWorkspaceEvent(detail(), event('turn.status', { status: 'failed' }));
  assert.equal(currentProgress(failed), undefined);
});

test('newest-first history, waiting interactions and empty summary have honest progress', () => {
  const value = { ...detail(), page: { order: 'newest_first' } };
  value.thread.turns[0].items = [{ id: 'r', type: 'reasoning', summary: [], content: ['PRIVATE'] }];
  assert.equal(currentProgress(value)?.text, '等待电脑传回下一步进展');
  assert.equal(currentProgress(value, [{ type: 'pocketApproval', available: true, summary: '允许读取文件' }])?.title, '等待你批准');
  value.thread.turns[0].status = 'completed'; value.thread.status = 'idle';
  assert.equal(currentProgress(value), undefined);
});
