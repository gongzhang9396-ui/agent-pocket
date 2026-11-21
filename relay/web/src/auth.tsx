import React, { useEffect, useState } from "react";
import { deviceProof, generateDeviceKeys, openAccountPackage, openDeviceAccountPackage, ready, sealAccountPackage, type AccountPackage, type DeviceKeys } from "./crypto";
import { forgetActivation, hasLocal, loadLocal, saveLocal } from "./storage";
import { Activation } from "./activation";
import { TotpQr } from "./totp-qr";

type Phase = "login" | "activate" | "totp" | "enroll" | "proof" | "migration" | "ready" | "locked";
export type AppState = { phase: Phase; loginToken?: string; challenge?: any; account?: any; device?: any; keyPackage?: string; keyPackageVersion?: number; tokens?: any; error?: string; message?: string; recoveryCodes?: string[]; secret?: string; otpauthUri?: string; trusted?: boolean; password?: string };
export const initial: AppState = { phase: "login" };

async function request(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers, credentials: "omit" });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) { const error: any = new Error(value.error?.message || "请求失败"); Object.assign(error, value.error || {}); throw error; }
  return value;
}
export const api = (path: string, body: any, token?: string) => request(path, { method: "POST", body: JSON.stringify(body) }, token);
export const get = (path: string, token?: string) => request(path, { method: "GET" }, token);

export function Login({ onReady, initialError, temporaryAccount, onSession }: {
  onReady: (state: AppState, keys: DeviceKeys, pkg?: AccountPackage, password?: string) => void; initialError?: string;
  temporaryAccount?: { id: string; username: string }; onSession?: (state: AppState) => void;
}) {
  const [username, setUsername] = useState(temporaryAccount?.username || ""); const [password, setPassword] = useState(""); const [trust, setTrust] = useState(!temporaryAccount); const [code, setCode] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [state, setState] = useState<AppState>({ phase: "login", error: initialError }); const [deviceName, setDeviceName] = useState(temporaryAccount ? "管理端批准设备（临时）" : `Browser on ${navigator.platform || "device"}`); const [keys, setKeys] = useState<DeviceKeys>(); const [busy, setBusy] = useState(false); const [localHint, setLocalHint] = useState(false);
  useEffect(() => { if (!temporaryAccount) void hasLocal().then(setLocalHint).catch(() => setLocalHint(false)); }, [temporaryAccount]);
  const submit = async (providedKeys?: DeviceKeys) => { setBusy(true); try { await ready(); let local: any; if (trust) { try { local = await loadLocal(password); if (local?.account?.username?.toLowerCase() !== username.trim().toLowerCase()) local = undefined; } catch { /* online login reports a wrong password */ } } const currentKeys = providedKeys || local?.deviceKeys || keys || generateDeviceKeys(); setKeys(currentKeys);
    // A trusted browser only needs the password to unlock its local record.
    // Reuse the encrypted refresh token when it is still valid; a revoked or
    // expired session falls through to the normal password/TOTP/device-proof
    // flow below.
    if (trust && local?.refreshToken && local?.packageJson && local?.account) {
      try {
        const refreshed = await api("/api/web/refresh", { refreshToken: local.refreshToken });
        const session = await get("/api/web/session", refreshed.accessToken);
        const packageValue = await openAccountPackage(password, local.packageJson, session.account);
        await saveLocal(password, { ...local, account: session.account, refreshToken: refreshed.refreshToken, savedAt: Date.now() });
        onReady({ phase: "ready", tokens: refreshed, account: session.account, device: session.device, keyPackageVersion: local.keyPackageVersion, trusted: true }, currentKeys, packageValue, password);
        return;
      } catch { /* Session rotation failed; continue with an online login. */ }
    }
    const result = await api("/api/web/login", { username, password, deviceId: local?.deviceId, deviceName, deviceSigningPublicKey: currentKeys.signingPublicKey, deviceEncryptionPublicKey: currentKeys.encryptionPublicKey, trustBrowser: trust, totpCode: code || undefined }); setState({ ...result, phase: "proof", password, trusted: trust }); setCode(""); } catch (error: any) { if (error.code === "ACCOUNT_ACTIVATION_REQUIRED") setState({ phase: "activate", password, trusted: trust }); else if (error.code === "TOTP_REQUIRED") setState({ phase: "totp", loginToken: error.data?.loginToken, password, trusted: trust }); else if (error.code === "TOTP_ENROLLMENT_REQUIRED") setState({ phase: "enroll", loginToken: error.data?.loginToken, secret: error.data?.secret, otpauthUri: error.data?.otpauthUri, password, trusted: trust }); else setState({ phase: "login", error: error.message }); } finally { setBusy(false); } };
  const finishTotp = async () => { setBusy(true); try { const result = await api("/api/web/totp/verify", { loginToken: state.loginToken, code }); const challenge = await api("/api/web/device/challenge", { loginToken: state.loginToken }); setState({ ...state, ...result, challenge, phase: "proof" }); setCode(""); } catch (error: any) { setState({ ...state, error: error.message }); } finally { setBusy(false); } };
  const finishRecovery = async () => { setBusy(true); try { const result = await api("/api/web/totp/recovery", { loginToken: state.loginToken, code }); const challenge = await api("/api/web/device/challenge", { loginToken: state.loginToken }); setState({ ...state, ...result, challenge, phase: "proof" }); setCode(""); } catch (error: any) { setState({ ...state, error: error.message }); } finally { setBusy(false); } };
  const finishEnroll = async () => { setBusy(true); try { const result = await api("/api/web/totp/enroll/finish", { loginToken: state.loginToken, code }); setState({ ...state, ...result, phase: "proof" }); try { const challenge = await api("/api/web/device/challenge", { loginToken: state.loginToken }); setState((current) => ({ ...current, challenge, phase: "proof" })); } catch (error: any) { setState((current) => ({ ...current, error: error.message })); } setCode(""); } catch (error: any) { setState({ ...state, error: error.message }); } finally { setBusy(false); } };
  const finishProof = async () => {
    setBusy(true);
    try {
      const proof = await deviceProof(keys!, state.challenge);
      const result = await api("/api/web/device/complete", { loginToken: state.loginToken, ...proof });
      // Let a temporary consumer revoke its session even if decryption fails
      // or the dialog was closed while the proof request was in flight.
      if (result.tokens) onSession?.(result);
      if (temporaryAccount && result.account?.id !== temporaryAccount.id) throw new Error("登录账号与待批准设备不一致");
      if (result.state === "key_migration_required") setState({ ...state, ...result, phase: "migration", trusted: state.trusted, password: state.password });
      else {
        const pkg = await openAccountPackage(state.password!, result.keyPackage, result.account);
        if (state.trusted !== false) await saveLocal(state.password!, { account: result.account, deviceId: result.device.id, deviceKeys: keys!, packageJson: result.keyPackage, keyPackageVersion: result.keyPackageVersion, refreshToken: result.tokens.refreshToken, trusted: true, savedAt: Date.now() });
        onReady({ ...result, phase: "ready", trusted: state.trusted }, keys!, pkg, state.password);
        if (state.trusted !== false) void forgetActivation(username).catch(() => undefined);
      }
    } catch (error: any) { setState({ ...state, error: error.message }); }
    finally { setBusy(false); }
  };
  if (state.phase === "login") return <section className="card narrow">
    {!temporaryAccount && <h1>Agent Pocket</h1>}
    <p className="muted">{temporaryAccount ? "输入当前账号密码解锁批准功能。若已开启两步验证，还需输入验证码。关闭窗口后结束本次临时会话。" : "网页端使用与 Relay 同源的账号登录。自部署 Relay、HTTPS 终止端和网页代码仍属于可信边界。"}</p>
    <label>账号<input value={username} readOnly={!!temporaryAccount} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
    <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
    {!temporaryAccount && <><label>设备名称<input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} /></label><label className="check"><input type="checkbox" checked={trust} onChange={(event) => setTrust(event.target.checked)} />信任此浏览器（加密保存设备记录）</label></>}
    {localHint && <p className="muted">发现本地加密设备记录，输入密码后会尝试解锁。</p>}{state.error && <p className="error" role="alert">{state.error}</p>}
    <button disabled={busy || !username || !password} onClick={() => void submit()}>{busy ? "验证中…" : temporaryAccount ? "验证账号" : "登录"}</button>
  </section>;
  if (state.phase === "activate") return <Activation username={username} password={password} keys={keys!} deviceName={deviceName} trusted={trust} onActivated={(deviceKeys) => { setKeys(deviceKeys); void submit(deviceKeys); }} onBack={() => setState({ phase: "login" })} />;
  if (state.phase === "totp") return <section className="card narrow"><h2>{recoveryMode ? "输入一次性恢复码" : "输入验证器验证码"}</h2><p>{recoveryMode ? "输入绑定时保存的 12 位恢复码，使用后立即作废。" : "打开验证器，输入当前 6 位验证码。"}</p><input className="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={recoveryMode ? 12 : 6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />{state.error && <p className="error">{state.error}</p>}<button disabled={busy || code.length !== (recoveryMode ? 12 : 6)} onClick={() => void (recoveryMode ? finishRecovery() : finishTotp())}>继续</button><button className="ghost" disabled={busy} onClick={() => { setRecoveryMode(!recoveryMode); setCode(""); }}>{recoveryMode ? "使用验证器验证码" : "使用一次性恢复码"}</button></section>;
  if (state.phase === "enroll") return <section className="card narrow"><h2>绑定验证器</h2><p>用支持 TOTP 的验证器添加账号，再输入它显示的 6 位验证码。使用同一台 iPhone 时可点击下面的链接，或复制密钥手动添加。</p><TotpQr uri={state.otpauthUri} /><code className="secret">{state.secret}</code><p className="muted">参数：6 位数字、30 秒、SHA-1。绑定后请保存一次性恢复码。</p>{state.recoveryCodes && <pre className="secret">{state.recoveryCodes.join("\n")}</pre>}<input className="otp" aria-label="验证器验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />{state.error && <p className="error">{state.error}</p>}<button disabled={busy || code.length !== 6} onClick={() => void finishEnroll()}>完成绑定</button></section>;
  if (state.phase === "proof") return <section className="card narrow"><h2>{temporaryAccount ? "账号验证通过" : "确认浏览器设备"}</h2><p>{temporaryAccount ? "继续后读取待批准设备，核对手机上的设备核对码。" : "Relay 将验证此浏览器同时持有签名私钥和加密私钥。"}</p>{state.recoveryCodes && <><p className="muted">请立即保存这些一次性恢复码。离开此页后不会再次显示。</p><pre className="secret">{state.recoveryCodes.join("\n")}</pre></>}{state.error && <p className="error">{state.error}</p>}<button disabled={busy} onClick={() => void finishProof()}>{temporaryAccount ? "继续核对手机" : "完成设备验证"}</button></section>;
  if (state.phase === "migration") return temporaryAccount
    ? <section className="card narrow"><p role="alert">当前账号还没有可用的网页密钥。请先在已信任设备上批准新手机，或在网页版完成首次开通，再使用管理端批准。</p><a href="/app/" target="_blank" rel="noopener noreferrer">打开网页版</a></section>
    : <Migration state={state} keys={keys!} password={state.password!} onReady={(next, pkg, pass) => onReady({ ...next, phase: "ready" }, keys!, pkg, pass)} />;
  return null;
}

export function Migration({ state, keys, password, onReady }: { state: AppState; keys: DeviceKeys; password: string; onReady: (state: AppState, pkg: AccountPackage, password?: string) => void }) {
  const [packageJson, setPackageJson] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [operationId] = useState(() => crypto.randomUUID());
  const submit = async () => { setBusy(true); setError(""); try {
    let wrapped = packageJson;
    if (!wrapped) {
      const supplied = await api("/api/web/key-migration/package", { loginToken: state.loginToken });
      if (supplied.state !== "approved") throw new Error("还没有收到手机批准，请刷新 Android 的账号设备列表并批准本浏览器。");
      const suppliedPackage = await openDeviceAccountPackage(keys, supplied.sealedKeyPackage, state.account);
      wrapped = await sealAccountPackage(password, suppliedPackage); setPackageJson(wrapped);
    }
    const pkg = await openAccountPackage(password, wrapped, state.account);
    const result = await api("/api/web/key-migration/complete", { loginToken: state.loginToken, packageJson: wrapped, expectedVersion: state.keyPackageVersion || 0, operationId });
    if (!result.tokens?.refreshToken) throw new Error("迁移已完成，请返回登录页重新登录以建立网页会话");
    if (state.trusted !== false) await saveLocal(password, { account: result.account, deviceId: result.device.id, deviceKeys: keys, packageJson: wrapped, keyPackageVersion: result.keyPackageVersion, refreshToken: result.tokens.refreshToken, trusted: true, savedAt: Date.now() });
    onReady({ ...result, phase: "ready", trusted: state.trusted }, pkg, password);
  } catch (caught: any) { setError(caught.message); } finally { setBusy(false); } };
  return <section className="card narrow"><h2>首次启用网页</h2><p>在已登录的 Android App 中打开“设置 → 账号设备”，刷新后批准这个浏览器，再回到此页继续。只需要迁移一次，后续浏览器可直接登录。</p><p>本次浏览器：<strong>{state.device?.name}</strong><br /><small>{state.device?.id}</small></p><p className="muted">手机把密钥加密给本浏览器，浏览器再用你的登录密码加密保存。请在五分钟内完成；超时后重新登录。</p>{error && <p className="error">{error}</p>}<button disabled={busy} onClick={() => void submit()}>{busy ? "正在迁移…" : "已在手机批准，继续"}</button><details><summary>高级：导入管理员准备的网页密钥包</summary><textarea rows={5} placeholder="粘贴加密网页密钥包 JSON" value={packageJson} onChange={(event) => setPackageJson(event.target.value)} /></details></section>;
}

