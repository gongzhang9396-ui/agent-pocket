import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DshRuntime } from './dsh-runtime.ts';
import type { BridgeStore, OperationRecord } from './store.ts';
import { assertAllowedCwd } from './config.ts';
import { newEvent, RpcError } from './protocol.ts';

const caps = { send: true, steer: true, interrupt: true, approval: true, question: true, attachments: false, plan: false, goal: false, handoff: false };
export class DshAgent extends EventEmitter {
  runtime: DshRuntime;
  store: BridgeStore;
  roots: string[];
  active = new Map<string, boolean>();
  statusVersions = new Map<string, number>();
  snapshots = new Map<string, { at: number; search?: string; rows: any[] }>();
  lastPrepareAt = 0;
  constructor(store: BridgeStore, roots: string[], options: { runtimeRoot?: string; home?: string; runtime?: DshRuntime } = {}) {
    super(); this.store = store; this.roots = roots; this.runtime = options.runtime || new DshRuntime(roots, options);
    this.runtime.on('ready', () => this.emit('event', newEvent('sync.required', { source: 'dsh', reason: 'dsh-ready' })));
    this.runtime.on('offline', () => { this.active.clear(); this.emit('event', newEvent('sync.required', { source: 'dsh', reason: 'dsh-offline' })); });
    this.runtime.on('event', event => {
      if (event?.type === 'dsh.status') { this.statusVersions.set(event.threadId, (this.statusVersions.get(event.threadId) || 0) + 1); if (event.running) this.active.set(event.threadId, true); else this.active.delete(event.threadId); }
      if (event?.type === 'approval.request' || event?.type === 'question.request') this.remember([event]);
      const { type, ...payload } = event;
      this.emit('event', newEvent(type === 'dsh.status' ? 'sync.required' : type, { source: 'dsh', ...payload }));
    });
  }
  prepare() { if (Date.now() - this.lastPrepareAt < 30000) return; this.lastPrepareAt = Date.now(); void this.runtime.ensure().catch(() => undefined); }
  async probe() {
    if (!this.runtime.ready) { this.prepare(); return { id: 'dsh', name: 'DeepSeek', available: false, preparing: Boolean(this.runtime.startup), capabilities: { ...caps, send: false, approval: false, question: false }, models: [], error: this.runtime.error }; }
    try {
      const probe = await this.runtime.request('probe', {});
      return { id: 'dsh', name: 'DeepSeek', available: true, version: probe.runtimeVersion,
        capabilities: { ...caps, approval: probe.capabilities?.includes('approval-waterfall-safe') === true, question: probe.capabilities?.includes('questions-v1') === true }, models: probe.models };
    } catch { return { id: 'dsh', name: 'DeepSeek', available: false, capabilities: { ...caps, send: false, approval: false, question: false }, models: [], error: 'DeepSeek 模型目录暂不可用，请检查电脑上的登录和模型配置' }; }
  }
  async ready() { await this.runtime.ensure(); }
  assertInput(params: any) {
    if (params.images?.length || params.files?.length || params.attachmentIds?.length || params.mode || params.goal || (params.target && params.target !== 'bridge')) {
      throw new RpcError('INVALID_REQUEST', 'DeepSeek 当前支持文本、模型选择、工具审批、问题、追加指令和中断；附件及 Codex 专属模式暂不可用');
    }
    if (typeof params.operationId !== 'string' || !params.operationId.trim() || params.operationId.length > 128) throw new RpcError('INVALID_REQUEST', 'DeepSeek 写操作需要持久化 operationId，请更新手机或网页');
  }
  async listPage(cursor: string | undefined, search: string | undefined, limit: number) {
    if (!this.runtime.ready) { this.prepare(); return { data: [], nextCursor: null, warning: this.runtime.error }; }
    let token: string, offset = 0;
    for (const [id, snapshot] of this.snapshots) if (Date.now() - snapshot.at > 300000) this.snapshots.delete(id);
    if (cursor) {
      try { if (!cursor.startsWith('ap-dsh-list-v1:')) throw new Error(); const parsed = JSON.parse(Buffer.from(cursor.slice(15), 'base64url').toString());
        token = parsed.token; offset = parsed.offset; const snapshot = this.snapshots.get(token);
        if (!snapshot || snapshot.search !== search || !Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.rows.length) throw new Error();
      } catch { throw new RpcError('INVALID_REQUEST', 'DeepSeek 列表游标已失效，请刷新'); }
    } else {
      const result = await this.runtime.request('list', {});
      const rows = result.data.filter((row: any) => { try { assertAllowedCwd(row.cwd, this.roots); return !search || `${row.name} ${row.cwd}`.toLowerCase().includes(search.toLowerCase()); } catch { return false; } });
      rows.sort((a: any, b: any) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      token = randomUUID(); while (this.snapshots.size >= 8) this.snapshots.delete(this.snapshots.keys().next().value!);
      this.snapshots.set(token, { at: Date.now(), search, rows });
    }
    const snapshot = this.snapshots.get(token!)!;
    const data = []; let bytes = 0;
    while (offset < snapshot.rows.length && data.length < limit) {
      const row = snapshot.rows[offset], size = Buffer.byteLength(JSON.stringify(row));
      if (bytes + size > 450 * 1024) break;
      data.push(row); bytes += size; offset++;
    }
    if (!data.length && offset < snapshot.rows.length) throw new RpcError('RESPONSE_TOO_LARGE', 'DeepSeek 单个任务资料过大，请在电脑检查');
    return { data, nextCursor: offset < snapshot.rows.length ? 'ap-dsh-list-v1:' + Buffer.from(JSON.stringify({ token, offset })).toString('base64url') : null };
  }
  async read(id: string, cursor?: string, deviceId?: string) { await this.ready(); return this.runtime.request('read', { threadId: id, cursor, deviceId }); }
  async watch(id: string, deviceId: string, watching = true, leaseId = 'legacy') { await this.ready(); return this.runtime.request(watching ? 'watch' : 'unwatch', { threadId: id, deviceId, leaseId }); }
  async modelOptions(id: string) { await this.ready(); return this.runtime.request('models', { threadId: id }); }
  meta(id: string) { const raw = this.store.getMeta(`dsh-operation:${id}`); return raw ? JSON.parse(raw) : undefined; }
  save(id: string, value: any) { this.store.setMeta(`dsh-operation:${id}`, JSON.stringify(value)); }
  async create(params: any, deviceId: string) {
    this.assertInput(params); const cwd = assertAllowedCwd(params.cwd, this.roots); await this.ready();
    const operationId = params.operationId;
    const sessionId = 'pocket-' + createHash('sha256').update(`${this.store.hostId()}:${operationId}`).digest('hex').slice(0, 32);
    const threadId = `dsh:${sessionId}`;
    this.save(operationId, { stage: 'creating', threadId, cwd });
    const created = await this.runtime.request('create', { sessionId, cwd });
    if (created.thread?.id !== threadId) throw new RpcError('OPERATION_UNKNOWN', 'DeepSeek 新建会话的回执不匹配');
    this.save(operationId, { stage: 'created', threadId, cwd });
    try {
      this.save(operationId, { stage: 'sending', threadId, cwd });
      const statusVersion = this.statusVersions.get(threadId) || 0;
      const sent = await this.runtime.request('send', { threadId, text: params.text, model: params.model, effort: params.effort, operationId, deviceId });
      this.save(operationId, { stage: 'accepted', threadId, cwd }); if ((this.statusVersions.get(threadId) || 0) === statusVersion) this.active.set(threadId, true);
      return { thread: created.thread, turn: sent.turn };
    } catch (error) {
      if (!(error instanceof RpcError) || error.nameCode === 'OPERATION_UNKNOWN') throw error;
      throw new RpcError(error.nameCode, `${error.message}；空会话已保留，原消息尚未发送。`, { threadId });
    }
  }
  async send(id: string, params: any, deviceId: string, steer = false) {
    this.assertInput(params); await this.ready();
    this.save(params.operationId, { stage: 'sending', threadId: id });
    const statusVersion = this.statusVersions.get(id) || 0;
    const result = await this.runtime.request('send', { threadId: id, text: params.text, model: params.model, effort: params.effort,
      operationId: params.operationId, deviceId, mode: steer ? 'steer' : 'queue', expectedTurnId: params.expectedTurnId });
    this.save(params.operationId, { stage: 'accepted', threadId: id }); if ((this.statusVersions.get(id) || 0) === statusVersion) this.active.set(id, true); return result;
  }
  async interrupt(id: string, turnId: string) { await this.ready(); return this.runtime.request('interrupt', { threadId: id, turnId }); }
  remember(requests: any[]) {
    for (const request of requests) {
      const id = request.requestId || request.id;
      if (!id || !request.threadId?.startsWith('dsh:')) continue;
      this.store.addPending(id, request.kind === 'approval' || request.type === 'approval.request' ? 'dsh/approval' : 'dsh/question',
        { ...request, source: 'dsh' }, id);
    }
  }
  async interactions(id: string) {
    await this.ready(); const result = await this.runtime.request('interactions', { threadId: id }); this.remember(result.requests);
    const live = new Map(result.requests.map((item: any) => [item.id, item]));
    const items = this.store.interactionsForThread(id).filter(row => row.method.startsWith('dsh/')).flatMap(row => {
      const available = live.has(row.request_id) && !row.resolved_at && !this.store.getMeta(`dsh-answer:${row.request_id}`);
      const base = { requestId: row.request_id, available, ...(available ? {} : { unavailableReason: row.resolved_at ? '已处理' : '此交互已结束或结果待确认' }) };
      if (row.method === 'dsh/approval') return [{ ...base, id: `dsh-approval-${row.request_id}`, type: 'pocketApproval',
        summary: row.params.summary, command: row.params.command, allowedDecisions: ['allowOnce', 'deny', 'cancel'], decision: row.response?.decision }];
      return (row.params.questions || []).map((q: any) => ({ ...base, id: `dsh-question-${row.request_id}-${q.id}`, type: 'pocketQuestion',
        questionId: q.id, prompt: q.question, options: q.options, multiSelect: q.multiSelect, selectedOption: row.response ? '已回答' : undefined }));
    });
    return { items, execution: result.execution };
  }
  async respond(requestId: string, params: any, kind: 'approval' | 'question') {
    const pending = this.store.pending(requestId);
    if (pending.method !== `dsh/${kind}` || (params.threadId && params.threadId !== pending.params.threadId)) throw new RpcError('INVALID_REQUEST', 'DeepSeek 交互类型或任务不匹配');
    const response = kind === 'approval' ? { decision: params.decision } : { answers: params.answers };
    if (pending.resolved_at) {
      if (JSON.stringify(pending.response) !== JSON.stringify(response)) throw new RpcError('CONFLICT', '此 DeepSeek 交互已经用其他内容处理');
      return { ok: true, duplicate: true };
    }
    if (this.store.getMeta(`dsh-answer:${requestId}`)) throw new RpcError('OPERATION_UNKNOWN', '此交互的原提交结果待确认，请勿重复批准');
    await this.ready();
    const payload = { requestId, threadId: pending.params.threadId, fingerprint: pending.params.fingerprint, ...response };
    this.save(params.operationId, { stage: 'answering', requestId, threadId: pending.params.threadId,
      fingerprint: pending.params.fingerprint, responseFingerprint: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), response });
    this.store.setMeta(`dsh-answer:${requestId}`, JSON.stringify({ operationId: params.operationId, response }));
    try {
      const result = await this.runtime.request('respond', payload);
      this.store.resolvePending(requestId, response); return result;
    } catch (error) {
      if (error instanceof RpcError && error.nameCode !== 'OPERATION_UNKNOWN') this.store.setMeta(`dsh-answer:${requestId}`, '');
      throw error;
    }
  }
  async reconcile(record: OperationRecord) {
    const raw = this.store.getMeta(`dsh-receipt:${record.operationId}`); if (raw) return { ...record, ...JSON.parse(raw) };
    if (record.status !== 'unknown' || !this.runtime.ready) return record;
    const meta = this.meta(record.operationId);
    if (!meta?.threadId || !['creating', 'created', 'sending', 'accepted', 'answering'].includes(meta.stage)) return record;
    try {
      if (meta.stage === 'answering') {
        const found = await this.runtime.request('interaction-status', meta);
        if (!found.settled) return record;
        this.store.resolvePending(meta.requestId, meta.response);
        const receipt = { status: 'succeeded', state: 'succeeded', result: { ok: true } };
        this.store.setMeta(`dsh-receipt:${record.operationId}`, JSON.stringify(receipt)); return { ...record, ...receipt };
      }
      if (meta.stage === 'creating' || meta.stage === 'created') {
        const read = await this.read(meta.threadId);
        if (read.thread.id !== meta.threadId || assertAllowedCwd(read.thread.cwd, this.roots) !== meta.cwd) return record;
        const receipt = { status: 'failed', state: 'failed', error: { message: 'DeepSeek 会话已创建，但原消息没有发送；请打开该会话继续，草稿已保留。',
          data: { name: 'DSH_CREATED_WITHOUT_MESSAGE', detail: { threadId: meta.threadId } } } };
        this.store.setMeta(`dsh-receipt:${record.operationId}`, JSON.stringify(receipt)); return { ...record, ...receipt };
      }
      const found = await this.runtime.request('operation', { threadId: meta.threadId, operationId: record.operationId });
      if (!found.accepted) return record;
      const read = await this.read(meta.threadId);
      const result = record.method === 'thread/start' ? { thread: read.thread, accepted: true } : { threadId: meta.threadId, accepted: true };
      const receipt = { status: 'succeeded', state: 'succeeded', result };
      this.store.setMeta(`dsh-receipt:${record.operationId}`, JSON.stringify(receipt)); return { ...record, ...receipt };
    } catch { return record; }
  }
  async stop() { await this.runtime.stop(); this.active.clear(); }
}
