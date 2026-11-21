import React, { useEffect, useRef, useState } from "react";
import type { RelayClient } from "./relay-client";
import type { DeviceChannel } from "./crypto";
import { rows } from "./workspace-data";
import { agentCatalog } from "./task-catalog";
import { ArrowUp, Check, Monitor, Paperclip, Plus, Terminal } from "lucide-react";
import { Modal } from "./ui";
import { readPending, removePending, savePending } from "./pending-writes";
import { AttachmentList, attachmentAccept, attachmentParams, prepareAttachments, type Attachment } from "./attachments";

export function NewTask({ client, channel, hostId, receiptKey, onCreated, onBusy, onPending, disabled }: { client: RelayClient; channel?: DeviceChannel; hostId: string; receiptKey: string; onCreated: (thread: any) => void; onBusy: (value: boolean) => void; onPending: (value: boolean) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false); const [target, setTarget] = useState("desktop");
  const [agents, setAgents] = useState<any[]>([]), [agentId, setAgentId] = useState('codex');
  const [model, setModel] = useState(''), [effort, setEffort] = useState('');
  const [runtime, setRuntime] = useState<any>(); const [projects, setProjects] = useState<any[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [cwd, setCwd] = useState(""); const [text, setText] = useState(""); const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [reading, setReading] = useState(false); const readingRef = useRef(false); const alive = useRef(true); const input = useRef<HTMLInputElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [busy, setBusy] = useState(false); const [unknown, setUnknown] = useState<string | undefined>(() => readPending(receiptKey).find((item) => item.hostId === hostId && item.kind === "create")?.operationId);
  useEffect(() => {
    if (!open || !channel || unknown) return; let cancelled = false; setRuntime(undefined); setCatalogLoading(true);
    void Promise.all([client.call(channel, "host/runtime", {}), client.call(channel, "project/list", { target: agentId === 'codex' ? target : 'bridge' }), agentCatalog((m, p) => client.call(channel, m, p))]).then(([status, list, catalog]) => {
      if (cancelled) return; setRuntime(status); setProjects(rows(list)); setAgents(catalog); setCwd(previous => rows(list).some(row => row.cwd === previous) ? previous : rows(list)[0]?.cwd || ""); setMessage(list.warning || "");
    }).catch((error) => { if (!cancelled) setMessage(error.message); }).finally(() => { if (!cancelled) setCatalogLoading(false); });
    return () => { cancelled = true; };
  }, [open, target, agentId, client, channel, unknown]);
  useEffect(() => {
    if (!open || !channel || agents.every(row => row.available !== false)) return;
    let cancelled = false;
    const timer = window.setInterval(() => void agentCatalog((m, p) => client.call(channel, m, p)).then(value => { if (!cancelled) setAgents(value); }).catch(() => {}), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [open, channel, client, agents]);
  useEffect(() => { onPending(!!unknown); }, [unknown, onPending]);
  const reconcile = async (operationId: string) => {
    if (!channel) return;
    const receipt = await client.operation(channel, operationId);
    if (receipt.status === "succeeded") { removePending(receiptKey, operationId); setUnknown(undefined); setText(""); setAttachments([]); onCreated(receipt.result?.thread); setOpen(false); }
    else if (receipt.status === "failed") { removePending(receiptKey, operationId); setUnknown(undefined); setMessage("创建失败，可以修改内容后重新提交。"); }
    else { setUnknown(operationId); setMessage("创建结果待确认，请先查询；不会自动重复创建。"); }
  };
  const submit = async () => {
    if (busy || readingRef.current || disabled || unknown || !channel || !allowed || (!canAttach && attachments.length > 0) || !cwd || !text.trim()) return; const operationId = crypto.randomUUID(); setBusy(true); onBusy(true);
    savePending(receiptKey, { operationId, hostId, threadId: "", kind: "create" });
    try { const result = await client.call(channel, "thread/start", { cwd, text, target: agentId === 'codex' ? target : 'bridge', agentId, operationId, clientMessageId: operationId,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...attachmentParams(attachments) }); removePending(receiptKey, operationId); setText(""); setAttachments([]); onCreated(result.thread); setOpen(false); }
    catch (error: any) { if (error.notSent === true) { removePending(receiptKey, operationId); setMessage(error.message); }
      else { setUnknown(operationId); try { await reconcile(operationId); } catch { setMessage("连接已断开，创建结果待确认，请恢复连接后查询。"); } } }
    finally { setBusy(false); onBusy(false); }
  };
  const addFiles = async (selected: File[]) => {
    if (!selected.length || busy || unknown || readingRef.current) return;
    readingRef.current = true; setReading(true); onBusy(true); setMessage("");
    try { const next = await prepareAttachments(selected, attachments); if (alive.current) setAttachments(next); }
    catch (error: any) { if (alive.current) setMessage(error.message); }
    finally { readingRef.current = false; if (alive.current) { setReading(false); onBusy(false); } }
  };
  const selected = agents.find(row => row.id === agentId), models = selected?.models || [];
  const efforts = models.find((row: any) => row.id === model)?.supportedReasoningEfforts || [];
  const canAttach = selected?.capabilities?.attachments ?? agentId === 'codex';
  const allowed = !catalogLoading && (agentId === 'codex' ? target === "desktop" ? runtime?.desktop?.attachReady === true : runtime?.bridge?.readOnly === false : selected?.available === true);
  return <><button className="new-task-button" disabled={busy || (!unknown && (disabled || !channel))} onClick={() => setOpen(true)}><Plus size={18} /><span>{unknown ? "查询创建结果" : "新建任务"}</span><span className="subtle-shortcut">＋</span></button>
    {open && <Modal title="新建任务" onClose={() => { if (!busy && !reading) setOpen(false); }}><p className="modal-description">选择项目，告诉电脑你想完成什么。</p>
      <label className="form-label">Agent<select disabled={busy || !!unknown} value={agentId} onChange={event => { setAgentId(event.target.value); setModel(''); setEffort(''); }}>
        {agents.map(row => <option key={row.id} value={row.id} disabled={row.id !== 'codex' && row.available !== true}>{row.name || row.id}{row.available === false && row.id !== 'codex' ? ' · 暂不可用' : ''}</option>)}</select></label>
      {agentId === 'codex' && <div className="target-options">{[{ id: "desktop", name: "Desktop", description: "与桌面端共享对话", icon: <Monitor size={19} /> }, { id: "bridge", name: "Bridge", description: "由 Host 独立执行", icon: <Terminal size={19} /> }].map((item) => <button key={item.id} className={target === item.id ? "chosen" : ""} disabled={busy || !!unknown} aria-pressed={target === item.id} onClick={() => { setRuntime(undefined); setTarget(item.id); }}>{item.icon}<span>{item.name}<small>{item.description}</small></span>{target === item.id && <Check size={16} />}</button>)}</div>}
      {!!models.length && <label className="form-label">模型<select disabled={busy || !!unknown} value={model} onChange={event => { setModel(event.target.value); setEffort(''); }}><option value="">沿用电脑设置</option>{models.map((row: any) => <option key={row.id} value={row.id}>{row.displayName || row.id}</option>)}</select></label>}
      {!!efforts.length && <label className="form-label">推理档位<select disabled={busy || !!unknown} value={effort} onChange={event => setEffort(event.target.value)}><option value="">模型默认</option>{efforts.map((row: any) => <option key={row.reasoningEffort} value={row.reasoningEffort}>{row.description || row.reasoningEffort}</option>)}</select></label>}
      <label className="form-label">项目<select disabled={busy || catalogLoading || !!unknown || !channel} value={cwd} onChange={(event) => setCwd(event.target.value)}>{!projects.length && <option value="">暂无可用项目</option>}{projects.map((project) => <option key={project.cwd} value={project.cwd}>{project.name || project.cwd}</option>)}</select></label>
      <label className="form-label">任务内容<textarea rows={4} value={text} disabled={busy || !!unknown} onChange={(event) => setText(event.target.value)} placeholder="希望电脑帮你做什么？" /></label>
      <AttachmentList items={attachments} disabled={busy || reading || !!unknown} onRemove={index => setAttachments(items => items.filter((_, i) => i !== index))} />
      <input className="visually-hidden" ref={input} type="file" multiple tabIndex={-1} accept={attachmentAccept} onChange={event => { void addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
      {canAttach && <><button type="button" className="attach-file-button" disabled={busy || reading || !!unknown || attachments.length >= 3} onClick={() => input.current?.click()}><Paperclip size={16} />{reading ? "正在读取文件…" : "添加图片或文件"}</button>
      <p className="attachment-help">最多 3 个 · 图片 450 KiB / 文件 512 KiB · 合计 800 KiB<br />支持 JPG、PNG、WebP、PDF 和文本文件。</p></>}
      {!canAttach && !!attachments.length && <p className="modal-message">此 Agent 暂不支持附件，请先移除附件。</p>}
      {message && <p className="modal-message" role="status">{message}</p>}{runtime && !allowed && <p className="modal-message">所选执行位置暂未连接。</p>}
      <div className="modal-footer"><span>{channel ? "在你的电脑上执行" : "等待电脑重新连接"}</span>{unknown ? <button className="primary-button" disabled={busy || !channel} onClick={() => void reconcile(unknown).catch(() => setMessage("尚无法确认，请恢复连接后再查询。"))}>查询创建结果</button> : <button className="primary-button" disabled={busy || reading || disabled || !channel || !allowed || (!canAttach && attachments.length > 0) || !cwd || !text.trim()} onClick={() => void submit()}>创建任务<ArrowUp size={16} /></button>}</div>
    </Modal>}
  </>;
}
