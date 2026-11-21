import React, { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, Code2, Copy, File, Folder, LockKeyhole, LogOut, MessageSquare, Monitor, MoreHorizontal, Paperclip, Plus, RefreshCw, Search, Settings2, ShieldCheck, Square, Target, Terminal, X } from "lucide-react";
import { IconButton, Modal } from "./ui";
import { Markdown } from "./markdown";
import { ApprovalCard, type ApprovalItem } from "./approval-card";
import { groupQuestions, QuestionCard, type QuestionAnswers } from "./question-card";
import { activeTurn, agentName, backendLabel, conversationMessages, projectName, threadCapabilities, threadState, threadTitle, updatedLabel } from "./workspace-data";
import { SkinPicker } from "./skin-picker";
import { AttachmentList, attachmentAccept } from "./attachments";
import { ArtifactCard, type Artifact, type ArtifactCall } from "./artifacts";
import { activityStatus, currentProgress } from './thread-activity';

export type Draft = { text: string; plan: boolean; attachments: any[]; goal: string; model?: string; effort?: string };
export const emptyDraft = (): Draft => ({ text: "", plan: false, attachments: [], goal: "" });
export type WorkspaceViewProps = {
  hosts: any[]; host?: any; threads: any[]; detail?: any; connected: boolean; loading: boolean;
  busy: boolean; fresh: boolean; notice: string; accountName: string; draft: Draft; interactions: any[];
  artifacts?: Artifact[]; artifactNotice?: string; onArtifact?: ArtifactCall;
  modelOptions?: any;
  newTask?: React.ReactNode; hostPairing?: React.ReactNode; desktopWake?: React.ReactNode; deviceApproval?: React.ReactNode; deviceBusy?: boolean; passwordForm: React.ReactNode; pending: boolean;
  onHost: (host: any) => void; onThread: (thread: any) => void; onRefresh: () => void;
  onDraft: (patch: Partial<Draft>) => void; onFiles: (files: File[]) => void;
  onSend: () => void; onSteer: () => void; onInterrupt: () => void; onGoal: () => void; onReconcile: () => void;
  onApproval: (item: ApprovalItem, decision: string) => void; onAnswer: (id: string, answers: QuestionAnswers) => void;
  onLock: () => void; onLogout: () => void; onForget: () => void; onDismissNotice: () => void;
};

export function WorkspaceView(p: WorkspaceViewProps) {
  const [query, setQuery] = useState(""); const [hostMenu, setHostMenu] = useState(false);
  const [settings, setSettings] = useState(false); const [info, setInfo] = useState(false); const [goalOpen, setGoalOpen] = useState(false);
  const [mobileChat, setMobileChat] = useState(false); const [collapsed, setCollapsed] = useState<string[]>([]);
  const [showLatest, setShowLatest] = useState(false); const [toast, setToast] = useState("");
  const scroll = useRef<HTMLDivElement>(null); const composer = useRef<HTMLTextAreaElement>(null); const fileInput = useRef<HTMLInputElement>(null);
  const wasNearBottom = useRef(true);
  const thread = p.detail?.thread; const caps = threadCapabilities(thread); const status = threadState(thread);
  const readonly = caps.send !== true; const messages = conversationMessages(p.detail); const active = activeTurn(p.detail);
  const progress = currentProgress(p.detail, p.interactions);
  const available = p.connected && !p.loading && !p.busy && !p.pending;
  const visible = p.threads.filter((t) => `${threadTitle(t)} ${projectName(t)} ${agentName(t)}`.toLowerCase().includes(query.trim().toLowerCase()));
  // Group by full directory so identically named projects remain separate.
  const projects = [...new Set(visible.map((t) => t.cwd || ""))];
  const toBottom = (smooth = false) => scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(""), 2600); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setHostMenu(false); }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, []);
  useEffect(() => { setMobileChat(false); setQuery(""); }, [p.host?.id]);
  useEffect(() => { if (thread?.id) setMobileChat(true); setGoalOpen(false); setInfo(false); wasNearBottom.current = true; }, [thread?.id]);
  useEffect(() => { if (wasNearBottom.current) { const frame = requestAnimationFrame(() => { toBottom(); setShowLatest(false); }); return () => cancelAnimationFrame(frame); } }, [p.detail, mobileChat]);
  useEffect(() => { if (composer.current) { composer.current.style.height = "auto"; composer.current.style.height = Math.min(composer.current.scrollHeight, 144) + "px"; } }, [p.draft.text, thread?.id]);
  const copy = (text: string) => { void navigator.clipboard.writeText(text).then(() => setToast("已复制回复")).catch(() => setToast("复制失败，请手动选择文本")); };
  return <>
    <div className={`app workspace-shell ${mobileChat ? "chat-open" : ""}`}>
      <aside className="sidebar" aria-label="任务导航">
        <div className="brand-row"><div className="brand"><div className="brand-mark"><Terminal size={18} strokeWidth={2.4} /></div><strong>Agent Pocket</strong></div><span className="web-label">WEB</span></div>
        <div className="theme-scene" aria-hidden="true" />
        <div className="host-area"><button className={`host-switch ${p.host && !p.connected ? "offline-host" : ""}`} aria-expanded={hostMenu} onClick={() => setHostMenu(!hostMenu)} disabled={p.busy}>
          <Monitor size={18} /><span className="host-name">{p.host?.name || "选择你的电脑"}<small>{p.loading ? "正在同步…" : p.connected ? "在线 · 已连接" : p.host ? "未连接 · 最近快照" : `${p.hosts.length} 台电脑`}</small></span><span className={`status-dot ${p.connected ? "online" : ""}`} /><ChevronDown size={15} />
        </button>{hostMenu && <><button className="popover-dismiss" aria-label="关闭电脑选择" onClick={() => setHostMenu(false)} /><div className="host-popover" role="menu">{p.hosts.map((h) => <button key={h.id} role="menuitem" onClick={() => { p.onHost(h); setHostMenu(false); }}><Monitor size={17} /><span>{h.name}<small>{h.online ? "在线，可访问任务" : "离线，显示最近记录"}</small></span>{p.host?.id === h.id ? <Check size={16} /> : <span className={`status-dot ${h.online ? "online" : ""}`} />}</button>)}{!p.hosts.length && <p className="empty-hint">还没有连接的电脑</p>}</div></>}</div>
        {p.desktopWake}
        {p.hostPairing}
        {p.newTask || <button className="new-task-button" disabled><Plus size={18} />新建任务</button>}
        <div className="search"><Search size={16} /><input aria-label="搜索任务" placeholder="搜索任务…" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <IconButton label="清空搜索" onClick={() => setQuery("")}><X size={14} /></IconButton>}</div>
        <div className="list-heading"><span>任务 {p.loading && "· 同步中"}</span><span>{visible.length}</span></div>
        <nav className="task-list" aria-label="任务列表">{projects.map((cwd) => <section className="project-group" key={cwd}><button className="project-heading" title={cwd} onClick={() => setCollapsed((current) => current.includes(cwd) ? current.filter((v) => v !== cwd) : [...current, cwd])} aria-expanded={!collapsed.includes(cwd)}><ChevronRight size={13} className={collapsed.includes(cwd) ? "" : "expanded"} /><Folder size={13} /><span>{projectName({ cwd })}</span></button>
          {!collapsed.includes(cwd) && visible.filter((t) => (t.cwd || "") === cwd).map((t) => { const state = threadState(t); return <button className={`task-row ${thread?.id === t.id ? "selected" : ""}`} key={t.id} onClick={() => { setMobileChat(true); p.onThread(t); }} aria-current={thread?.id === t.id ? "page" : undefined} disabled={p.busy} title={threadTitle(t)}>
            <div className="task-row-top"><span className={`task-indicator ${state.kind}`}>{state.kind === "active" ? <span className="activity-dot" /> : state.kind === "review" ? <span className="review-dot" /> : <MessageSquare size={14} />}</span><span className="task-title">{threadTitle(t)}</span></div>
            <div className="task-row-meta"><span>{state.kind === "active" || state.kind === "review" ? state.label : backendLabel(t)} · {agentName(t)}</span><span>{updatedLabel(t.updatedAt)}</span></div>
          </button>; })}</section>)}{!visible.length && <div className="search-empty"><Search size={22} /><p>{p.loading ? "正在同步任务" : query ? "没有找到相关任务" : p.host ? "还没有可显示的任务" : "先选择一台电脑"}</p><small>{query ? "试试其他关键词" : "电脑上的任务会显示在这里"}</small></div>}</nav>
        <div className="sidebar-footer"><div className="account-row"><div className="avatar account-avatar">{p.accountName.slice(0, 1)}</div><span>{p.accountName}<small>你的电脑，你的任务</small></span><IconButton label="账号与设置" onClick={() => setSettings(true)}><Settings2 size={17} /></IconButton></div></div>
      </aside>
      <main className="main-panel">
        <div className="landscape" aria-hidden="true" />
        <header className="conversation-header"><IconButton className="mobile-back" label="返回任务列表" onClick={() => setMobileChat(false)}><ArrowLeft size={20} /></IconButton><div className="conversation-heading"><div className="breadcrumb"><Folder size={12} /><span>{thread ? projectName(thread) : p.host?.name || "工作台"}</span>{thread && <><span className="breadcrumb-divider">/</span><span>{backendLabel(thread)}</span></>}</div><h1>{thread ? threadTitle(thread) : "你的任务工作台"}</h1></div>
          {thread && <span className={`task-status ${status.kind}`} title={status.label}><span />{status.label}</span>}<IconButton label="刷新任务" onClick={p.onRefresh} disabled={p.loading || p.busy || !p.host}><RefreshCw size={17} /></IconButton>{thread && <IconButton label="任务信息" onClick={() => setInfo(true)}><MoreHorizontal size={20} /></IconButton>}
        </header>
        {p.notice && <div className="workspace-notice" role="status"><span>{p.notice}</span><IconButton label="关闭提示" onClick={p.onDismissNotice}><X size={14} /></IconButton></div>}
        {p.host && !p.connected && <div className="offline-banner"><span className="status-dot" />连接恢复后可继续操作，草稿保留在当前页面。</div>}
        <div className="message-scroll" ref={scroll} aria-busy={p.loading} onScroll={(e) => { const n = e.currentTarget; const far = n.scrollHeight - n.scrollTop - n.clientHeight > 180; wasNearBottom.current = !far; setShowLatest(far); }}>
          {!thread ? <div className="workspace-empty"><div className="empty-mark"><MessageSquare size={26} /></div><h2>{p.loading ? "正在读取任务…" : "从一项任务开始"}</h2><p>选择左侧任务查看对话，或连接电脑后新建任务。</p><small>关闭网页后，电脑上的任务会继续运行。</small></div> : <div className="message-column">
            {p.detail?.page?.hasMore && <div className="history-note">当前显示最近一页对话，完整历史可在电脑端查看</div>}
            {messages.map((message, index) => message.activity ? <details className="execution-detail" key={message.id}>
              <summary><span>{message.activity.title}</span><small>{activityStatus(message.activity.status)}</small>
                {message.text && <span className="execution-preview">{message.text.replace(/\s+/g, ' ').slice(0, 180)}</span>}</summary>
              <pre>{message.text || (message.activity.title === '思考摘要' ? '模型未提供公开思考摘要' : '等待更多执行信息')}</pre>
            </details> : <section key={message.id} className={`message ${message.role === "你" ? "user" : "assistant"}`} aria-label={message.role === "你" ? "你的消息" : "助手回复"}>
              {message.role !== "你" && <div className="message-byline"><div className="assistant-mark"><Terminal size={12} /></div><span>{agentName(thread)}</span></div>}
              <div className="message-body"><Markdown text={message.text} />{p.artifacts?.some(item => item.messageId === message.id) && <div className="artifact-list">{p.artifacts.filter(item => item.messageId === message.id).map((item, i) => <ArtifactCard key={`${p.host?.id}:${thread.id}:${item.id || item.source}:${i}`} artifact={item} call={p.onArtifact} connected={p.connected} />)}</div>}</div>
              {message.role !== "你" && index === messages.length - 1 && <div className="message-actions"><IconButton label="复制回复" onClick={() => copy(message.text)}><Copy size={14} /></IconButton></div>}
            </section>)}
            {!messages.length && <p className="empty-hint">{p.loading ? "正在读取对话…" : "暂无可显示的对话内容"}</p>}
            {p.artifactNotice && <p className="artifact-note">{p.artifactNotice}</p>}
            {p.interactions.filter((item) => item.type === "pocketApproval").map((item) => <ApprovalCard key={item.id || item.requestId} item={item} capability={caps.approval === true} connected={p.connected && p.fresh} busy={p.busy || p.pending} onDecision={p.onApproval} />)}
            {groupQuestions(p.interactions).map((items) => <QuestionCard key={`${p.host?.id}:${thread.id}:${items[0].requestId}`} items={items} fresh={p.connected && p.fresh} capable={caps.question === true} busy={p.busy || p.pending} onAnswer={p.onAnswer} />)}
            {p.interactions.filter((item) => !["pocketApproval", "pocketQuestion"].includes(item.type)).map((item, i) => <div className="readonly-note" key={item.id || i}>{item.summary || item.unavailableReason || "请在电脑端查看此交互"}</div>)}
            {progress && <div className="running-line execution-progress" role="status"><span className="activity-dot" /><div>
              <strong>{p.connected ? progress.title : '连接恢复中 · 最近进展'}</strong><span>{progress.text}</span>
            </div></div>}<div className="scroll-bottom" />
          </div>}
        </div>
        {thread && <div className="composer-dock">{showLatest && <button className="jump-latest" onClick={() => toBottom(true)}><ArrowDown size={15} />回到最新</button>}<div className="composer-column">
          {p.pending && <div className="pending-note"><span>上次操作结果待确认，暂不重复提交。</span><button disabled={!p.connected || p.busy} onClick={p.onReconcile}>查询结果</button></div>}
          {readonly && <div className="readonly-note"><LockKeyhole size={14} />{thread.execution?.readOnlyReason || "这条任务当前仅可查看，请在电脑上继续操作。"}</div>}
          {p.modelOptions?.controlScope !== 'none' && !!p.modelOptions?.data?.length && <div className="model-controls">
            <label className="form-label">模型<select value={p.draft.model || ''} disabled={!available || !!active} onChange={event => p.onDraft({ model: event.target.value || undefined, effort: undefined })}>
              <option value="">沿用会话</option>{p.modelOptions.data.map((row: any) => <option key={row.id} value={row.id}>{row.displayName || row.id}</option>)}</select></label>
            {!!p.modelOptions.data.find((row: any) => row.id === p.draft.model)?.supportedReasoningEfforts?.length && <label className="form-label">推理档位<select value={p.draft.effort || ''} disabled={!available || !!active} onChange={event => p.onDraft({ effort: event.target.value || undefined })}>
              <option value="">模型默认</option>{p.modelOptions.data.find((row: any) => row.id === p.draft.model).supportedReasoningEfforts.map((row: any) => <option key={row.reasoningEffort} value={row.reasoningEffort}>{row.description || row.reasoningEffort}</option>)}</select></label>}
            {p.modelOptions.controlScope === 'shared' && <small>作用于共享会话的下一请求，请在电脑与手机之间交替发送。</small>}
          </div>}
          <div className={`composer-box ${!p.connected || readonly ? "disabled" : ""}`}>
            <div aria-hidden="true" className={`pocket-companion ${active ? "working" : status.kind === "review" ? "waiting" : messages.length ? "done" : ""}`} />
            <AttachmentList items={p.draft.attachments} disabled={p.busy || p.pending} onRemove={index => p.onDraft({ attachments: p.draft.attachments.filter((_, i) => i !== index) })} />
            <textarea ref={composer} aria-label="输入消息" value={p.draft.text} rows={2} disabled={readonly || p.loading || p.busy || p.pending} placeholder={readonly ? "当前任务仅供查看" : p.connected ? "继续这项任务…" : "连接已断开，仍可编辑草稿…"} onChange={(e) => p.onDraft({ text: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(min-width: 761px)").matches) { e.preventDefault(); if (available && !readonly && p.draft.text.trim()) p.onSend(); } }} />
            <div className="composer-toolbar"><div className="composer-tools"><input className="visually-hidden" ref={fileInput} tabIndex={-1} type="file" multiple onChange={(e) => { p.onFiles(Array.from(e.target.files || [])); e.target.value = ""; }} accept={attachmentAccept} />
              <IconButton label="添加图片或文件（最多 3 个）" onClick={() => fileInput.current?.click()} disabled={readonly || !caps.attachments || p.busy || p.pending || p.loading}><Paperclip size={18} /></IconButton>
              {caps.plan === true && <button className={`plan-toggle ${p.draft.plan ? "enabled" : ""}`} aria-pressed={p.draft.plan} disabled={p.busy || p.pending} onClick={() => p.onDraft({ plan: !p.draft.plan })}><Code2 size={15} />Plan</button>}
              {caps.goal === true && <IconButton label="设置任务目标" onClick={() => setGoalOpen(true)} disabled={!available}><Target size={17} /></IconButton>}
              <span className="composer-context"><span className={`status-dot ${p.connected ? "online" : ""}`} />{backendLabel(thread)}</span>
            </div><div className="composer-send"><span className="enter-hint">Shift ↵ 换行</span>
              {active && caps.steer && caps.send === true && <IconButton label="追加指令" disabled={!available || !p.draft.text.trim() || !!p.draft.attachments.length} onClick={p.onSteer}><Plus size={18} /></IconButton>}
              {active && caps.interrupt === true && <IconButton label="中断当前任务" className="stop-button" disabled={!available} onClick={p.onInterrupt}><Square size={13} /></IconButton>}
              <IconButton label="发送消息" className="send-button" disabled={!available || readonly || !!active || !p.draft.text.trim()} onClick={p.onSend}><ArrowUp size={19} /></IconButton>
            </div></div>
          </div><div className="composer-footnote"><ShieldCheck size={12} /><span>任务在你的电脑上执行，关闭网页后仍会继续。</span></div>
        </div></div>}
      </main>
    </div>
    {toast && <div className="toast" role="status"><Check size={15} />{toast}</div>}
    {settings && <Modal title="账号与设备" onClose={() => { if (!p.deviceBusy) setSettings(false); }}><div className="settings-account"><div className="avatar">{p.accountName.slice(0, 1)}</div><div><strong>{p.accountName}</strong><span>当前浏览器</span></div></div>
      <div className="settings-options"><SkinPicker />{p.deviceApproval}<button disabled={p.deviceBusy} onClick={p.onLock}><LockKeyhole size={18} /><span>锁定网页<small>清除本页内容，保留加密设备记录</small></span><ChevronRight size={16} /></button><div inert={p.deviceBusy || undefined}>{p.passwordForm}</div><button disabled={p.deviceBusy} onClick={p.onLogout}><LogOut size={18} /><span>退出登录<small>下次使用时重新认证</small></span><ChevronRight size={16} /></button><button disabled={p.deviceBusy} onClick={p.onForget}><X size={18} /><span>忘记此浏览器<small>删除本地设备记录并尝试撤销设备</small></span></button></div>
    </Modal>}
    {info && <Modal title="任务信息" onClose={() => setInfo(false)}><dl className="task-info"><dt>任务</dt><dd>{threadTitle(thread)}</dd><dt>项目目录</dt><dd>{thread?.cwd || "未提供"}</dd><dt>执行位置</dt><dd>{agentName(thread)} · {backendLabel(thread)}</dd><dt>状态</dt><dd>{status.label}</dd></dl><p className="modal-description">操作权限由电脑端确认，不能通过切换执行位置获取写入权限。</p></Modal>}
    {goalOpen && <Modal title="任务目标" onClose={() => setGoalOpen(false)}><label className="form-label">希望持续完成什么？<textarea rows={4} value={p.draft.goal} onChange={(e) => p.onDraft({ goal: e.target.value })} disabled={p.busy || p.pending} /></label><div className="modal-footer"><span>由当前 Bridge 任务执行</span><button className="primary-button" disabled={!available || !p.draft.goal.trim() || caps.goal !== true} onClick={() => { p.onGoal(); setGoalOpen(false); }}>保存目标</button></div></Modal>}
  </>;
}
