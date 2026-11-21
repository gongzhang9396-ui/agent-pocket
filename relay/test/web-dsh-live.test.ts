import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDshDelta, mergeDshLiveRead } from '../web/src/dsh-live.ts';
import { conversationMessages } from '../web/src/workspace-data.ts';
const detail = () => ({ thread: { id: 'dsh:one', agentId: 'dsh', turns: [] } });
const delta = (text: string, extra = {}) => ({ type: 'message.delta', threadId: 'dsh:one', payload: { itemId: 'dsh-live-a', delta: text, ...extra } });
const texts = (value: any) => conversationMessages(value).map(item => item.text);
test('DSH local stream restores a prefix, appends and removes without duplicate bubbles', () => {
  let value = applyDshDelta(detail(), delta('prefix', { replace: true }));
  value = applyDshDelta(value, delta('-next'));
  assert.deepEqual(texts(value), ['prefix-next']);
  value = applyDshDelta(value, delta('restored', { replace: true }));
  assert.deepEqual(texts(value), ['restored']);
  assert.deepEqual(texts(applyDshDelta(value, delta('', { remove: true }))), []);
});
test('DSH read cannot overwrite newer tokens or resurrect a completed live item', () => {
  const stale = applyDshDelta(detail(), delta('old'));
  const latest = applyDshDelta(stale, delta('-new'));
  assert.deepEqual(texts(mergeDshLiveRead(stale, latest, new Set(['dsh-live-a']))), ['old-new']);
  const removed = applyDshDelta(latest, delta('', { remove: true }));
  assert.deepEqual(texts(mergeDshLiveRead(stale, removed, new Set(['dsh-live-a']))), []);
  assert.deepEqual(texts(mergeDshLiveRead(detail(), latest, new Set())), []);
});
test('DSH deltas are scoped to their exact task and item namespace', () => {
  assert.equal(applyDshDelta({ thread: { ...detail().thread, id: 'dsh:two' } }, delta('x')), undefined);
  assert.equal(applyDshDelta({ thread: { ...detail().thread, agentId: 'codex' } }, delta('x')), undefined);
  assert.equal(applyDshDelta(detail(), delta('x', { itemId: 'codex-item' })), undefined);
});
