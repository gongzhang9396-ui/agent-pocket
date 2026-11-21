import { readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { PocketDsh } from './core.mjs';

export const name = 'agent-pocket-dsh-bridge';
export const inject = ['sessionController', 'agents', 'sessions', 'llm', 'sessionProjections', 'approval', 'userQuestions', 'connection', 'webApp'];
const MAX_BYTES = 2 * 1024 * 1024;

export function dshProtocolError(error) {
  const code = error?.code || 'AGENT_ERROR';
  if (code === 'session/writer-held') return { code: 'THREAD_BUSY_EXTERNAL',
    message: '会话正在另一套 DeepSeek 服务中打开。请正常退出独立服务，电脑改用「DeepSeek（Pocket 共用）」入口后继续。' };
  // Native prompt() may report agent-busy after persisting the inbox message.
  // Only a durable operation lookup can decide whether it was accepted.
  if (code === 'session/agent-busy') return { code: 'OPERATION_UNKNOWN', message: 'DeepSeek 尚未确认这次操作的结果，请先查询原操作状态。' };
  if (/^(INVALID_REQUEST|PATH_DENIED|NOT_FOUND|CONFLICT|OPERATION_UNKNOWN|THREAD_BUSY|THREAD_BUSY_EXTERNAL|VERSION_UNSUPPORTED|HISTORY_CHANGED|AGENT_PROTOCOL)$/.test(code)) {
    return { code, message: error.message };
  }
  return { code: 'AGENT_ERROR', message: 'DeepSeek 请求失败，请检查电脑上的登录、模型或会话状态。' };
}

export async function apply(ctx) {
  if (!process.send || !process.connected || Number(process.env.AGENT_POCKET_DSH_PARENT) !== process.ppid) throw new Error('Pocket DSH plugin requires its owning Host IPC channel');
  const runtimeRoot = realpathSync.native(process.env.AGENT_POCKET_DSH_RUNTIME);
  const requireRuntime = createRequire(pathToFileURL(`${runtimeRoot.replaceAll('\\', '/')}/node_modules/@deepseek-ai/dsh/package.json`));
  // All executable DSH modules must resolve into the integrity-checked runtime,
  // including when another DSH installation exists in the user's profile tree.
  for (const pkg of ['dsh-session', 'dsh-user-approval', 'dsh-api-session-controller', 'dsh-agent', 'dsh-llm']) {
    const path = requireRuntime.resolve(`@deepseek-ai/${pkg}`);
    const rel = relative(runtimeRoot, realpathSync.native(path));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Pocket DSH resolved a module from another installation');
  }
  const { deriveEventMessage } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-session')).href);
  const { joinAssistantStreamText } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-llm')).href);
  // CLI's main entry sits in lib; locate its package without assuming that URL.
  const actualVersion = process.env.AGENT_POCKET_DSH_VERSION;
  if (actualVersion !== '0.2.1-rc.2') throw new Error('Unsupported Pocket DSH runtime');
  let queuedBytes = 0, stopped = false;
  const send = value => {
    if (stopped || !process.connected) return;
    const size = Buffer.byteLength(JSON.stringify(value));
    if (size > MAX_BYTES || queuedBytes + size > 4 * MAX_BYTES) { shutdown(); return; }
    queuedBytes += size;
    process.send(value, error => { queuedBytes -= size; if (error) shutdown(); });
  };
  const service = new PocketDsh(ctx, JSON.parse(process.env.AGENT_POCKET_DSH_ROOTS || '[]'),
    { derive: deriveEventMessage, textStream: joinAssistantStreamText, version: actualVersion }, (type, payload) => send({ type: 'event', event: { type, ...payload } }));
  const approval = ctx.on('approval/request', (request, next) => service.claim('approval', request, next), { global: true, prepend: true });
  const questions = ctx.on('user-questions/request', (request, next) => service.claim('question', request, next), { global: true, prepend: true });
  let inFlight = 0;
  const message = async request => {
    if (!request || typeof request !== 'object' || request.type !== 'request' || !Number.isSafeInteger(request.id) || request.id <= 0 || typeof request.method !== 'string'
      || !request.params || typeof request.params !== 'object' || Array.isArray(request.params) || Buffer.byteLength(JSON.stringify(request)) > MAX_BYTES || inFlight >= 32) { shutdown(); return; }
    inFlight++;
    try { send({ type: 'response', id: request.id, result: await service.call(request.method, request.params) }); }
    catch (error) {
      send({ type: 'response', id: request.id, error: dshProtocolError(error) });
    } finally { inFlight--; }
  };
  function shutdown() {
    if (stopped) return; stopped = true; service.close();
    process.off('message', message);
    // Let the official launcher drain Agents and persistence. Only our owned
    // runtime is affected; no other DSH process or native lock is touched.
    if (process.listenerCount('SIGTERM')) process.emit('SIGTERM');
    const timer = setTimeout(() => process.exit(1), 12000); timer.unref();
  }
  process.on('message', message);
  process.once('disconnect', shutdown);
  const statusListener = ctx.on('api-session/status', (sessionId, running) => {
    const agent = ctx.agents.get(sessionId);
    if (!agent || agent.session.header.origin === 'subagent') return;
    try { service.allowed(agent.session.header.cwd); } catch { return; }
    send({ type: 'event', event: { type: 'dsh.status', threadId: `dsh:${sessionId}`, running } });
  });
  const turns = ctx.on('session/event', (session, event) => {
    if (!['turn/start', 'turn/end'].includes(event.type) || session.header.origin === 'subagent' || ctx.sessions.get(session.id) !== session) return;
    try { service.allowed(session.header.cwd); } catch { return; }
    send({ type: 'event', event: { type: 'turn.status', threadId: `dsh:${session.id}`, turnId: `dsh-turn-${event.data.turn}`,
      status: event.type === 'turn/start' ? 'inProgress' : event.data.reason?.kind === 'aborted' ? 'interrupted' : event.data.reason?.kind === 'error' ? 'failed' : 'completed' } });
  }, { global: true });
  ctx.on('dispose', () => { stopped = true; service.close(); approval(); questions(); statusListener(); turns(); process.off('message', message); process.off('disconnect', shutdown); });
  send({ type: 'ready', protocolVersion: 1, runtimeVersion: actualVersion,
    desktopUrl: ctx.connection.authenticatedUrl(ctx.webApp.getAdvertisedUrl()) });
}
