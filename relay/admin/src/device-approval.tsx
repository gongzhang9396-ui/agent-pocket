import React, { useEffect, useRef, useState } from "react";
import { Login, api, type AppState } from "../../web/src/auth";
import type { AccountPackage, DeviceKeys } from "../../web/src/crypto";
import { DeviceApproval } from "../../web/src/device-approval-view";
import { RelayClient } from "../../web/src/relay-client";
import { assertApprovalAccount } from "./approval-context";

type Unlocked = { state: AppState; keys: DeviceKeys; pkg: AccountPackage };

// This session is deliberately separate from the trusted /app browser record.
// Only the existing password/TOTP/proof flow can grant it device authority.
export default function AdminDeviceApproval({ account, target, onClose, onApproved, onCleanup }: {
  account: { id: string; username: string }; target: { id: string; name: string };
  onClose: () => void; onApproved: () => void; onCleanup: () => void;
}) {
  const [unlocked, setUnlocked] = useState<Unlocked>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const session = useRef<AppState | undefined>(undefined);
  const cleanup = (state?: AppState) => {
    if (state?.tokens?.accessToken) {
      // No retries or refresh during cleanup, and never touch the admin cookie
      // or an existing trusted browser's device/session.
      return api("/api/web/device/forget", {}, state.tokens.accessToken).catch(() => undefined);
    }
    return Promise.resolve();
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; void cleanup(session.current).finally(onCleanup); session.current = undefined; };
  }, []);
  const rememberSession = (next: AppState) => {
    if (!alive.current) { cleanup(next); return; }
    if (session.current?.device?.id !== next.device?.id) cleanup(session.current);
    session.current = next;
  };
  const ready = (state: AppState, keys: DeviceKeys, pkg?: AccountPackage) => {
    if (!alive.current) { cleanup(state); return; }
    try {
      if (!pkg) throw new Error("没有可用的账户密钥");
      assertApprovalAccount(account.id, state.account, pkg);
      setUnlocked({ state, keys, pkg });
    } catch (caught) { cleanup(state); setError(caught instanceof Error ? caught.message : "无法解锁批准功能"); }
  };
  return <section className="modal approval-modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
    <div className="approval-heading"><div><h2 id="approval-title">批准新设备</h2><p>@{account.username} · {target.name}</p></div><button className="quiet" disabled={busy} onClick={onClose}>关闭</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {unlocked ? <ApprovalConnection unlocked={unlocked} targetId={target.id} onBusy={setBusy} onApproved={onApproved}
      onTokens={(tokens) => rememberSession({ ...unlocked.state, tokens })}
      onExpired={() => { cleanup(session.current); session.current = undefined; setUnlocked(undefined); setError("批准会话已失效，请重新验证账号。"); }} />
      : <Login temporaryAccount={account} onSession={rememberSession} onReady={ready} />}
  </section>;
}

function ApprovalConnection({ unlocked, targetId, onBusy, onApproved, onTokens, onExpired }: {
  unlocked: Unlocked; targetId: string; onBusy: (value: boolean) => void; onApproved: () => void;
  onTokens: (tokens: any) => void; onExpired: () => void;
}) {
  const [client, setClient] = useState<RelayClient>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const callbacks = useRef({ onTokens, onExpired }); callbacks.current = { onTokens, onExpired };
  useEffect(() => {
    let alive = true;
    const { state, keys } = unlocked;
    const current = new RelayClient(state.tokens.accessToken, state.tokens.refreshToken, state.account.id, state.device.id, keys,
      undefined, (tokens) => callbacks.current.onTokens(tokens));
    setClient(current);
    const off = current.on((event) => {
      if (!alive) return;
      if (event.type === "connected") { setConnected(true); setError(""); }
      if (event.type === "closed") setConnected(false);
      if (event.type === "expired" || event.type === "revoked") callbacks.current.onExpired();
      if (event.type === "error") setError("连接暂时中断，请重试。");
    });
    void current.connect().catch(() => { if (alive) setError("无法连接，请检查网络后重试。"); });
    return () => { alive = false; off(); void current.close(); };
  }, [unlocked]);
  return <div className="approval-content">
    {!connected && <p role="status">{error || "正在连接…"}</p>}
    {!connected && client && <button onClick={() => void client.reconnect().catch(() => setError("连接失败，请稍后重试。"))}>重新连接</button>}
    {client && <DeviceApproval client={client} pkg={unlocked.pkg} account={unlocked.state.account}
      targetId={targetId} initiallyExpanded disabled={!connected} onBusy={onBusy} onApproved={onApproved} />}
  </div>;
}
