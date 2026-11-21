import { threadAgentId } from './workspace-data';

const liveId = (id: unknown): id is string => typeof id === 'string' && id.startsWith('dsh-live-') && id.length < 200;
const liveItems = (detail: any): any[] => (detail?.thread?.turns || []).flatMap((turn: any) =>
  (turn.items || []).filter((item: any) => liveId(item.id)));
function replaceItems(detail: any, items: any[]) {
  const turns = (detail.thread.turns || []).map((turn: any) => ({ ...turn,
    items: (turn.items || []).filter((item: any) => !liveId(item.id)) })).filter((turn: any) => turn.id !== 'dsh-local-stream');
  if (items.length) turns.push({ id: 'dsh-local-stream', status: 'live', items });
  return { ...detail, thread: { ...detail.thread, turns } };
}

/** Only live (never replayed) text deltas enter this reducer. Durable history
 * remains authoritative, except for tokens received after its read started. */
export function applyDshDelta(detail: any, event: any) {
  const p = event?.payload;
  if (threadAgentId(detail?.thread) !== 'dsh' || event?.threadId !== detail.thread.id || event.type !== 'message.delta'
    || !liveId(p?.itemId) || typeof p.delta !== 'string') return undefined;
  const items = new Map(liveItems(detail).map(item => [item.id, item]));
  if (p.remove === true) items.delete(p.itemId);
  else items.set(p.itemId, { id: p.itemId, type: 'agentMessage', text: p.replace === true ? p.delta : (items.get(p.itemId)?.text || '') + p.delta });
  return replaceItems(detail, [...items.values()]);
}

export function mergeDshLiveRead(snapshot: any, current: any, changedAfterRead: Set<string>) {
  if (threadAgentId(snapshot?.thread) !== 'dsh' || snapshot.thread.id !== current?.thread?.id || !changedAfterRead.size) return snapshot;
  const items = new Map(liveItems(snapshot).map(item => [item.id, item]));
  const latest = new Map(liveItems(current).map(item => [item.id, item]));
  for (const id of changedAfterRead) { if (latest.has(id)) items.set(id, latest.get(id)); else items.delete(id); }
  return replaceItems(snapshot, [...items.values()]);
}
