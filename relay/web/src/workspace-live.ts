import { applyDshDelta, mergeDshLiveRead } from './dsh-live';
import { finishedStatus, itemActivity, runningStatus } from './thread-activity';

export function eventItemKey(event: any): string | undefined {
  if (event?.type === 'turn.status' && typeof event.turnId === 'string') return `turn:${event.turnId}`;
  const id = event?.payload?.item?.id ?? event?.payload?.itemId;
  if (typeof id === 'string') return id;
  if (event?.type === 'plan.updated' && typeof event.turnId === 'string') return `pocket-plan-${event.turnId}`;
  return undefined;
}

export function applyWorkspaceEvent(detail: any, event: any) {
  if (!detail?.thread || event?.threadId !== detail.thread.id) return undefined;
  const dsh = applyDshDelta(detail, event);
  if (dsh) return dsh;
  const p = event.payload || {};
  const id = eventItemKey(event);
  if (!id) return undefined;
  const turns = (detail.thread.turns || []).map((turn: any) => ({ ...turn, items: [...(turn.items || [])] }));
  let turn = turns.find((turn: any) => turn.id === event.turnId);
  if (!turn && typeof event.turnId === 'string') {
    turn = { id: event.turnId, status: 'inProgress', items: [] };
    if (detail.page?.order === 'newest_first') turns.unshift(turn); else turns.push(turn);
  }
  if (!turn) return undefined;
  if (event.type === 'turn.status') {
    if (!runningStatus(p.status) && !finishedStatus(p.status)) return undefined;
    turn.status = p.status;
    return { ...detail, thread: { ...detail.thread, status: runningStatus(p.status) ? 'active' : 'idle', turns } };
  }
  const index = turn.items.findIndex((item: any) => item.id === id);
  const previous = turn.items[index];
  let item: any;
  if (event.type === 'activity.updated' && itemActivity(p.item)) item = p.item;
  if (event.type === 'command.updated') {
    if (p.item) item = { ...previous, ...p.item, aggregatedOutput: p.item.aggregatedOutput ?? previous?.aggregatedOutput ?? '' };
    else if (typeof p.delta === 'string') item = { ...previous, id, type: 'commandExecution', status: previous?.status || 'inProgress',
      aggregatedOutput: (previous?.aggregatedOutput || '') + p.delta };
  }
  if (event.type === 'plan.updated' && Array.isArray(p.plan)) item = { id, type: 'plan', explanation: p.explanation, plan: p.plan };
  if (event.type === 'message.delta' && typeof p.delta === 'string' && !id.startsWith('dsh-live-')) {
    item = { id, type: p.role === 'user' ? 'userMessage' : p.itemType === 'plan' || previous?.type === 'plan' ? 'plan' : 'agentMessage',
      text: p.replace ? p.delta : (previous?.text || '') + p.delta };
    if (item.type === 'userMessage') item.content = [{ type: 'text', text: item.text }];
  }
  if (!item) return undefined;
  if (p.remove === true) { if (index >= 0) turn.items.splice(index, 1); }
  else if (index >= 0) turn.items[index] = item;
  else turn.items.push(item);
  return { ...detail, thread: { ...detail.thread, turns } };
}

/** History is authoritative. Protect only events that arrived after the read
 * began, plus the structured plan which is an event-only projection. */
export function mergeWorkspaceRead(snapshot: any, current: any, changed: Set<string>) {
  if (snapshot?.thread?.id !== current?.thread?.id) return snapshot;
  const result = mergeDshLiveRead(snapshot, current, changed);
  const turns = (result.thread.turns || []).map((turn: any) => ({ ...turn, items: [...(turn.items || [])] }));
  let terminalProtected = false;
  for (const latest of current.thread.turns || []) {
    let turn = turns.find((turn: any) => turn.id === latest.id);
    const items = (latest.items || []).filter((item: any) => !item.id?.startsWith('dsh-live-') &&
      (changed.has(item.id) || item.id?.startsWith('pocket-plan-')));
    const statusChanged = changed.has(`turn:${latest.id}`);
    if (!turn && (items.length || statusChanged)) {
      turn = { ...latest, items: [] };
      if (result.page?.order === 'newest_first') turns.unshift(turn); else turns.push(turn);
    }
    if (!turn) continue;
    const keepTerminal = finishedStatus(latest.status) && runningStatus(turn.status);
    if (statusChanged || keepTerminal) turn.status = latest.status;
    terminalProtected ||= keepTerminal;
    for (const item of items) {
      const index = turn.items.findIndex((row: any) => row.id === item.id);
      if (index < 0) turn.items.push(item); else turn.items[index] = item;
    }
  }
  let threadStatus = [...changed].some(key => key.startsWith('turn:')) ? current.thread.status : result.thread.status;
  if (terminalProtected && !turns.some((turn: any) => runningStatus(turn.status))) threadStatus = 'idle';
  return { ...result, thread: { ...result.thread, status: threadStatus, turns } };
}
