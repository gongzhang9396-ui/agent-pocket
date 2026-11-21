import React, { useEffect, useRef, useState } from "react";
import { validateAttachmentBudget, type AccountPackage, type DeviceKeys, type DeviceChannel } from "./crypto";
import { RelayClient } from "./relay-client";
import { type ApprovalItem } from "./approval-card";
import { questionActionable, type QuestionAnswers } from "./question-card";
import { activeTurn, conversationMessages, rows, threadCapabilities, threadAgentId } from "./workspace-data";
import { loadTaskCatalog } from "./task-catalog";
import { applyWorkspaceEvent, eventItemKey, mergeWorkspaceRead } from './workspace-live';
import { runningStatus } from './thread-activity';
import { NewTask } from "./new-task";
import { emptyDraft, WorkspaceView, type Draft } from "./workspace-view";
import { pendingKey, readPending, removePending, savePending } from "./pending-writes";
import { HostPairing } from "./host-pairing";
import { DeviceApproval } from "./device-approval-view";
import { DesktopWake } from "./desktop-wake";
import { prepareAttachments } from "./attachments";
import type { Artifact } from "./artifacts";

type Attempt = { operationId: string; hostId: string; threadId: string; requestId?: string; decision?: string;
  answers?: QuestionAnswers; status: "submitting" | "unknown" | "succeeded"; success: string; clearDraft?: boolean };

export function Workspace({ state, keys, pkg, passwordForm, initialPairing = "", onPairingConsumed = () => {}, onLock, onLogout, onForget, onRevoked, onTokens }: {
  state: any; keys: DeviceKeys; pkg: AccountPackage; passwordForm: React.ReactNode;
  initialPairing?: string; onPairingConsumed?: () => void;
  onLock: () => void; onLogout: () => void; onForget: () => void; onRevoked: () => void; onTokens: (tokens: any) => void;
}) {
  const [client, setClient] = useState<RelayClient>(); const [hosts, setHosts] = useState<any[]>([]);
  const [host, setHost] = useState<any>(); const [channel, setChannel] = useState<DeviceChannel>();
  const [threads, setThreads] = useState<any[]>([]); const [detail, setDetail] = useState<any>();
  const [modelOptions, setModelOptions] = useState<any>();
  const [busy, setBusy] = useState(false); const [newTaskPending, setNewTaskPending] = useState(false);
  const [relayConnected, setRelayConnected] = useState(false); const [pairingBusy, setPairingBusy] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [wakeBusy, setWakeBusy] = useState(false);
  const [loading, setLoading] = useState(false); const [notice, setNotice] = useState("");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]); const [artifactNotice, setArtifactNotice] = useState("");
  const [fileReading, setFileReading] = useState(false); const fileReadingRef = useRef(false);
  const [fresh, setFresh] = useState(false); const [syncTick, setSyncTick] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}); const [, renderAttempts] = useState(0);
  const hostRef = useRef<any>(undefined); const channelRef = useRef<DeviceChannel | undefined>(undefined);
  const detailRef = useRef<any>(undefined); const busyRef = useRef(false); const alive = useRef(true);
  const hostEpoch = useRef(0); const readEpoch = useRef(0); const revision = useRef(new Map<string, number>());
  const hostListEpoch = useRef(0);
  const liveRevision = useRef(0); const liveVersions = useRef(new Map<string, number>());
  const receiptKey = pendingKey(state.account.id, state.device.id);
  const [attemptStore] = useState(() => new Map<string, Attempt>(readPending(receiptKey).filter((item) => item.kind !== "create").map((item) => [
    `${item.hostId}:${item.threadId}:${item.requestId || "write"}`, { ...item, status: "unknown", success: "上次操作已完成，正在同步" },
  ])));
  const attempts = useRef(attemptStore); const confirmed = useRef(new Map<string, any>());
  const callbacks = useRef({ onTokens, onRevoked }); callbacks.current = { onTokens, onRevoked };
  const scope = `${host?.id || ""}:${detail?.thread?.id || ""}`;
  useEffect(() => {
    setModelOptions(undefined); const threadId = detail?.thread?.id;
    if (!client || !channel || !threadId) return;
    let cancelled = false;
    void client.call(channel, 'thread/model-options', { threadId }).then(value => { if (!cancelled && channelRef.current === channel) setModelOptions(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, [client, channel, scope]);
  const artifactSignature = conversationMessages(detail).filter(item => item.role === 'Agent').map(item => `${item.id}:${item.text}`).join("\n");
  const draft = drafts[scope] || emptyDraft(); const caps = threadCapabilities(detail?.thread);
  const writeBusy = (value: boolean) => { busyRef.current = value; setBusy(value); };
  const setCurrentDetail = (value: any) => { detailRef.current = value; setDetail(value); };
  const setCurrentChannel = (value?: DeviceChannel) => { channelRef.current = value; setChannel(value); };
  const attemptKey = (value: Attempt) => `${value.hostId}:${value.threadId}:${value.requestId || "write"}`;
  const bump = () => { if (alive.current) renderAttempts((n) => n + 1); };
  const draftPatch = (patch: Partial<Draft>, key = scope) => setDrafts((current) => ({ ...current, [key]: { ...(current[key] || emptyDraft()), ...patch } }));
  const noticeIfCurrent = (hostId: string, message: string) => { if (alive.current && hostRef.current?.id === hostId) setNotice(message); };
  const mergeInteractions = (items: any[], hostId: string, threadId: string) => items.map((item) => {
    const identity = `${hostId}:${threadId}:${item.id || item.requestId}`;
    // A completed Desktop question may still be available=true. A stale read
    // must never turn that completed interaction back into an action button.
    if (item.decision || item.selectedOption != null) confirmed.current.set(identity, { decision: item.decision, selectedOption: item.selectedOption });
    const known = confirmed.current.get(identity); const attempt = attempts.current.get(`${hostId}:${threadId}:${item.requestId}`);
    if (known) return { ...item, ...known, available: false };
    if (!attempt) return item;
    if (attempt.status === "succeeded") return { ...item, available: false, submissionState: "succeeded", decision: attempt.decision || item.decision,
      selectedOption: attempt.answers?.[item.questionId || "question"]?.answers.join("、") ?? item.selectedOption };
    return { ...item, available: false, submissionState: attempt.status };
  });
  const commitDetail = (value: any, hostId: string) => {
    const items = value?.thread?.interactionItems || value?.interactions || [];
    setCurrentDetail({ ...value, thread: { ...value.thread, interactionItems: mergeInteractions(items, hostId, value.thread.id) } });
  };
  const snapshot = async (current: RelayClient, selected: any, epoch: number) => {
    const value = await current.snapshot(selected.id);
    if (!alive.current || epoch !== hostEpoch.current || !value) return;
    const next = Number(value.revision || value.snapshotRevision || 0);
    if (next < (revision.current.get(selected.id) || 0)) return;
    revision.current.set(selected.id, next); if (value.threads) setThreads(rows(value.threads));
  };
  const choose = async (selected: any, current = client, restoring = false) => {
    if (!current || busyRef.current) return;
    const epoch = ++hostEpoch.current; ++readEpoch.current;
    hostRef.current = selected; setHost(selected); setCurrentChannel(); setFresh(false); setLoading(true); setNotice("");
    if (!restoring) { setCurrentDetail(undefined); setThreads([]); }
    try {
      try { await snapshot(current, selected, epoch); } catch { /* Live catalog can still be available. */ }
      if (!alive.current || epoch !== hostEpoch.current) return;
      try { await current.replay(selected.id); } catch (error: any) {
        if ((error.nameCode || error.code) === "EVENT_GAP") await snapshot(current, selected, epoch);
      }
      if (!alive.current || epoch !== hostEpoch.current) return;
      const opened = await current.openChannel(selected);
      if (!alive.current || epoch !== hostEpoch.current) return;
      setCurrentChannel(opened);
      const list = await loadTaskCatalog(opened, (m, p) => current.call(opened, m, p));
      if (!alive.current || epoch !== hostEpoch.current) return;
      setThreads(rows(list)); setSyncTick((n) => n + 1);
    } catch (error: any) { if (epoch === hostEpoch.current) noticeIfCurrent(selected.id, selected.online ? error.message : "电脑离线，当前显示最近快照"); }
    finally { if (alive.current && epoch === hostEpoch.current) setLoading(false); }
  };
  const read = async (thread: any) => {
    if (busyRef.current || !hostRef.current) return;
    const currentChannel = channelRef.current; const hostId = hostRef.current.id; const epoch = ++readEpoch.current;
    liveVersions.current.clear(); const liveCut = ++liveRevision.current;
    setFresh(false); setCurrentDetail({ thread: { ...thread, interactionItems: [] } });
    if (!client || !currentChannel) { setNotice("当前仅有任务快照，恢复连接后可读取对话"); return; }
    setLoading(true);
    try {
      const result = await client.call(currentChannel, "thread/read", { threadId: thread.id });
      if (alive.current && epoch === readEpoch.current && currentChannel === channelRef.current && hostId === hostRef.current?.id) {
        commitDetail(mergeWorkspaceRead(result, detailRef.current, new Set([...liveVersions.current].filter(([, rev]) => rev > liveCut).map(([id]) => id))), hostId);
      }
    } catch (error: any) { if (epoch === readEpoch.current) noticeIfCurrent(hostId, error.message); }
    finally { if (alive.current && epoch === readEpoch.current) setLoading(false); }
  };
  const refreshHosts = async (current: RelayClient) => {
    const generation = ++hostListEpoch.current;
    const available = rows(await current.listHosts());
    if (!alive.current || generation !== hostListEpoch.current) return;
    setHosts(available);
    const prior = hostRef.current; const selected = prior ? available.find((h) => h.id === prior.id) : available.length === 1 ? available[0] : undefined;
    if (selected) {
      hostRef.current = selected; setHost(selected);
      if (!channelRef.current && selected.online) void choose(selected, current, !!prior);
    }
  };

  useEffect(() => {
    alive.current = true;
    const current = new RelayClient(state.tokens.accessToken, state.tokens.refreshToken, state.account.id, state.device.id, keys, pkg.contentKey, (tokens) => callbacks.current.onTokens(tokens));
    setClient(current);
    current.on((event) => {
      if (!alive.current) return;
      if (event.type === "connected" || event.type === "host/status") {
        if (event.type === "connected") setRelayConnected(true);
        void refreshHosts(current).catch((error) => { if (alive.current) setNotice(error.message); });
      }
      if ((event.type === "event" || event.type === "recovered") && (!event.hostId || event.hostId === hostRef.current?.id)) {
        if (event.type === 'event' && !event.replayed) {
          const value = applyWorkspaceEvent(detailRef.current, event.value);
          if (value) {
            liveVersions.current.set(eventItemKey(event.value)!, ++liveRevision.current);
            setCurrentDetail(value);
            if (['message.delta', 'activity.updated', 'command.updated'].includes(event.value.type) && !event.value.payload?.complete) return;
          }
        }
        setSyncTick((n) => n + 1);
      }
      if (event.type === "gap" && event.hostId === hostRef.current?.id) setNotice("正在补齐任务记录…");
      if (event.type === "closed") { ++hostEpoch.current; ++readEpoch.current; ++hostListEpoch.current; setRelayConnected(false); setCurrentChannel(); setFresh(false); setLoading(false); setNotice(event.recovering ? "正在刷新登录会话…" : "连接已断开，恢复后会自动同步"); }
      if (event.type === "expired" || event.type === "revoked") callbacks.current.onRevoked();
      if (event.type === "error") setNotice(event.error?.message || "同步暂时失败，请刷新任务");
    });
    void current.connect().catch((error) => { if (alive.current) setNotice(error.message); });
    const resume = () => { if (document.visibilityState === "visible") {
      if (current.socket?.readyState !== WebSocket.OPEN) void current.reconnect().catch(() => undefined);
      else if (hostRef.current && !channelRef.current) void choose(hostRef.current, current, true);
      else setSyncTick((n) => n + 1);
    } };
    document.addEventListener("visibilitychange", resume);
    return () => { alive.current = false; ++hostEpoch.current; ++readEpoch.current; document.removeEventListener("visibilitychange", resume); void current.close(); };
  }, [keys, pkg.contentKey, state.account.id, state.device.id]);
  useEffect(() => {
    navigator.serviceWorker?.controller?.postMessage({ type: "write-state", active: busy || newTaskPending || pairingBusy || deviceBusy || wakeBusy });
    return () => navigator.serviceWorker?.controller?.postMessage({ type: "write-state", active: false });
  }, [busy, newTaskPending, pairingBusy, deviceBusy, wakeBusy]);
  const anyPending = [...attempts.current.values()].some((attempt) => attempt.status !== "succeeded");
  useEffect(() => {
    if (!busy && !newTaskPending && !pairingBusy && !deviceBusy && !wakeBusy && !anyPending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy, newTaskPending, pairingBusy, deviceBusy, wakeBusy, anyPending]);
  useEffect(() => {
    if (!client || !channel || !host || !syncTick) return;
    let cancelled = false; const epoch = readEpoch.current; const threadId = detailRef.current?.thread?.id;
    const liveCut = liveRevision.current;
    const valid = () => !cancelled && alive.current && channelRef.current === channel;
    void loadTaskCatalog(channel, (m, p) => client.call(channel, m, p)).then((value) => { if (valid()) setThreads(rows(value)); }).catch(() => undefined);
    if (threadId) void client.call(channel, "thread/read", { threadId }).then((value) => {
      if (valid() && epoch === readEpoch.current && detailRef.current?.thread?.id === threadId) {
        // Keep the newer interaction poll and its capabilities until the next
        // poll; a slower history read must not make an old approval actionable.
        const latest = detailRef.current.thread;
        const merged = mergeWorkspaceRead(value, detailRef.current, new Set([...liveVersions.current].filter(([, rev]) => rev > liveCut).map(([id]) => id)));
        commitDetail({ ...merged, thread: { ...merged.thread, execution: latest.execution, capabilities: latest.capabilities, interactionItems: latest.interactionItems } }, host.id);
        for (const [id, rev] of liveVersions.current) if (rev <= liveCut) liveVersions.current.delete(id);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [syncTick, client, channel, host?.id]);
  useEffect(() => {
    if (!client || !channel || !detail?.thread?.id) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && (activeTurn(detailRef.current) || runningStatus(detailRef.current?.thread?.status))) setSyncTick(n => n + 1);
    }, 4000);
    return () => clearInterval(timer);
  }, [client, channel, detail?.thread?.id]);
  useEffect(() => {
    setFresh(false);
    if (!client || !channel || !detail?.thread?.id || loading) return;
    const threadId = detail.thread.id; let cancelled = false; let running = false; let visibilityEpoch = 0;
    const refresh = async () => {
      if (cancelled || running || document.visibilityState !== "visible") return;
      running = true; const epoch = visibilityEpoch;
      try {
        const result = await client.call(channel, "thread/interactions", { threadId });
        if (cancelled || epoch !== visibilityEpoch || document.visibilityState !== "visible" || channelRef.current !== channel || detailRef.current?.thread?.id !== threadId) return;
        const previous = detailRef.current;
        commitDetail({ ...previous, thread: { ...previous.thread, execution: result.execution || previous.thread.execution,
          capabilities: result.execution?.capabilities || previous.thread.capabilities, interactionItems: result.items || [] } }, channel.hostId);
        setFresh(true);
      } catch { if (!cancelled) setFresh(false); }
      finally { running = false; }
    };
    const visible = () => { visibilityEpoch++; setFresh(false); if (document.visibilityState === "visible") void refresh(); };
    void refresh(); const timer = window.setInterval(() => void refresh(), 4000); document.addEventListener("visibilitychange", visible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [client, channel, detail?.thread?.id, loading, syncTick]);

  useEffect(() => {
    const thread = detail?.thread;
    if (!client || !channel || !thread?.id || threadAgentId(thread) !== 'dsh') return;
    const threadId = thread.id; let leaseId: string = crypto.randomUUID(); let cancelled = false; const running = new Set<string>();
    const release = (lease = leaseId) => { if (lease) void client.call(channel, 'thread/unwatch', { threadId, leaseId: lease }).catch(() => {}); };
    const renew = async () => {
      const lease = leaseId;
      if (cancelled || !lease || running.has(lease) || document.visibilityState !== 'visible') return;
      running.add(lease);
      try { await client.call(channel, 'thread/watch', { threadId, leaseId: lease }); } catch {} finally {
        running.delete(lease); if (cancelled || leaseId !== lease || document.visibilityState !== 'visible') release(lease);
      }
    };
    const visibility = () => { if (document.visibilityState === 'visible') { leaseId = crypto.randomUUID(); void renew(); } else { const old = leaseId; leaseId = ''; release(old); } };
    void renew(); const timer = window.setInterval(() => void renew(), 15000); document.addEventListener('visibilitychange', visibility);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener('visibilitychange', visibility); const old = leaseId; leaseId = ''; release(old); };
  }, [client, channel, detail?.thread?.id]);

  useEffect(() => { setArtifacts([]); setArtifactNotice(""); }, [scope, channel]);
  useEffect(() => {
    let cancelled = false;
    const threadId = detail?.thread?.id;
    if (!client || !channel || !threadId || !/\]\(/.test(artifactSignature)) return;
    const timer = window.setTimeout(() => {
      void client.call(channel, "artifact/list", { threadId }).then(result => {
        if (!cancelled && channelRef.current === channel && detailRef.current?.thread?.id === threadId) { setArtifacts(rows(result)); setArtifactNotice(""); }
      }).catch(error => { if (!cancelled) setArtifactNotice(/未知方法[：:]\s*artifact\/list/.test(error.message) ? "电脑端尚未支持文件预览，请更新 Host。" : "文件列表暂未读到，刷新任务可重试。"); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, channel, scope, artifactSignature]);
  const artifactCall = async (method: string, params: any) => {
    const currentChannel = channel; const threadId = detail?.thread?.id;
    if (!client || !currentChannel || !threadId) throw new Error("电脑未连接");
    const result = await client.call(currentChannel, method, { ...params, threadId });
    if (!alive.current || channelRef.current !== currentChannel || detailRef.current?.thread?.id !== threadId) throw new Error("已切换任务，请重新读取文件");
    return result;
  };

  const resolveAttempt = (attempt: Attempt, receipt: any) => {
    if (receipt.status === "succeeded") {
      removePending(receiptKey, attempt.operationId);
      attempt.status = "succeeded";
      if (attempt.clearDraft) draftPatch({ text: "", attachments: [] }, `${attempt.hostId}:${attempt.threadId}`);
      if (!attempt.requestId) attempts.current.delete(attemptKey(attempt));
      noticeIfCurrent(attempt.hostId, attempt.success); setSyncTick((n) => n + 1);
    } else if (receipt.status === "failed") {
      removePending(receiptKey, attempt.operationId);
      attempts.current.delete(attemptKey(attempt)); noticeIfCurrent(attempt.hostId, receipt.error?.message || "操作未成功，可确认后重新提交");
    } else { attempt.status = "unknown"; noticeIfCurrent(attempt.hostId, "操作结果待确认，请查询结果；不会自动重复提交。"); }
    bump();
  };
  const operation = async (method: string, params: any, success: string, extra: Partial<Attempt> = {}) => {
    if (!client || !channel || busyRef.current || !detail?.thread?.id || loading) return;
    if ([...attempts.current.values()].some((a) => a.hostId === channel.hostId && a.threadId === detail.thread.id && a.status !== "succeeded")) return;
    const attempt: Attempt = { operationId: crypto.randomUUID(), hostId: channel.hostId, threadId: detail.thread.id, status: "submitting", success, ...extra };
    if (attempts.current.has(attemptKey(attempt))) return;
    attempts.current.set(attemptKey(attempt), attempt); savePending(receiptKey, attempt); writeBusy(true); bump();
    try {
      await client.call(channel, method, { ...params, operationId: attempt.operationId, clientMessageId: attempt.operationId });
      if (alive.current) resolveAttempt(attempt, { status: "succeeded" });
    } catch (error: any) {
      if (error.notSent === true) { resolveAttempt(attempt, { status: "failed", error }); return; }
      attempt.status = "unknown";
      try { const receipt = await client.operation(channel, attempt.operationId); if (alive.current) resolveAttempt(attempt, receipt); }
      catch { noticeIfCurrent(attempt.hostId, "连接或操作结果待确认，请恢复连接后查询；不会重复提交。"); }
    } finally { if (alive.current) { writeBusy(false); setFresh(false); bump(); setSyncTick((n) => n + 1); } }
  };
  const pending = [...attempts.current.values()].some((a) => `${a.hostId}:${a.threadId}` === scope && a.status !== "succeeded");
  const reconcile = async () => {
    if (!client || !channel || busyRef.current) return; writeBusy(true);
    try { for (const attempt of attempts.current.values()) if (`${attempt.hostId}:${attempt.threadId}` === scope && attempt.status !== "succeeded") {
      const receipt = await client.operation(channel, attempt.operationId); if (alive.current) resolveAttempt(attempt, receipt);
    } } catch { setNotice("尚无法确认，请恢复连接后再查询，或在电脑端查看。"); }
    finally { if (alive.current) writeBusy(false); }
  };
  const send = async () => {
    if (fileReadingRef.current || caps.send !== true || !draft.text.trim()) return;
    if (activeTurn(detail)) { setNotice(caps.steer ? '任务运行中，请使用追加指令按钮。' : '任务正在运行，请等待完成或中断后再发送。'); return; }
    try { validateAttachmentBudget(draft.attachments); } catch (error: any) { setNotice(error.message); return; }
    if (draft.attachments.length && !caps.attachments) { setNotice("当前任务不允许附件"); return; }
    const params: any = { threadId: detail.thread.id, text: draft.text };
    if (draft.model) params.model = draft.model;
    if (draft.effort) params.effort = draft.effort;
    if (draft.plan && caps.plan === true) params.mode = "plan";
    if (draft.attachments.length) {
      params.images = draft.attachments.filter((item) => item.mimeType.startsWith("image/")).map(({ mimeType, data }) => ({ mimeType, data }));
      params.files = draft.attachments.filter((item) => !item.mimeType.startsWith("image/")).map(({ filename, mimeType, data }) => ({ filename, mimeType, data }));
    }
    await operation("turn/start", params, "消息已提交，进度会自动同步", { clearDraft: true });
  };
  const files = async (selectedFiles: File[]) => {
    if (!selectedFiles.length || fileReadingRef.current || !caps.attachments || caps.send !== true || busyRef.current || pending) return;
    const key = scope;
    fileReadingRef.current = true; setFileReading(true);
    try { const next = await prepareAttachments(selectedFiles, draft.attachments); if (alive.current) draftPatch({ attachments: next }, key); }
    catch (error: any) { if (alive.current) setNotice(error.message); }
    finally { fileReadingRef.current = false; if (alive.current) setFileReading(false); }
  };
  const interactions = mergeInteractions(detail?.thread?.interactionItems || [], host?.id, detail?.thread?.id);
  const answer = (requestId: string, answers: QuestionAnswers) => {
    const items = interactions.filter((i) => i.type === "pocketQuestion" && i.requestId === requestId);
    if (!items.length || !items.every((i) => questionActionable(i, fresh && !!channel, caps.question === true) && answers[i.questionId || "question"]?.answers?.[0]?.trim())) return;
    void operation("question/respond", { threadId: detail.thread.id, requestId, answers }, "回答已提交", { requestId, answers });
  };
  const approve = (item: ApprovalItem, decision: string) => {
    const current = interactions.find((i) => i.type === "pocketApproval" && i.requestId === item.requestId);
    const allowed = current?.allowedDecisions ?? (current?.owner === "desktop" ? [] : ["allowOnce", "deny", "cancel"]);
    if (!current || !fresh || caps.approval !== true || !channel || current.available !== true || current.decision || current.submissionState || current.unavailableReason || !allowed.includes(decision)) return;
    void operation("approval/respond", { threadId: detail.thread.id, requestId: item.requestId, decision }, "审批结果已提交", { requestId: item.requestId, decision });
  };
  return <WorkspaceView hosts={hosts} host={host} threads={threads} detail={detail} connected={!!channel} loading={loading}
    busy={busy || fileReading || newTaskPending || pairingBusy || deviceBusy || wakeBusy} deviceBusy={deviceBusy} pending={pending} fresh={fresh} notice={notice} accountName={state.account.displayName || state.account.username || "我的账号"}
    artifacts={artifacts} artifactNotice={artifactNotice} onArtifact={artifactCall}
    modelOptions={modelOptions}
    draft={draft} interactions={interactions} passwordForm={passwordForm} onLock={onLock} onLogout={onLogout} onForget={onForget}
    onDismissNotice={() => setNotice("")} onHost={(value) => void choose(value)} onThread={(value) => void read(value)}
    onRefresh={() => { if (host) void choose(host, client, true); }} onDraft={draftPatch} onFiles={(value) => void files(value)} onSend={() => void send()}
    onSteer={() => { const turn = activeTurn(detail); if (turn && caps.send === true && caps.steer && !draft.attachments.length && draft.text.trim()) void operation("turn/steer", { threadId: detail.thread.id, expectedTurnId: turn.id, text: draft.text }, "已追加指令", { clearDraft: true }); }}
    onInterrupt={() => { const turn = activeTurn(detail); if (turn && caps.interrupt === true) void operation("turn/interrupt", { threadId: detail.thread.id, turnId: turn.id }, "已请求中断"); }}
    onGoal={() => { if (caps.goal === true && draft.goal.trim()) void operation("goal/set", { threadId: detail.thread.id, objective: draft.goal }, "任务目标已保存"); }}
    onReconcile={() => void reconcile()} onAnswer={answer} onApproval={approve}
    desktopWake={client && host && <DesktopWake key={host.id} client={client} channel={channel} host={host} disabled={busy || newTaskPending || pairingBusy || deviceBusy} onBusy={setWakeBusy} />}
    deviceApproval={client && <DeviceApproval client={client} pkg={pkg} account={state.account} disabled={!relayConnected || busy || newTaskPending || pairingBusy || wakeBusy} onBusy={setDeviceBusy} />}
    hostPairing={client && <HostPairing client={client} contentKey={pkg.contentKey} initialInput={initialPairing} onConsumed={onPairingConsumed} onBusy={setPairingBusy} disabled={busy || newTaskPending || deviceBusy || wakeBusy || !relayConnected}
      onBound={() => void refreshHosts(client).catch((error) => { if (alive.current) setNotice(error.message); })} />}
    newTask={client && host ? <NewTask key={host.id} client={client} channel={channel} hostId={host.id} receiptKey={receiptKey} onBusy={writeBusy} onPending={setNewTaskPending} disabled={busy || loading || pending || wakeBusy}
      onCreated={(thread) => { setSyncTick((n) => n + 1); if (thread?.id) { writeBusy(false); void read(thread); } }} /> : undefined} />;
}
