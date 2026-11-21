import React, { useEffect, useRef, useState } from "react";
import { Monitor, Plus, ShieldCheck } from "lucide-react";
import type { RelayClient } from "./relay-client";
import { sealHostContentKey, b64, bytes, ready } from "./crypto";
import sodium from "libsodium-wrappers-sumo";
import { parseHostPairing, type HostPairingCode } from "./pairing";
import { Modal } from "./ui";

export function HostPairing({ client, contentKey, initialInput, onConsumed, onBound, onBusy, disabled }: {
  client: RelayClient; contentKey: string; initialInput: string; onConsumed: () => void;
  onBound: () => void; onBusy: (value: boolean) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false); const [input, setInput] = useState(""); const [code, setCode] = useState<HostPairingCode>();
  const [host, setHost] = useState<any>(); const [name, setName] = useState(""); const [fingerprint, setFingerprint] = useState("");
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [pending, setPending] = useState(false);
  const alive = useRef(true); const epoch = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  useEffect(() => { if (initialInput) { setInput(initialInput); setOpen(true); onConsumed(); } }, [initialInput, onConsumed]);
  const inspect = async () => {
    const generation = ++epoch.current; setBusy(true); setMessage(""); setHost(undefined);
    try {
      const parsed = parseHostPairing(input, location.origin);
      const result = await client.request("host/enroll/inspect", parsed); await ready();
      if (!alive.current || generation !== epoch.current) return;
      if (result.approved_account_id && result.approved_account_id !== client.accountId) throw new Error("这台电脑已由其他账号确认，请在电脑上重新生成配对码");
      if (bytes(result.signing_public_key).length !== 32 || bytes(result.encryption_public_key).length !== 32) throw new Error("电脑公钥无效");
      setCode(parsed); setHost(result); setName(result.requested_name);
      setFingerprint(b64(sodium.crypto_generichash(16, new TextEncoder().encode(`${result.signing_public_key}:${result.encryption_public_key}`), null)));
      setPending(Boolean(result.approved_account_id));
      if (result.approved_account_id) setMessage("已确认绑定，等待电脑完成连接；可查询状态。");
    } catch (error: any) { if (alive.current && generation === epoch.current) setMessage(error.message); }
    finally { if (alive.current && generation === epoch.current) setBusy(false); }
  };
  const lookup = async () => {
    if (!code || !host || busy) return; setBusy(true);
    try {
      const list = await client.listHosts();
      if (list.some((item: any) => item.online && item.signingPublicKey === host.signing_public_key && item.encryptionPublicKey === host.encryption_public_key)) { if (alive.current) { setOpen(false); setInput(""); setHost(undefined); setCode(undefined); setPending(false); onBound(); } return; }
      const status = await client.request("host/enroll/inspect", code);
      if (status.approved_account_id && status.approved_account_id !== client.accountId) throw new Error("绑定已由其他账号确认，请重新生成配对码");
      if (alive.current) { setPending(Boolean(status.approved_account_id)); setMessage(status.approved_account_id ? "网页已确认，请保持电脑配对助手打开，稍后查询连接状态。" : "电脑尚未绑定，可以重新确认。"); }
    } catch (error: any) { if (alive.current) setMessage(error.message); }
    finally { if (alive.current) setBusy(false); }
  };
  const approve = async () => {
    if (!code || !host || !name.trim() || pending || busy) return;
    setBusy(true); onBusy(true); setPending(true);
    try {
      const keyPackage = await sealHostContentKey(contentKey, host.encryption_public_key);
      await client.request("host/enroll/approve", { ...code, name: name.trim(), keyPackage });
      if (alive.current) { setMessage("已确认绑定。等待电脑配对助手显示成功后，点击查询连接状态。"); onBound(); }
    } catch (error: any) { if (alive.current) {
      if (["CONFLICT", "INVALID_REQUEST", "FORBIDDEN"].includes(error.nameCode)) { setPending(false); setMessage(error.message); }
      else setMessage(`${error.message}。绑定结果待确认，请查询状态后再操作。`);
    } }
    finally { if (alive.current) setBusy(false); onBusy(false); }
  };
  const close = () => { if (!busy) { epoch.current++; setOpen(false); } };
  return <><button className="pair-host-button" disabled={disabled || busy} onClick={() => setOpen(true)}><Monitor size={15} /><span>绑定电脑</span><Plus size={14} /></button>
    {open && <Modal title="连接自己的电脑" onClose={close}><p className="modal-description">先在 Windows 安装 Agent Pocket Host，打开配对助手。用 iPhone 扫描网页二维码，或粘贴助手里的网页链接。</p>
      <label className="form-label">网页配对链接或配对码<textarea rows={3} value={input} disabled={busy || pending} onChange={(event) => { epoch.current++; setInput(event.target.value); setHost(undefined); setCode(undefined); setMessage(""); }} autoComplete="off" autoCorrect="off" spellCheck={false} /></label>
      {!host && <div className="modal-footer"><span>配对码有效期 5 分钟</span><button className="primary-button" disabled={disabled || busy || !input.trim()} onClick={() => void inspect()}>{busy ? "读取中…" : "查看电脑"}</button></div>}
      {host && <><dl className="task-info"><dt>电脑</dt><dd>{host.requested_name}</dd><dt>服务端</dt><dd>{location.origin}</dd><dt>电脑公钥指纹</dt><dd><code>{fingerprint}</code></dd></dl>
        <label className="form-label">显示名称<input value={name} maxLength={80} disabled={busy || pending} onChange={(event) => setName(event.target.value)} /></label>
        <p className="modal-description"><ShieldCheck size={13} /> 请确认这是自己电脑上的配对助手，再允许绑定。</p>
        <div className="modal-footer">{pending ? <button className="primary-button" disabled={disabled || busy} onClick={() => void lookup()}>查询连接状态</button> : <button className="primary-button" disabled={disabled || busy || !name.trim()} onClick={() => void approve()}>确认绑定这台电脑</button>}</div>
      </>}
      {message && <p className="modal-message" role="status">{message}</p>}
    </Modal>}
  </>;
}
