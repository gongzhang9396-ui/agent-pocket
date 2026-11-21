// Only human-authored input, visible assistant text and tool results cross the
// Pocket boundary. Provider replay state, instructions and reasoning stay local.
const HUMAN = new Set(['user', 'user-rpc', 'user-question-reply']);
export const capabilities = Object.freeze({ send: true, steer: true, interrupt: true, approval: true,
  question: true, attachments: false, plan: false, goal: false, handoff: false });
export const nativeId = id => {
  if (typeof id !== 'string' || !/^dsh:[A-Za-z0-9_-]{1,80}$/.test(id)) throw Object.assign(new Error('DeepSeek 会话标识无效'), { code: 'INVALID_REQUEST' });
  return id.slice(4);
};
export const pocketId = id => `dsh:${id}`;
export const turnId = turn => `dsh-turn-${turn}`;
export const textOf = content => (content || []).map(block => block.type === 'text' ? block.text :
  block.type === 'image' ? '\n[图片附件]' : block.type === 'file' ? '\n[文件附件]' : '').filter(Boolean).join('\n');
export function describe(row, extra = {}) {
  const values = row.projections?.values || {};
  const selection = values.modelSelection?.next || values.modelSelection?.lastUsed;
  const boundary = values.turnBoundary;
  const active = boundary?.openTurnStartSeq != null ? turnId(boundary.lastTurn) : undefined;
  const caps = { ...capabilities, ...extra.capabilities };
  return { id: pocketId(row.sessionId), agentId: 'dsh', source: 'dsh', cwd: row.cwd,
    name: values.title || 'DeepSeek 对话', preview: values.title || '',
    updatedAt: Math.floor(row.updatedAt / 1000), model: selection ? JSON.stringify([selection.provider, selection.model]) : undefined,
    reasoningEffort: selection?.reasoningEffort, activeTurnId: active,
    status: { type: row.running ? 'active' : 'idle', activeFlags: [] },
    execution: { backend: 'dsh', owner: 'shared', capabilities: caps }, capabilities: caps,
    ...extra, ...(active ? { activeTurnId: active } : {}) };
}
export function eventItems(event, derive) {
  if (event.type === 'turn/end' && event.data.reason?.kind && event.data.reason.kind !== 'completed') {
    return [{ id: `dsh-notice-${event.seq}`, type: 'agentMessage', text: event.data.reason.kind === 'aborted' ? '这一轮 DeepSeek 回复已中断。'
      : event.data.reason.kind === 'blocked' ? 'DeepSeek 需要更多信息，请查看问题或在电脑端继续。' : 'DeepSeek 本轮未完成，请在电脑检查登录或模型状态后再继续。' }];
  }
  if (event.surfaceOp !== 'append') return [];
  const message = derive(event);
  if (!message || !['user', 'assistant', 'tool'].includes(message.role)) return [];
  if (message.role === 'user' && !HUMAN.has(message.source?.kind)) return [];
  const text = textOf(message.content);
  if (message.role === 'tool') return [{ id: `dsh-tool-${event.seq}`, type: 'commandExecution',
    command: message.toolCallId || 'DeepSeek 工具', status: message.isError ? 'failed' : 'completed',
    aggregatedOutput: text.slice(0, 32768), truncated: text.length > 32768 }];
  const items = [];
  for (let offset = 0, part = 0; offset < text.length; part++) {
    let end = Math.min(text.length, offset + 8000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const slice = text.slice(offset, end); offset = end;
    items.push({ id: `dsh-message-${event.seq}-${part}`, type: message.role === 'user' ? 'userMessage' : 'agentMessage',
      ...(message.role === 'user' ? { content: [{ type: 'text', text: slice }] } : { text: slice }) });
  }
  return items;
}
export function projectPage(records, derive, cursor, cut, id) {
  const selected = []; let size = 0, next;
  // Cursors name a durable event plus the exclusive item index within it.
  // This also pages a single large assistant message without truncation.
  for (const record of [...records].reverse()) {
    const event = record.event;
    if (cursor && event.seq > cursor.seq) continue;
    const items = eventItems(event, derive);
    const before = cursor?.seq === event.seq ? Math.min(cursor.item, items.length) : items.length;
    for (let item = before - 1; item >= 0; item--) {
      const bytes = Buffer.byteLength(JSON.stringify(items[item])) + 200;
      if (size + bytes > 450 * 1024) { next = { id, cut, seq: event.seq, item: item + 1 }; break; }
      selected.push({ event, item: items[item] }); size += bytes;
    }
    if (next) break;
  }
  const turns = new Map();
  for (const { event, item } of selected.reverse()) {
    const key = turnId(event.data?.turn ?? `message-${event.seq}`);
    const turn = turns.get(key) || { id: key, status: 'completed', items: [] };
    turn.items.push(item); turns.set(key, turn);
  }
  return { turns: [...turns.values()], next };
}
export function modelRows(catalog) {
  return (catalog.groups || []).flatMap(provider => provider.models.map(model => ({
    id: JSON.stringify([provider.id, model.id]), model: JSON.stringify([provider.id, model.id]), agentId: 'dsh',
    displayName: `${model.name} · ${provider.name}`, description: model.description || 'DeepSeek Harness 模型',
    isDefault: catalog.default?.provider === provider.id && catalog.default?.model === model.id,
    defaultReasoningEffort: model.reasoning?.defaultEffort,
    supportedReasoningEfforts: (model.reasoning?.efforts || []).map(e => ({ reasoningEffort: e.id, description: e.name })),
  })));
}
