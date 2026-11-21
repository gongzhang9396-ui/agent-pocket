import React from "react";

export type ApprovalItem = {
  id: string; requestId: string; summary?: string; owner?: string; available?: boolean;
  allowedDecisions?: string[]; decision?: string; unavailableReason?: string;
  command?: string; cwd?: string; changes?: unknown; grantRoot?: string;
  networkApprovalContext?: unknown; submissionState?: string;
};
const decisions = [{ id: "allowOnce", label: "允许本次" }, { id: "deny", label: "拒绝" }, { id: "cancel", label: "取消" }];

export function ApprovalCard({ item, capability, connected, busy, onDecision }: {
  item: ApprovalItem; capability: boolean; connected: boolean; busy: boolean;
  onDecision: (item: ApprovalItem, decision: string) => void;
}) {
  const uncertain = item.submissionState === "submitting" || item.submissionState === "unknown";
  const actionable = connected && capability && item.available === true && !item.decision && !uncertain && !item.unavailableReason;
  // Legacy Bridge requests have no choice list. Native Desktop must always
  // supply its explicit list, otherwise there is no safe approval action.
  const allowed = item.allowedDecisions ?? (item.owner === "desktop" ? [] : decisions.map((entry) => entry.id));
  return <section className="question-card approval-card" aria-label="审批请求">
    <strong>{item.owner === "desktop" ? "Desktop 请求审批" : "需要审批"}</strong>
    <p>{item.summary || "请确认本次操作"}</p>
    {item.cwd && <p>工作目录：<code>{item.cwd}</code></p>}
    {item.command && <pre>{item.command}</pre>}
    {item.changes != null && <details open><summary>文件改动</summary><pre>{JSON.stringify(item.changes, null, 2)}</pre></details>}
    {item.grantRoot && <p>申请访问目录：<code>{item.grantRoot}</code></p>}
    {item.networkApprovalContext != null && <details open><summary>网络访问范围</summary><pre>{JSON.stringify(item.networkApprovalContext, null, 2)}</pre></details>}
    {item.decision ? <p role="status">已提交：{decisions.find((entry) => entry.id === item.decision)?.label || item.decision}</p>
      : uncertain ? <p role="status">审批结果待确认，请在 Desktop 查看；不会重复提交。</p>
        : !actionable ? <p role="status">{!connected ? "连接已断开，恢复并同步后再处理审批" : item.unavailableReason || "请在 Desktop 完成审批"}</p>
          : decisions.filter((entry) => allowed.includes(entry.id)).map((entry) => <button key={entry.id}
            className={entry.id === "allowOnce" ? undefined : "ghost"} disabled={busy}
            onClick={() => onDecision(item, entry.id)}>{entry.label}</button>)}
  </section>;
}
