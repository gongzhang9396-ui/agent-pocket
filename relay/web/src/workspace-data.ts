import { itemActivity, runningStatus } from './thread-activity';

export function rows(value: any): any[] { return Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : []; }
export function threadTitle(thread: any): string { return thread?.name || thread?.title || thread?.preview || "未命名任务"; }
export function projectName(thread: any): string { return String(thread?.cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "其他任务"; }
export function threadBackend(thread: any): string { return thread?.execution?.backend || thread?.source || ""; }
export function threadAgentId(thread: any): string {
  if (typeof thread?.agentId === 'string' && thread.agentId) return thread.agentId;
  if (thread?.id?.startsWith('dsh:')) return 'dsh';
  if (thread?.id?.startsWith('grok:')) return 'grok';
  const backend = threadBackend(thread);
  return ['grok', 'dsh'].includes(backend) ? backend : ['bridge', 'desktop'].includes(backend) ? 'codex' : '';
}
export function agentName(thread: any): string {
  const id = threadAgentId(thread);
  return ({ codex: 'Codex', grok: 'Grok', dsh: 'DeepSeek' } as Record<string, string>)[id] || id || 'Agent';
}
export function backendLabel(thread: any): string { return ({ desktop: "Desktop", bridge: "Bridge", grok: "Grok", dsh: "DeepSeek" } as Record<string, string>)[threadBackend(thread)] || "电脑任务"; }
export function threadCapabilities(thread: any): Record<string, boolean> {
  const caps = thread?.execution?.capabilities || thread?.capabilities || {};
  // Match the existing Android/Host contract: older Codex Hosts omit these two
  // fields. Never extend that fallback to Grok or an unidentified execution target.
  const legacyCodex = agentName(thread) === "Codex" && ["desktop", "bridge"].includes(threadBackend(thread));
  return { ...caps, attachments: caps.attachments === true || (caps.attachments === undefined && legacyCodex),
    steer: caps.steer === true || (caps.steer === undefined && legacyCodex) };
}
export function threadState(thread: any): { kind: string; label: string } {
  const type = typeof thread?.status === "string" ? thread.status : thread?.status?.type;
  const flags = JSON.stringify(thread?.status?.activeFlags || []);
  if (/waitingOnApproval|waitingOnUserInput/.test(flags) || type === "systemError") return { kind: "review", label: "需要确认" };
  if (type === "active" || type === "inProgress" || activeTurn({ thread })) return { kind: "active", label: "运行中" };
  if (type === "notLoaded") return { kind: "idle", label: "未载入" };
  if (type === "completed") return { kind: "idle", label: "已完成" };
  if (threadCapabilities(thread).send !== true) return { kind: "readonly", label: "仅查看" };
  return { kind: "idle", label: "可继续" };
}
export function updatedLabel(value: unknown, now = Date.now()): string {
  const number = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(number)) return "";
  const date = new Date(number < 1e12 ? number * 1000 : number); const elapsed = now - date.getTime();
  if (elapsed >= 0 && elapsed < 60000) return "刚刚";
  if (elapsed >= 60000 && elapsed < 3600000) return `${Math.floor(elapsed / 60000)} 分钟前`;
  if (elapsed >= 3600000 && elapsed < 86400000) return `${Math.floor(elapsed / 3600000)} 小时前`;
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
export function activeTurn(detail: any) { return (detail?.thread?.turns || []).find((turn: any) => runningStatus(turn.status)); }
export function conversationMessages(detail: any): Array<{ id: string; role: string; text: string; activity?: ReturnType<typeof itemActivity> }> {
  const turns = [...(detail?.thread?.turns || [])];
  if (detail?.page?.order === "newest_first") turns.reverse();
  return turns.flatMap((turn: any) => (turn.items || []).flatMap((item: any, index: number) => {
    const activity = itemActivity(item);
    if (activity) return [{ id: `${turn.id}:${item.id || index}`, role: 'Activity', text: activity.text, activity }];
    const text = item.type === "userMessage"
      ? (item.content || []).map((part: any) => part.type === "text" ? part.text : ["image", "localImage", "inputImage"].includes(part.type) ? "\n[已添加图片]" : part.type === "file" ? `\n[已添加文件：${String(part.filename || part.name || "附件")}]` : "").filter(Boolean).join("\n")
      : item.type === "agentMessage" ? item.text : "";
    return typeof text === "string" && text ? [{ id: `${turn.id}:${item.id || index}`, role: item.type === "userMessage" ? "你" : "Agent", text }] : [];
  }));
}
