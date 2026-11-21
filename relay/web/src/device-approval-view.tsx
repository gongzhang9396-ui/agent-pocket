import React, { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { AccountPackage } from "./crypto";
import type { RelayClient } from "./relay-client";
import { approvePendingDevice, deviceVerificationCode, pendingDevices, type PendingDevice } from "./device-approval";

export function DeviceApproval({ client, pkg, account, disabled, onBusy, targetId, initiallyExpanded = false, onApproved }: {
  client: RelayClient; pkg: AccountPackage; account: { signingPublicKey: string; encryptionPublicKey: string };
  disabled: boolean; onBusy: (value: boolean) => void;
  targetId?: string; initiallyExpanded?: boolean; onApproved?: () => void;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded); const [list, setList] = useState<PendingDevice[]>([]);
  const [selected, setSelected] = useState<PendingDevice>(); const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false); const [message, setMessage] = useState(""); const busyRef = useRef(false);
  const refresh = async () => {
    if (busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); setMessage(""); setSelected(undefined);
    try { setList((await pendingDevices(client)).filter((item) => !targetId || item.id === targetId)); setLoaded(true); }
    catch { setList([]); setLoaded(false); setMessage("无法读取设备列表，请检查连接后重试。"); }
    finally { busyRef.current = false; setBusy(false); }
  };
  useEffect(() => { if (initiallyExpanded && !disabled) void refresh(); }, [client, disabled, initiallyExpanded, targetId]);
  const approve = async () => {
    if (!selected || busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); onBusy(true); setMessage("");
    try {
      await approvePendingDevice(client, selected, pkg, account);
      setList((items) => items.filter((item) => item.id !== selected.id)); setSelected(undefined);
      setMessage("已提交批准，请在新设备上检查是否完成连接。");
      onApproved?.();
    } catch {
      // A lost response can mean the write succeeded. Do not retry automatically.
      setSelected(undefined); setLoaded(false); setList([]);
      setMessage("批准结果尚未确认，请刷新设备列表，并在新设备上检查连接状态。");
    } finally { busyRef.current = false; setBusy(false); onBusy(false); }
  };
  return <div>
    <button type="button" disabled={disabled || busy} aria-expanded={expanded} onClick={() => { setExpanded(!expanded); if (!expanded) void refresh(); }}>
      <ShieldCheck size={18} /><span>批准新设备<small>查看等待批准的手机</small></span>
    </button>
    {expanded && <div className="modal-description">
      <p>仅批准你本人刚刚登录的设备。批准后，该设备可以访问此账号的加密内容。</p>
      {!loaded && !message && <p>{busy ? "正在读取设备…" : "请刷新设备列表"}</p>}
      {loaded && !list.length && <p>{targetId ? "这台设备已不在待批准列表中。请刷新管理端列表并检查手机连接。" : "没有等待批准的设备。"}</p>}
      {list.map((item) => <div key={item.id}>
        <strong>{item.name}</strong><p>核对码：<code>{deviceVerificationCode(item)}</code></p>
        <button type="button" disabled={busy || disabled} onClick={() => { setSelected(item); setMessage(""); }}>选择此设备</button>
      </div>)}
      {selected && <div role="group" aria-label="确认批准设备"><p>请确认新手机上显示的核对码与 <code>{deviceVerificationCode(selected)}</code> 完全一致。批准后它将获得账号密钥。</p>
        <button type="button" disabled={busy || disabled} onClick={() => setSelected(undefined)}>取消</button>
        <button type="button" disabled={busy || disabled} onClick={() => void approve()}>{busy ? "正在批准…" : "确认批准"}</button>
      </div>}
      {message && <p role="status">{message}</p>}
      <button type="button" disabled={busy || disabled} onClick={() => void refresh()}>刷新设备列表</button>
    </div>}
  </div>;
}
