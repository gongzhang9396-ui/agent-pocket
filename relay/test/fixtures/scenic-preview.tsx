// Development-only harness: real production components, synthetic task data.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceView, emptyDraft } from "../../web/src/workspace-view";
import { NewTask } from "../../web/src/new-task";
import { prepareAttachments } from "../../web/src/attachments";
import { ready } from "../../web/src/crypto";
import { applySkin, parseSkin } from "../../web/src/skin";
import "../../web/src/styles.css";
import "../../web/src/scenery.css";
import picture from "../../web/src/assets/scene-paper-v1.png";

applySkin(parseSkin(new URLSearchParams(location.search).get("skin")), false);
const host = { id: "preview-host", name: "工作电脑", online: true };
const imageBytes = new Uint8Array(await (await fetch(picture)).arrayBuffer());
const threads = [{ id: "demo", name: "整理旅行照片", cwd: "C:/Demo/旅行手记", agentId: "codex", source: "desktop", status: "completed", execution: { backend: "desktop", capabilities: { send: true, attachments: true, plan: false } } },
  { id: "other", name: "周末的阅读清单", cwd: "C:/Demo/个人项目", source: "bridge", status: "idle", capabilities: { send: true, attachments: true, plan: true, goal: true } }];
function Preview() {
  const [thread, setThread] = useState<any>(threads[0]); const [draft, setDraft] = useState(emptyDraft); const [connected, setConnected] = useState(true); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const detail = { thread: { ...thread, turns: [{ id: "turn", status: "completed", items: [
    { id: "user", type: "userMessage", content: [{ type: "text", text: "把照片按拍摄日期整理好，重复的先单独放一份。" }] },
    { id: "reply", type: "agentMessage", text: "整理好了。\n\n照片已按月份归档，重复文件放进了待核对文件夹。\n\n[查看整理清单](report.txt)" },
  ] }] } };
  const report = new TextEncoder().encode("旅行照片整理清单\n已归档 126 张照片\n待核对 8 张重复照片\n");
  const artifacts = [{ id: "report", messageId: "turn:reply", source: "report.txt", name: "照片整理清单.txt", mimeType: "text/plain", size: report.length }, { id: "picture", messageId: "turn:reply", source: "scene.png", name: "旅行手记.png", mimeType: "image/png", size: imageBytes.length }];
  const mock: any = { call: async (_: any, method: string, params: any) => {
    if (method === "host/runtime") return { desktop: { attachReady: true }, bridge: { readOnly: false } };
    if (method === "project/list") return { data: [{ cwd: "C:/Demo/旅行手记", name: "旅行手记" }] };
    if (method === "thread/start") { setNotice(`演示已接收：${params.files.length} 个文件、${params.images.length} 张图片。未发送到电脑。`); return { thread: threads[0] }; }
    return {};
  } };
  return <WorkspaceView hosts={[host]} host={host} threads={threads} detail={thread ? detail : undefined} connected={connected} loading={false} busy={busy} pending={false} fresh={true} accountName="我的账号" notice={notice} draft={draft} interactions={[]}
    artifacts={artifacts} onArtifact={async (_method, params) => { const bytes = params.id === "picture" ? imageBytes : report; const end = Math.min(params.offset + 192 * 1024, bytes.length); let data = ""; for (const byte of bytes.subarray(params.offset, end)) data += String.fromCharCode(byte); return { id: params.id, offset: params.offset, nextOffset: end, size: bytes.length, done: end === bytes.length, data: btoa(data) }; }}
    onDraft={patch => setDraft(current => ({ ...current, ...patch }))} onFiles={files => { void prepareAttachments(files, draft.attachments).then(attachments => setDraft(current => ({ ...current, attachments }))).catch(error => setNotice(error.message)); }}
    onThread={setThread} onHost={() => {}} onRefresh={() => setNotice("演示数据已刷新")} onSend={() => setNotice("预览环境，不会发送真实任务")} onSteer={() => {}} onInterrupt={() => {}} onGoal={() => {}} onReconcile={() => {}} onApproval={() => {}} onAnswer={() => {}} onLock={() => setConnected(false)} onLogout={() => {}} onForget={() => {}} onDismissNotice={() => setNotice("")} passwordForm={<p>本地预览 · 无账号数据</p>}
    newTask={<NewTask client={mock} channel={{ hostId: host.id } as any} hostId={host.id} receiptKey="preview-receipts" onCreated={setThread} onBusy={setBusy} onPending={() => {}} />} />;
}
await ready(); createRoot(document.getElementById("root")!).render(<Preview />);
