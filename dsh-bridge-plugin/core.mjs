import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { capabilities, describe, eventItems, modelRows, nativeId, pocketId, projectPage, turnId } from './projection.mjs';

export class DshError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new DshError(code, message); };
const address = sessionId => ({ kind: 'session', sessionId });
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeString = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max;

/** Parent-owned IPC only: no listener, credential file or public RPC endpoint. */
export class PocketDsh {
  constructor(ctx, roots, helpers, notify, { now = Date.now, leaseMs = 45000, interactionMs = 300000 } = {}) {
    this.ctx = ctx; this.api = ctx.sessionController; this.roots = roots.map(root => realpathSync.native(root));
    this.helpers = helpers; this.notify = notify; this.now = now; this.leaseMs = leaseMs; this.interactionMs = interactionMs;
    this.views = new Map(); this.retiredLeases = new Map(); this.creationWaiting = new Map();
    this.follows = new Map(); this.pending = new Map(); this.settled = new Map(); this.closed = false;
    this.localModels = helpers.version === '0.2.1-rc.2' && typeof this.api.agents?.selectForNextRequest === 'function'
      && typeof this.api.agents?.selectionFor === 'function' && typeof this.api.agents?.serializeImageAdmission === 'function';
    this.timer = setInterval(() => this.expire(), 1000); this.timer.unref();
  }
  allowed(cwd) {
    if (!safeString(cwd, 32768) || !isAbsolute(cwd)) fail('PATH_DENIED', 'DeepSeek 会话没有可验证的项目路径');
    const canonical = realpathSync.native(cwd);
    if (!this.roots.some(root => { const rel = relative(root, canonical); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); })) {
      fail('PATH_DENIED', 'DeepSeek 会话不在项目白名单内');
    }
    return canonical;
  }
  async rows() {
    const result = await this.api.list({}, new AbortController().signal);
    return (result.items || []).filter(row => {
      try { this.allowed(row.cwd); return row.origin !== 'subagent' && row.formatStatus !== 'migration-required'; } catch { return false; }
    });
  }
  async row(id) {
    const key = nativeId(id), row = (await this.rows()).find(row => row.sessionId === key);
    if (!row) fail('NOT_FOUND', '这个 DeepSeek 会话不可用，或不在电脑项目白名单内');
    return row;
  }
  async agent(id) {
    const row = await this.row(id), found = await this.api.resolveAgent(row.sessionId);
    if (found.error) throw found.error;
    const agent = found.agent;
    if (agent.id !== row.sessionId || this.ctx.agents.get(row.sessionId) !== agent || this.ctx.sessions.get(row.sessionId) !== agent.session
      || this.allowed(row.cwd) !== this.allowed(agent.session.header.cwd)) fail('THREAD_BUSY_EXTERNAL', 'DeepSeek 会话的执行器或项目已经变化');
    return agent;
  }
  liveView(sessionId) { return [...(this.views.get(sessionId)?.values() || [])].some(expiry => expiry > this.now()); }
  watch(id, deviceId, leaseId = 'send') {
    if (!safeString(deviceId)) fail('INVALID_REQUEST', '缺少设备标识');
    if (!safeString(leaseId)) fail('INVALID_REQUEST', '查看租约标识无效');
    const key = nativeId(id), views = this.views.get(key) || new Map();
    const lease = `${deviceId}:${leaseId}`;
    if ((this.retiredLeases.get(`${key}:${lease}`) || 0) > this.now()) return { ok: false, expired: true };
    if (views.size >= 32 && !views.has(lease)) fail('THREAD_BUSY', 'DeepSeek 会话查看者过多');
    views.set(lease, this.now() + this.leaseMs); this.views.set(key, views);
    return { ok: true };
  }
  expire() {
    for (const [id, views] of this.views) {
      for (const [device, expiry] of views) if (expiry <= this.now()) views.delete(device);
      if (!views.size) { this.views.delete(id); this.follows.get(id)?.abort(); this.follows.delete(id); }
    }
    for (const pending of this.pending.values()) if (!this.liveView(pending.sessionId) || pending.deadline <= this.now()) pending.finish(false);
    for (const [id, receipt] of this.settled) if (receipt.until <= this.now()) this.settled.delete(id);
    for (const [id, expiry] of this.retiredLeases) if (expiry <= this.now()) this.retiredLeases.delete(id);
    for (const [id, expiry] of this.creationWaiting) if (expiry <= this.now()) this.creationWaiting.delete(id);
    for (const [id, controller] of this.follows) if (!this.liveView(id)) { controller.abort(); this.follows.delete(id); }
  }
  async follow(id) {
    const key = nativeId(id);
    if (this.follows.has(key)) return;
    if (this.follows.size >= 16) fail('THREAD_BUSY', 'DeepSeek 已打开的对话过多');
    const controller = new AbortController(); this.follows.set(key, controller);
    void (async () => {
      try {
        for await (const frame of this.api.follow({ address: address(key), assistantStream: true, maxMessages: 1 }, controller.signal)) {
          if (controller.signal.aborted || this.closed) break;
          if (frame.type === 'snapshot') {
            const active = frame.assistantStream?.activeAttempt;
            if (active) this.notify('message.delta', { threadId: id, itemId: `dsh-live-${active.attemptId}`, role: 'assistant', replace: true,
              delta: this.helpers.textStream(active.stream) });
            this.notify('sync.required', { threadId: id, reason: 'dsh-snapshot' });
          }
          else if (frame.type === 'event') {
            const event = frame.event;
            this.notify('sync.required', { threadId: id, reason: 'dsh-event', dshSeq: event.seq });
          } else if (frame.type === 'assistant-stream') {
            const stream = frame.frame;
            if (stream.type === 'chunk' && stream.chunk?.type === 'text-delta') this.notify('message.delta', {
              threadId: id, turnId: turnId(stream.turn ?? 'live'), itemId: `dsh-live-${stream.attemptId}`, role: 'assistant', delta: stream.chunk.text });
            if (stream.type === 'end') this.notify('message.delta', { threadId: id, itemId: `dsh-live-${stream.attemptId}`,
              role: 'assistant', delta: '', replace: true, remove: true, complete: true });
          }
        }
      } catch { if (!controller.signal.aborted && !this.closed) this.notify('sync.required', { threadId: id, reason: 'dsh-follow-reconnect' }); }
      finally { if (this.follows.get(key) === controller) this.follows.delete(key); }
    })();
  }
  async snapshot(key) {
    const controller = new AbortController(), iterator = this.api.follow({ address: address(key), maxMessages: 1, assistantStream: true }, controller.signal)[Symbol.asyncIterator]();
    try { const frame = (await iterator.next()).value; if (frame?.type !== 'snapshot') fail('AGENT_PROTOCOL', 'DeepSeek 历史缺少起始游标'); return frame; }
    finally { controller.abort(); await iterator.return?.(); }
  }
  async read(id, encoded, deviceId) {
    const row = await this.row(id);
    let cursor;
    if (encoded) {
      try { if (!encoded.startsWith('ap-dsh-v1:')) throw new Error(); cursor = JSON.parse(Buffer.from(encoded.slice(10), 'base64url'));
        if (cursor.id !== id || !Number.isSafeInteger(cursor.cut) || cursor.cut < 0 || !Number.isSafeInteger(cursor.seq) || cursor.seq < 0 || !Number.isSafeInteger(cursor.item) || cursor.item < 0) throw new Error();
      } catch { fail('INVALID_REQUEST', 'DeepSeek 历史游标无效或属于其他任务'); }
    }
    const snapshot = await this.snapshot(row.sessionId), cut = cursor?.cut ?? snapshot.cursor;
    if (cut > snapshot.cursor) fail('HISTORY_CHANGED', 'DeepSeek 历史已改变，请刷新');
    const page = await this.api.page({ address: address(row.sessionId), throughSeq: cut, ...(cursor ? { beforeSeq: cursor.seq + 1 } : {}), maxMessages: 20 }, new AbortController().signal);
    const projected = projectPage(page.records, this.helpers.derive, cursor, cut, id);
    const next = projected.next || (page.hasMore && page.records.length ? { id, cut, seq: page.records[0].event.seq - 1, item: Number.MAX_SAFE_INTEGER } : null);
    // A page before an event carries an unlimited item bound, not an array index.
    const turns = projected.turns;
    const values = snapshot.projections?.values || {};
    const boundary = values.turnBoundary;
    if (boundary?.openTurnStartSeq != null) {
      const active = turns.find(turn => turn.id === turnId(boundary.lastTurn));
      if (active) active.status = 'inProgress'; else turns.push({ id: turnId(boundary.lastTurn), status: 'inProgress', items: [] });
    }
    const live = !cursor && snapshot.assistantStream?.activeAttempt;
    if (live) {
      const item = { id: `dsh-live-${live.attemptId}`, type: 'agentMessage', text: this.helpers.textStream(live.stream) };
      const active = turns.find(turn => turn.status === 'inProgress');
      if (active) active.items.push(item); else turns.push({ id: 'dsh-live', status: 'live', items: [item] });
    }
    return { thread: { ...describe({ ...row, projections: snapshot.projections }), turns, liveItemIds: live ? [`dsh-live-${live.attemptId}`] : [] },
      page: { order: 'oldest_first', hasMore: !!next, nextCursor: next ? 'ap-dsh-v1:' + Buffer.from(JSON.stringify(next)).toString('base64url') : null,
        revision: `${row.sessionId}:${snapshot.header.version}:${snapshot.header.createdAt}` } };
  }
  async models(id) {
    const catalog = await this.api.modelCatalog(); let selection, used;
    if (id) {
      const row = await this.row(id), projection = await this.api.projections({ sessionId: row.sessionId }, new AbortController().signal);
      selection = projection?.values?.modelSelection?.next || projection?.values?.modelSelection?.lastUsed;
      used = projection?.values?.modelSelection?.lastUsed;
    }
    return { data: modelRows(catalog), currentModel: selection ? JSON.stringify([selection.provider, selection.model]) : undefined,
      currentEffort: selection?.reasoningEffort, controlScope: this.localModels ? 'shared' : 'none',
      lastUsedModel: used ? JSON.stringify([used.provider, used.model]) : undefined, lastUsedEffort: used?.reasoningEffort,
      reason: this.localModels ? '设置作用于此共享会话的下一请求，请在电脑与手机之间交替发送。' : '此 DeepSeek 版本不支持会话级模型设置' };
  }
  async select(agent, model, effort) {
    if (!model && effort == null) return;
    if (!this.localModels) fail('VERSION_UNSUPPORTED', '此 DeepSeek 版本不支持会话级模型设置');
    let selection = this.api.agents.selectionFor(agent).current;
    if (model) { try { const [provider, name, ...rest] = JSON.parse(model); if (!provider || !name || rest.length) throw new Error(); selection = { provider, model: name }; }
      catch { fail('INVALID_REQUEST', 'DeepSeek 模型标识无效'); } }
    if (effort != null) selection = { ...selection, reasoningEffort: effort };
    const catalog = await this.api.modelCatalog(), advertised = catalog.groups?.find(p => p.id === selection.provider)?.models.find(m => m.id === selection.model);
    if (!advertised || (selection.reasoningEffort && !advertised.reasoning?.efforts.some(e => e.id === selection.reasoningEffort))) fail('INVALID_REQUEST', 'DeepSeek 模型或推理档位不可用');
    const resolved = await this.ctx.llm.resolveCallConfig(selection);
    this.api.agents.selectForNextRequest(agent, { provider: resolved.provider, model: resolved.model,
      ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}) });
  }
  async create(params) {
    const cwd = this.allowed(params.cwd);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(params.sessionId || '')) fail('INVALID_REQUEST', '缺少预先保存的 DeepSeek 会话标识');
    if ((await this.rows()).some(row => row.sessionId === params.sessionId)) fail('CONFLICT', '这个 DeepSeek 创建请求已经有会话，请先查询原回执');
    const result = await this.api.create({ cwd, sessionId: params.sessionId });
    if (result.sessionId !== params.sessionId) fail('OPERATION_UNKNOWN', 'DeepSeek 返回了不同的会话标识，请检查原操作');
    this.creationWaiting.set(result.sessionId, this.now() + 15000);
    const row = await this.row(pocketId(result.sessionId));
    if (this.allowed(row.cwd) !== cwd) fail('OPERATION_UNKNOWN', 'DeepSeek 新会话的项目与创建请求不一致，请检查原操作');
    return { thread: describe(row) };
  }
  async send(params) {
    if (!safeString(params.operationId) || !safeString(params.text, 65536)) fail('INVALID_REQUEST', 'DeepSeek 消息格式无效');
    if (params.mode === 'steer' && (params.model || params.effort != null)) fail('INVALID_REQUEST', '追加指令不能同时切换 DeepSeek 模型');
    const agent = await this.agent(params.threadId); await this.follow(params.threadId);
    const current = this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary');
    if (params.expectedTurnId && (current?.openTurnStartSeq == null || turnId(current.lastTurn) !== params.expectedTurnId)) fail('THREAD_BUSY_EXTERNAL', 'DeepSeek 的当前轮次已改变');
    if (agent.status === 'running' && params.mode !== 'steer') fail('THREAD_BUSY', 'DeepSeek 正在执行，请使用追加指令或等待完成');
    return this.api.agents.serializeImageAdmission(agent, async () => {
      await this.select(agent, params.model, params.effort);
      // prompt() owns the same admission chain: do not call it inside the chain.
      return { ready: true };
    }).then(async () => {
      const result = await this.api.prompt({ sessionId: agent.id, requestId: params.operationId, mode: params.mode === 'steer' ? 'steer' : 'queue',
        content: [{ type: 'text', text: params.text }] }, new AbortController().signal);
      return { ...result, threadId: params.threadId, turn: { id: turnId(this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.lastTurn ?? 'pending'), status: 'inProgress' } };
    });
  }
  async interrupt(params) {
    const agent = await this.agent(params.threadId), boundary = this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary');
    if (boundary?.openTurnStartSeq == null || turnId(boundary.lastTurn) !== params.turnId) fail('THREAD_BUSY_EXTERNAL', 'DeepSeek 的这一轮已结束');
    return this.api.cancel({ sessionId: agent.id });
  }
  async claim(kind, req, next) {
    const agent = req.agent;
    if (!agent || this.closed || this.ctx.agents.get(agent.id) !== agent || this.ctx.sessions.get(agent.id) !== agent.session || agent.session.header.origin === 'subagent') return next();
    let claimedCwd;
    try {
      claimedCwd = this.allowed(agent.session.header.cwd);
      const row = await this.row(pocketId(agent.id));
      if (this.allowed(row.cwd) !== claimedCwd) return next();
    } catch { return next(); }
    // A just-created conversation may reach its first approval before the phone
    // has received the create receipt. Wait briefly for an actual view lease;
    // never infer visibility from a send operation.
    if (!this.liveView(agent.id) && (this.creationWaiting.get(agent.id) || 0) > this.now()) {
      const until = Date.now() + 5000;
      while (!this.liveView(agent.id) && !req.signal?.aborted && !this.closed && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (this.closed || req.signal?.aborted) return kind === 'approval' ? 'unavailable' : Promise.reject(new DshError('ASK_CANCELLED', '问题已取消'));
    if (!this.liveView(agent.id) || this.ctx.agents.get(agent.id) !== agent || this.ctx.sessions.get(agent.id) !== agent.session) return next();
    if (req.signal?.aborted || this.pending.size >= 32) return kind === 'approval' ? 'unavailable' : Promise.reject(new DshError('ASK_CANCELLED', '问题已取消'));
    const id = randomUUID(), threadId = pocketId(agent.id), request = { id, kind, threadId, sessionId: agent.id,
      turnId: turnId(this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.lastTurn ?? 'pending'),
      ...(kind === 'approval' ? { summary: req.reason || req.toolName, toolName: req.toolName, command: req.reason || '', allowedDecisions: ['allowOnce', 'deny', 'cancel'] } : { questions: req.questions }) };
    request.fingerprint = fingerprint(request);
    return new Promise((resolve, reject) => {
      const pending = { ...request, agent, claimedCwd, signal: req.signal, deadline: this.now() + this.interactionMs, finish: (answer, receipt) => {
        if (!this.pending.delete(id)) return;
        req.signal?.removeEventListener('abort', abort);
        if (receipt) { this.settled.set(id, { fingerprint: request.fingerprint, receipt, until: this.now() + 3600000 }); while (this.settled.size > 512) this.settled.delete(this.settled.keys().next().value); }
        this.notify('sync.required', { threadId, reason: 'dsh-interaction-settled' });
        if (answer === false) kind === 'approval' ? resolve('unavailable') : reject(new DshError('ASK_CANCELLED', '问题已取消'));
        else resolve(answer);
      } };
      const abort = () => pending.finish(false);
      this.pending.set(id, pending); req.signal?.addEventListener('abort', abort, { once: true });
      this.notify(kind === 'approval' ? 'approval.request' : 'question.request', { ...request, requestId: id });
    });
  }
  async interactions(id) {
    this.expire();
    const row = await this.row(id), list = [...this.pending.values()].filter(p => p.sessionId === row.sessionId).map(({ finish, deadline, agent, claimedCwd, signal, ...item }) => item);
    const projection = await this.api.projections({ sessionId: row.sessionId }, new AbortController().signal);
    for (const question of projection?.values?.userQuestions?.active || []) if (question.state === 'continued') {
      const item = { id: `continued-${fingerprint([row.sessionId, question.callId]).slice(0, 40)}`, kind: 'question', threadId: id,
        sessionId: row.sessionId, callId: question.callId, questions: question.questions, continued: true };
      item.fingerprint = fingerprint(item); list.push(item);
    }
    return { requests: list, execution: describe(row).execution };
  }
  answerQuestions(questions, answers) {
    if (!answers || typeof answers !== 'object' || Object.keys(answers).length !== questions.length) fail('INVALID_REQUEST', '请完整回答 DeepSeek 的问题');
    return { answers: questions.map(q => {
      const values = answers[q.id]?.answers;
      if (!Array.isArray(values) || !values.length || values.length > 10 || (!q.multiSelect && values.length !== 1) || values.some(v => !safeString(v, 4000))) fail('INVALID_REQUEST', 'DeepSeek 回答格式无效');
      const labels = new Set((q.options || []).map(o => o.label));
      return { id: q.id, selected: values.filter(v => labels.has(v)), ...(values.some(v => !labels.has(v)) ? { custom: values.filter(v => !labels.has(v)).join('\n') } : {}) };
    }) };
  }
  async respond(params) {
    const row = await this.row(params.threadId); this.expire();
    const receipt = this.settled.get(params.requestId);
    if (receipt) {
      if (receipt.fingerprint !== params.fingerprint || receipt.receipt !== fingerprint(params)) fail('CONFLICT', 'DeepSeek 交互已经用不同内容处理');
      return { ok: true, duplicate: true };
    }
    const pending = this.pending.get(params.requestId);
    if (pending) {
      if (pending.threadId !== params.threadId || pending.fingerprint !== params.fingerprint) fail('INVALID_REQUEST', 'DeepSeek 交互不属于当前请求');
      let sameCwd = false;
      try { sameCwd = this.allowed(row.cwd) === pending.claimedCwd && this.allowed(pending.agent.session.header.cwd) === pending.claimedCwd; } catch {}
      if (!sameCwd || pending.signal?.aborted || this.ctx.agents.get(pending.sessionId) !== pending.agent || this.ctx.sessions.get(pending.sessionId) !== pending.agent.session) {
        pending.finish(false); fail('NOT_FOUND', 'DeepSeek 会话执行器已变化，交互已失效');
      }
      let answer;
      if (pending.kind === 'approval') {
        answer = { allowOnce: 'allowed-once', deny: 'rejected', cancel: 'cancelled' }[params.decision];
        if (!answer) fail('INVALID_REQUEST', '仅支持允许一次、拒绝或取消');
      } else answer = this.answerQuestions(pending.questions, params.answers);
      pending.finish(answer, fingerprint(params)); return { ok: true };
    }
    const continued = (await this.interactions(params.threadId)).requests.find(item => item.id === params.requestId && item.continued);
    if (!continued || continued.fingerprint !== params.fingerprint || !this.liveView(continued.sessionId)) fail('NOT_FOUND', '这次 DeepSeek 交互已失效');
    const agent = await this.agent(params.threadId);
    if (!this.ctx.userQuestions.answer(agent, continued.callId, this.answerQuestions(continued.questions, params.answers))) fail('NOT_FOUND', '这次 DeepSeek 问题已处理');
    this.settled.set(params.requestId, { fingerprint: params.fingerprint, receipt: fingerprint(params), until: this.now() + 3600000 });
    return { ok: true };
  }
  async findOperation(params) {
    const row = await this.row(params.threadId), snapshot = await this.snapshot(row.sessionId);
    let before;
    for (let pages = 0; pages < 100; pages++) {
      const page = await this.api.page({ address: address(row.sessionId), throughSeq: snapshot.cursor, ...(before != null ? { beforeSeq: before } : {}), maxMessages: 30 }, new AbortController().signal);
      for (const { event } of page.records) {
        const messages = event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted || [] : [];
        if (messages.some(message => message.source?.kind === 'user' && message.source.rpcId === params.operationId)) return { accepted: true };
      }
      if (!page.hasMore || !page.records.length) break;
      const next = page.records[0].event.seq;
      if (before != null && next >= before) break; before = next;
    }
    return { accepted: false }; // Absence is never proof that a mutation failed.
  }
  async call(method, params) {
    if (this.closed) fail('AGENT_OFFLINE', 'DeepSeek 连接已关闭');
    if (method === 'probe') {
      const all = (await this.api.list({}, new AbortController().signal)).items || [];
      return { protocolVersion: 1, runtimeVersion: this.helpers.version, capabilities: ['approval-waterfall-safe', 'questions-v1', 'desktop-web-entry-v1', ...(this.localModels ? ['model-select-local'] : [])], models: (await this.models()).data,
        catalog: { total: all.length, allowed: (await this.rows()).length, migrationRequired: all.filter(row => row.formatStatus === 'migration-required').length } };
    }
    if (method === 'list') return { data: (await this.rows()).map(row => describe(row)) };
    if (method === 'create') return this.create(params);
    if (method === 'send') return this.send(params);
    if (method === 'read') return this.read(params.threadId, params.cursor, params.deviceId);
    if (method === 'models') return this.models(params.threadId);
    if (method === 'watch') {
      await this.row(params.threadId);
      const watched = this.watch(params.threadId, params.deviceId, params.leaseId);
      if (!watched.ok) return watched;
      try { await this.follow(params.threadId); return { ok: true }; }
      catch (error) {
        this.views.get(nativeId(params.threadId))?.delete(`${params.deviceId}:${params.leaseId}`);
        this.expire(); throw error;
      }
    }
    if (method === 'unwatch') {
      const id = nativeId(params.threadId), views = this.views.get(id);
      this.retiredLeases.set(`${id}:${params.deviceId}:${params.leaseId}`, this.now() + 300000);
      while (this.retiredLeases.size > 4096) this.retiredLeases.delete(this.retiredLeases.keys().next().value);
      views?.delete(`${params.deviceId}:${params.leaseId}`); views?.delete(`${params.deviceId}:send`);
      this.expire(); return { ok: true };
    }
    if (method === 'interrupt') return this.interrupt(params);
    if (method === 'interactions') return this.interactions(params.threadId);
    if (method === 'respond') return this.respond(params);
    if (method === 'interaction-status') {
      await this.row(params.threadId);
      const receipt = this.settled.get(params.requestId);
      return { settled: !!receipt && receipt.fingerprint === params.fingerprint && receipt.receipt === params.responseFingerprint };
    }
    if (method === 'operation') return this.findOperation(params);
    fail('NOT_FOUND', '不支持的 DeepSeek 操作');
  }
  close() {
    this.closed = true; clearInterval(this.timer);
    for (const controller of this.follows.values()) controller.abort(); this.follows.clear(); this.views.clear();
    for (const pending of this.pending.values()) pending.finish(false);
  }
}
