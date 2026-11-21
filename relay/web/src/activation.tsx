import React, { useRef, useState } from "react";
import { activationProof, createWebRegistration, openAccountPackage, type DeviceKeys } from "./crypto";
import { loadLocal, saveLocal } from "./storage";

type Attempt = { keys: DeviceKeys; payload: any; operationId: string; started?: any; complete?: any };
async function api(path: string, body?: any) {
  const response = await fetch(path, { method: body ? "POST" : "GET", credentials: "omit", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error?.message || "激活失败"), result.error || {});
  return result;
}
export function Activation({ username, password, keys, deviceName, trusted, onActivated, onBack }: {
  username: string; password: string; keys: DeviceKeys; deviceName: string; trusted: boolean;
  onActivated: (keys: DeviceKeys) => void; onBack: () => void;
}) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [restartAllowed, setRestartAllowed] = useState(false);
  const attempt = useRef<Attempt | undefined>(undefined); const recordKey = `activation:${username.trim().toLowerCase()}`;
  const persist = async () => { if (trusted && attempt.current) await saveLocal(password, { deviceKeys: attempt.current.keys, packageJson: attempt.current.payload.packageJson, activation: attempt.current, trusted: true, savedAt: Date.now() }, recordKey); };
  const submit = async () => {
    if (busy) return; setBusy(true); setError(""); setRestartAllowed(false);
    try {
      if (!attempt.current && trusted) { try { attempt.current = (await loadLocal(password, recordKey))?.activation; } catch { /* A different initial password cannot reuse an obsolete attempt. */ } }
      if (!attempt.current) {
        const config = await api("/api/public/config");
        if (!config.recoveryPublicKey) throw new Error("服务端尚未完成恢复公钥配置，请联系管理员");
        const registration = await createWebRegistration(password, config.recoveryPublicKey, keys);
        // Verify our password wrapper before sending only encrypted material.
        await openAccountPackage(password, registration.payload.packageJson, registration.pkg);
        attempt.current = { keys, operationId: crypto.randomUUID(), payload: { ...registration.payload, deviceName, deviceSigningPublicKey: keys.signingPublicKey, deviceEncryptionPublicKey: keys.encryptionPublicKey } };
        await persist();
      }
      const current = attempt.current;
      if (!current.started) { current.started = await api("/api/web/activate/start", { username, password, operationId: current.operationId, ...current.payload }); await persist(); }
      if (!current.complete) {
        const message = String(current.started.challenge.signingMessage);
        if (!message.startsWith("agent-pocket-web-activation-v1\n")) throw new Error("激活验证类型不匹配");
        const context = JSON.parse(message.slice("agent-pocket-web-activation-v1\n".length));
        if (context.origin !== location.origin || context.accountId !== current.started.accountId || context.operationId !== current.operationId
          || context.accountSigningPublicKey !== current.payload.accountSigningPublicKey || context.accountEncryptionPublicKey !== current.payload.accountEncryptionPublicKey
          || context.deviceSigningPublicKey !== current.keys.signingPublicKey || context.deviceEncryptionPublicKey !== current.keys.encryptionPublicKey) throw new Error("激活验证身份不匹配");
        const pkg = await openAccountPackage(password, current.payload.packageJson, { signingPublicKey: current.payload.accountSigningPublicKey, encryptionPublicKey: current.payload.accountEncryptionPublicKey });
        current.complete = { ...current.payload, ...await activationProof(pkg, current.keys, current.started.challenge), operationId: current.operationId, accountId: current.started.accountId, activationToken: current.started.activationToken };
        await persist();
      }
      const result = await api("/api/web/activate/complete", current.complete);
      if (result.state !== "activated" || result.account.signingPublicKey !== current.payload.accountSigningPublicKey || result.account.encryptionPublicKey !== current.payload.accountEncryptionPublicKey) throw new Error("激活结果与本地密钥不一致");
      onActivated(current.keys);
    } catch (caught: any) { setError(caught.message || "激活结果待确认，请使用同一请求再次确认"); setRestartAllowed(["AUTH_FAILED", "VERSION_CONFLICT"].includes(caught.code)); }
    finally { setBusy(false); }
  };
  return <section className="card narrow"><h2>首次开通账号</h2><p>欢迎，{username}。这一步会为你的账号生成加密密钥，接着绑定验证码，再连接自己的电脑。</p><p className="muted">账户密钥在浏览器本地生成并由账号密码加密。请使用管理员分配给你的独立账号。</p>
    {error && <p className="error" role="alert">{error}</p>}
    <button disabled={busy} onClick={() => void submit()}>{busy ? "正在安全开通…" : attempt.current?.complete ? "再次确认开通结果" : "开通并继续"}</button>
    {restartAllowed && <button className="ghost" disabled={busy} onClick={() => { if (attempt.current) { attempt.current.started = undefined; attempt.current.complete = undefined; attempt.current.operationId = crypto.randomUUID(); } void persist().then(submit).catch((caught) => setError(caught.message)); }}>重新获取激活验证</button>}
    <button className="ghost" disabled={busy} onClick={onBack}>返回登录</button>
  </section>;
}
