export type Activity = { title: string; text: string; status: string };
export const statusType = (value: any): string => typeof value === 'string' ? value : value?.type || '';
export const runningStatus = (value: any): boolean => ['inProgress', 'in_progress', 'active', 'running', 'started'].includes(statusType(value));
export const finishedStatus = (value: any): boolean => ['completed', 'failed', 'interrupted', 'cancelled', 'canceled'].includes(statusType(value));
const text = (value: any): string => typeof value === 'string' ? value : '';

/** Only the provider's public summary is displayable. Missing summaries never
 * fall back to raw reasoning content or encrypted replay fields. */
export function itemActivity(item: any): Activity | undefined {
  const status = statusType(item?.status);
  switch (item?.type) {
    case 'reasoning':
      return { title: '思考摘要', status, text: (Array.isArray(item.summary) ? item.summary : [])
        .map((part: any) => typeof part === 'string' ? part : text(part?.text)).filter(Boolean).join('\n\n') };
    case 'plan': {
      const steps = Array.isArray(item.plan) ? item.plan : [];
      return { title: '执行计划', status, text: text(item.text) || [text(item.explanation), ...steps.map((step: any) =>
        `${step.status === 'completed' ? '✓' : runningStatus(step.status) ? '→' : '○'} ${text(step.step)}`)].filter(Boolean).join('\n') };
    }
    case 'commandExecution':
      return { title: '执行命令', status, text: [Array.isArray(item.command) ? item.command.join(' ') : text(item.command),
        text(item.aggregatedOutput ?? item.output)].filter(Boolean).join('\n') };
    case 'fileChange':
      return { title: '修改文件', status, text: (Array.isArray(item.changes) ? item.changes : [])
        .map((change: any) => [text(change.path), text(change.diff)].filter(Boolean).join('\n')).join('\n\n') };
    case 'diff': return { title: '文件差异', status, text: text(item.diff) };
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabToolCall':
    case 'collabAgentToolCall':
      return { title: '调用工具', status, text: [text(item.server), text(item.tool)].filter(Boolean).join(' · ') };
    case 'webSearch': return { title: '搜索资料', status, text: text(item.query) || text(item.action?.query) || text(item.action?.url) };
    case 'imageView': return { title: '查看图片', status, text: text(item.path) };
    case 'contextCompaction': return { title: '整理上下文', status, text: '' };
    case 'imageGeneration': return { title: '生成图片', status, text: '' };
    case 'subAgentActivity': return { title: '子代理执行', status, text: '' };
    case 'sleep': return { title: '等待唤醒', status, text: '' };
    case 'enteredReviewMode': return { title: '进入审查', status, text: '' };
    case 'exitedReviewMode': return { title: '结束审查', status, text: '' };
    default: return undefined;
  }
}

export function activityStatus(value: string): string {
  if (runningStatus(value)) return '进行中';
  return ({ completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', canceled: '已取消', declined: '已拒绝' } as Record<string, string>)[value] || '';
}

export function currentProgress(detail: any, interactions: any[] = []): { title: string; text: string } | undefined {
  const thread = detail?.thread;
  if (!thread) return undefined;
  const pending = interactions.find(item => ['pocketApproval', 'pocketQuestion'].includes(item.type) && item.available === true && !item.decision && item.selectedOption == null);
  if (pending) return { title: pending.type === 'pocketApproval' ? '等待你批准' : '等待你回答',
    text: pending.type === 'pocketApproval' ? '在对话中确认后继续' : '回答对话中的问题后继续' };
  const turns = [...(thread.turns || [])];
  if (detail?.page?.order === 'newest_first') turns.reverse();
  const active = turns.findLast((turn: any) => runningStatus(turn.status));
  if (!active && !runningStatus(thread.status)) return undefined;
  const latest = [...(active?.items || [])].reverse().find(item => item.type === 'agentMessage' || itemActivity(item));
  if (latest?.type === 'agentMessage') return { title: '正在回复', text: text(latest.text).slice(-180) };
  const activity = itemActivity(latest);
  if (!activity) return { title: '正在处理', text: '等待电脑传回下一步进展' };
  const step = latest.type === 'plan' && latest.plan?.find((row: any) => runningStatus(row.status));
  return { title: activity.status && !runningStatus(activity.status) ? '正在处理下一步' : activity.title,
    text: text(step?.step || activity.text).replace(/\s+/g, ' ').slice(0, 180) || '等待电脑传回下一步进展' };
}
