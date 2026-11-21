import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicActivityStream } from '../src/public-activity.ts';

const notice = (method: string, params: any) => ({ method, params: { threadId: 'task', turnId: 'turn', ...params } });
test('public summaries coalesce, preserve section order and finish authoritatively', () => {
  const events: any[] = [];
  const stream = new PublicActivityStream(value => events.push(value));
  const delta = (delta: string, summaryIndex = 0) => notice('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex, delta });
  stream.accept(delta('检查'));
  stream.accept(delta('入口'));
  stream.accept(delta('运行检查', 1));
  assert.equal(events.length, 1);
  stream.flush();
  assert.deepEqual(events.at(-1).item.summary, ['检查入口', '运行检查']);
  stream.accept(notice('item/completed', { item: { id: 'r', type: 'reasoning', summary: ['最终摘要'], content: ['PRIVATE'], encrypted_content: 'SECRET' } }));
  assert.deepEqual(events.at(-1).item.summary, ['最终摘要']);
  assert.equal(events.at(-1).item.status, 'completed');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|SECRET/);
  stream.close();
});
test('raw reasoning and tool arguments never enter public activity events', () => {
  const events: any[] = [];
  const stream = new PublicActivityStream(value => events.push(value));
  stream.accept(notice('item/reasoning/textDelta', { itemId: 'r', delta: 'PRIVATE' }));
  stream.accept(notice('item/started', { item: { id: 't', type: 'mcpToolCall', server: 'files', tool: 'read', arguments: { token: 'SECRET' }, result: 'PRIVATE' } }));
  assert.equal(events.length, 1);
  assert.equal(events[0].item.tool, 'read');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|SECRET|arguments|result/);
  stream.close();
});
test('summary traffic and memory are bounded, including malformed section indices', () => {
  const events: any[] = [];
  const stream = new PublicActivityStream(value => events.push(value));
  stream.accept(notice('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: -1, delta: 'bad' }));
  assert.equal(events.length, 0);
  for (let index = 0; index < 100; index++) stream.accept(notice('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: index, delta: '中'.repeat(2000) }));
  stream.accept(notice('turn/completed', { turn: { id: 'turn' } }));
  assert.ok(Buffer.byteLength(events.at(-1).item.summary.join(''), 'utf8') <= 32768);
  stream.close();
});
test('full summaries stop emitting duplicate snapshots and all tool phases are projected', () => {
  const events: any[] = [];
  const stream = new PublicActivityStream(value => events.push(value));
  const delta = (text: string) => notice('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: text });
  stream.accept(delta('x'.repeat(32768)));
  for (let index = 0; index < 10; index++) { stream.accept(delta('overflow')); stream.flush(); }
  assert.equal(events.length, 1);
  for (const type of ['imageGeneration', 'subAgentActivity', 'sleep', 'enteredReviewMode', 'exitedReviewMode']) {
    stream.accept(notice('item/started', { item: { id: type, type, content: 'PRIVATE' } }));
    assert.equal(events.at(-1).item.type, type);
  }
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  stream.close();
});
