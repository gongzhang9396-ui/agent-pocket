// Loaded only by the opt-in isolated control smoke, never by the Host profile.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const requireRuntime = createRequire(`${process.env.AGENT_POCKET_DSH_RUNTIME.replaceAll('\\', '/')}/node_modules/@deepseek-ai/dsh/package.json`);
const { scopeTarget } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-scope')).href);
export const inject = ['sessionController', 'agents', 'sessions', 'approval', 'sessionProjections'];
export function apply(ctx) {
  let agent, turn = 0, fallbacks = 0;
  ctx.on('approval/request', async () => { fallbacks++; return 'rejected'; }, { global: true });
  const listener = async message => {
    if (message?.type !== 'request' || !message.method?.startsWith('fixture/')) return;
    try {
      if (message.method === 'fixture/catalog') {
        const catalog = await ctx.sessionController.modelCatalog();
        process.send({ type: 'fixture', action: 'catalog', providerIds: catalog.groups.map(group => group.id),
          failures: catalog.failures, defaultModel: catalog.default });
        return;
      }
      if (message.method === 'fixture/create') {
        const created = await ctx.sessionController.create({ cwd: process.env.AGENT_POCKET_DSH_FIXTURE_ROOT });
        const found = await ctx.sessionController.resolveAgent(created.sessionId);
        if (found.error) throw found.error;
        agent = found.agent;
        process.send({ type: 'fixture', action: 'created', threadId: `dsh:${agent.id}` });
        return;
      }
      if (!agent) throw new Error('fixture Agent missing');
      agent.session.append('turn/start', { turn: ++turn });
      let outcome;
      try {
        if (message.method === 'fixture/approval') outcome = await ctx.approval.request({ agent, toolName: 'pocket_fixture', reason: 'Isolated control smoke; no tool is executed.' });
        if (message.method === 'fixture/question') outcome = await ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request',
          { agent, questions: [{ id: 'q', question: 'control smoke?', options: [{ label: 'yes' }] }] }, async () => { throw new Error('question unexpectedly delegated'); });
      } finally { agent.session.append('turn/end', { turn, reason: { kind: 'completed' } }); }
      process.send({ type: 'fixture', action: message.params.action, outcome, fallbacks });
    } catch (error) { process.send({ type: 'fixture', action: 'error', error: error.name }); }
  };
  process.on('message', listener); ctx.on('dispose', () => process.off('message', listener));
}
