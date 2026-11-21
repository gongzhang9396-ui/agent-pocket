import { truncateUtf8 } from './protocol.ts';

const MAX_SUMMARY_BYTES = 32 * 1024;
const TOOLS = new Set(['mcpToolCall', 'dynamicToolCall', 'collabToolCall', 'collabAgentToolCall', 'webSearch', 'imageView', 'contextCompaction',
  'imageGeneration', 'subAgentActivity', 'sleep', 'enteredReviewMode', 'exitedReviewMode']);
const shortText = (value: unknown) => typeof value === 'string' ? truncateUtf8(value, 2048).value : undefined;

/** Projects the documented public summary and tool lifecycle only. Never copy
 * the native reasoning item wholesale: content/encrypted replay stay private.
 * Whole-item snapshots make replay and overlapping history reads idempotent. */
export class PublicActivityStream {
  constructor(emit: (params: Record<string, any>) => void) { this.emit = emit; }
  private readonly emit: (params: Record<string, any>) => void;
  private summaries = new Map<string, string[]>();
  private pending = new Map<string, Record<string, any>>();
  private timer?: ReturnType<typeof setTimeout>;

  accept(message: any) {
    const p = message.params || {};
    const method = message.method;
    const summaryDelta = method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/summaryPartAdded';
    if (!summaryDelta && method !== 'item/reasoning/textDelta') this.flush();
    if (method === 'turn/completed') {
      for (const key of this.summaries.keys()) if (key.startsWith(`${p.threadId}\0${p.turn?.id}\0`)) this.summaries.delete(key);
      return;
    }
    if (typeof p.threadId !== 'string' || typeof p.turnId !== 'string') return;
    const id = summaryDelta ? p.itemId : p.item?.id;
    if (typeof id !== 'string') return;
    const key = `${p.threadId}\0${p.turnId}\0${id}`;
    if (summaryDelta) {
      if (!Number.isSafeInteger(p.summaryIndex) || p.summaryIndex < 0 || p.summaryIndex > 127) return;
      const first = !this.summaries.has(key);
      const parts = [...(this.summaries.get(key) || [])];
      if (method === 'item/reasoning/summaryTextDelta') {
        if (typeof p.delta !== 'string') return;
        parts[p.summaryIndex] = (parts[p.summaryIndex] || '') + truncateUtf8(p.delta, MAX_SUMMARY_BYTES).value;
      } else { parts[p.summaryIndex] ??= ''; }
      const bounded = this.boundedParts(parts);
      if (JSON.stringify(bounded) === JSON.stringify(this.summaries.get(key))) return;
      this.remember(key, bounded);
      const params = { threadId: p.threadId, turnId: p.turnId, item: { id, type: 'reasoning', summary: this.summaries.get(key), status: 'inProgress' } };
      if (first) this.emit(params);
      else { this.pending.set(key, params); this.timer ??= setTimeout(() => this.flush(), 100); }
      return;
    }
    if (method !== 'item/started' && method !== 'item/completed') return;
    const native = p.item;
    const status = shortText(native.status) || (method === 'item/started' ? 'inProgress' : 'completed');
    let item: Record<string, any>;
    if (native.type === 'reasoning') {
      const parts = this.boundedParts(Array.isArray(native.summary) ? native.summary.slice(0, 128).map((part: any) =>
        typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '') : []);
      if (method === 'item/started') this.remember(key, parts); else this.summaries.delete(key);
      item = { id, type: 'reasoning', status, summary: parts };
    } else if (TOOLS.has(native.type)) {
      item = { id, type: native.type, status, server: shortText(native.server), tool: shortText(native.tool),
        query: shortText(native.query ?? native.action?.query ?? native.action?.url), path: shortText(native.path) };
    } else if (native.type === 'plan') {
      item = { id, type: 'plan', status, text: truncateUtf8(typeof native.text === 'string' ? native.text : '', MAX_SUMMARY_BYTES).value };
    } else if (native.type === 'fileChange') {
      item = { id, type: 'fileChange', status, changes: (Array.isArray(native.changes) ? native.changes : []).slice(0, 100)
        .map((change: any) => ({ path: shortText(change.path) })) };
    } else return;
    this.emit({ threadId: p.threadId, turnId: p.turnId, item, complete: method === 'item/completed' });
  }

  private boundedParts(parts: string[]) {
    let remaining = MAX_SUMMARY_BYTES;
    return Array.from(parts.slice(0, 128), part => {
      const value = truncateUtf8(part || '', remaining).value;
      remaining -= Buffer.byteLength(value, 'utf8');
      return value;
    });
  }
  private remember(key: string, parts: string[]) {
    this.summaries.set(key, parts);
    if (this.summaries.size > 128) {
      const oldest = this.summaries.keys().next().value!;
      this.summaries.delete(oldest); this.pending.delete(oldest);
    }
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const values = [...this.pending.values()]; this.pending.clear();
    for (const value of values) this.emit(value);
  }
  close() { this.flush(); this.summaries.clear(); }
}
