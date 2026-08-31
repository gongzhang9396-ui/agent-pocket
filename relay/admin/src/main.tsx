import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Computer,
  Copy,
  KeyRound,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  UserPlus,
  Users,
} from "lucide-react";
import { api, post } from "./api";
import "./styles.css";

type Session = { account: { id: string; username: string; displayName: string; role: string } };
type User = { id: string; username: string; display_name: string; role: string; status: string; device_count: number; host_count: number };
type Host = { id: string; account_id: string; username: string; name: string; last_seen_at?: number; online: boolean; revoked_at?: number };
type Invite = { id: string; role: string; expires_at: number; used_at?: number };
type Audit = { id: number; account_id?: string; actor_kind: string; action: string; target_kind?: string; target_id?: string; created_at: number };
type Device = { id: string; name: string; status: string; created_at: number };

function ErrorText({ error }: { error: string }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Bootstrap() {
  const fragment = location.hash.slice(1).split(".");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (fragment.length !== 2) throw new Error("初始化链接无效，请重新生成");
      const password = String(values.get("password"));
      const recoveryPassphrase = String(values.get("recoveryPassphrase"));
      if (password.length < 12) throw new Error("账号密码至少 12 位");
      if (recoveryPassphrase.length < 16) throw new Error("恢复口令至少 16 位");
      const { createBootstrapCrypto, downloadRecoveryFile } = await import("./crypto");
      const crypto = await createBootstrapCrypto(recoveryPassphrase);
      const response = await post<{ account: { id: string }; device: { id: string } }>("/api/bootstrap/claim", {
        bootstrapId: fragment[0],
        secret: fragment[1],
        username: values.get("username"),
        displayName: values.get("displayName"),
        password,
        deviceName: values.get("deviceName"),
        ...crypto.request,
      });
      downloadRecoveryFile(crypto.privateMaterial, response.account.id, response.device.id);
      history.replaceState(null, "", "/admin");
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "初始化失败");
    } finally {
      setBusy(false);
    }
  }
  if (done) return <Login notice="初始化完成，恢复密钥文件已下载。请登录管理后台。" />;
  return <main className="auth-shell">
    <section className="auth-panel wide">
      <div className="brand"><ShieldCheck size={28} /><div><strong>Agent Pocket Relay</strong><span>管理员初始化</span></div></div>
      <form onSubmit={submit} className="form-grid">
        <Field label="用户名"><input name="username" minLength={3} maxLength={32} required autoComplete="username" /></Field>
        <Field label="显示名称"><input name="displayName" maxLength={80} required /></Field>
        <Field label="账号密码"><input name="password" type="password" minLength={12} maxLength={128} required autoComplete="new-password" /></Field>
        <Field label="离线恢复口令"><input name="recoveryPassphrase" type="password" minLength={16} maxLength={128} required autoComplete="new-password" /></Field>
        <Field label="当前设备名称"><input name="deviceName" defaultValue="管理员浏览器" maxLength={80} required /></Field>
        <div className="form-action"><ErrorText error={error} /><button disabled={busy} type="submit"><KeyRound size={17} />{busy ? "正在生成密钥" : "初始化并下载恢复密钥"}</button></div>
      </form>
    </section>
  </main>;
}

function Login({ notice }: { notice?: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await post("/api/admin/login", { username: values.get("username"), password: values.get("password") });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
      setBusy(false);
    }
  }
  return <main className="auth-shell"><section className="auth-panel">
    <div className="brand"><ShieldCheck size={28} /><div><strong>Agent Pocket Relay</strong><span>管理后台</span></div></div>
    {notice && <p className="notice">{notice}</p>}
    <form onSubmit={submit} className="stack">
      <Field label="用户名"><input name="username" autoComplete="username" required /></Field>
      <Field label="密码"><input name="password" type="password" autoComplete="current-password" required /></Field>
      <ErrorText error={error} />
      <button disabled={busy} type="submit"><KeyRound size={17} />{busy ? "登录中" : "登录"}</button>
    </form>
  </section></main>;
}

function Dashboard({ session }: { session: Session }) {
  const [tab, setTab] = useState("users");
  const [users, setUsers] = useState<User[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [devices, setDevices] = useState<Record<string, Device[]>>({});
  const [error, setError] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const tabs = useMemo(() => [
    ["users", "用户", Users], ["hosts", "电脑", Computer], ["invites", "邀请", UserPlus], ["audit", "审计", Activity],
  ] as const, []);
  async function load() {
    setError("");
    try {
      const [userData, hostData, inviteData, auditData] = await Promise.all([
        api<{ users: User[] }>("/api/admin/users"),
        api<{ hosts: Host[] }>("/api/admin/hosts"),
        api<{ invites: Invite[] }>("/api/admin/invites"),
        api<{ audit: Audit[] }>("/api/admin/audit"),
      ]);
      setUsers(userData.users); setHosts(hostData.hosts); setInvites(inviteData.invites); setAudit(auditData.audit);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "读取失败"); }
  }
  useEffect(() => { void load(); }, []);
  async function createInvite(role: "user" | "admin") {
    try {
      const created = await post<{ url: string }>("/api/admin/invites", { role });
      setInviteUrl(created.url);
      await navigator.clipboard?.writeText(created.url);
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "创建失败"); }
  }
  async function loadDevices(accountId: string) {
    try {
      const data = await api<{ devices: Device[] }>(`/api/admin/users/${accountId}/devices`);
      setDevices((current) => ({ ...current, [accountId]: data.devices }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "读取设备失败"); }
  }
  async function mutate(path: string) {
    try { await post(path, {}); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败"); }
  }
  async function logout() { await post("/api/admin/logout", {}); location.reload(); }
  return <div className="app-shell">
    <aside>
      <div className="brand"><ShieldCheck size={24} /><div><strong>Agent Pocket</strong><span>Relay v2</span></div></div>
      <nav>{tabs.map(([id, label, Icon]) => <button className={tab === id ? "active" : ""} key={id} onClick={() => setTab(id)}><Icon size={18} />{label}</button>)}</nav>
      <div className="account"><span>{session.account.displayName}</span><small>@{session.account.username}</small><button title="退出登录" onClick={() => void logout()}><LogOut size={17} /></button></div>
    </aside>
    <main className="workspace">
      <header><div><h1>{tabs.find(([id]) => id === tab)?.[1]}</h1><p>只展示账户与连接元数据</p></div><button className="icon-button" title="刷新" onClick={() => void load()}><RefreshCw size={18} /></button></header>
      <ErrorText error={error} />
      {tab === "users" && <section className="data-section"><div className="table-head"><span>用户</span><span>角色</span><span>设备 / 电脑</span><span>状态</span><span></span></div>{users.map((user) => <div className="row-group" key={user.id}><div className="table-row"><span><strong>{user.display_name}</strong><small>@{user.username}</small></span><span>{user.role === "admin" ? "管理员" : "用户"}</span><span>{user.device_count} / {user.host_count}</span><span className={`status ${user.status}`}>{user.status === "active" ? "正常" : "已停用"}</span><span className="actions"><button onClick={() => void loadDevices(user.id)}><Smartphone size={16} />设备</button><button className="quiet" onClick={() => void mutate(`/api/admin/users/${user.id}/${user.status === "active" ? "disable" : "enable"}`)}>{user.status === "active" ? "停用" : "启用"}</button></span></div>{devices[user.id] && <div className="device-list">{devices[user.id].map((device) => <div key={device.id}><span>{device.name}</span><small>{device.status}</small>{device.status !== "revoked" && <button onClick={() => void mutate(`/api/admin/users/${user.id}/devices/${device.id}/revoke`)}>撤销</button>}</div>)}</div>}</div>)}</section>}
      {tab === "hosts" && <section className="data-section"><div className="table-head host-cols"><span>电脑</span><span>用户</span><span>在线</span><span>最后连接</span><span></span></div>{hosts.map((host) => <div className="table-row host-cols" key={host.id}><span><strong>{host.name}</strong><small>{host.id}</small></span><span>@{host.username}</span><span className={`status ${host.online ? "active" : "offline"}`}>{host.online ? "在线" : "离线"}</span><span>{host.last_seen_at ? new Date(host.last_seen_at).toLocaleString() : "从未"}</span><span className="actions"><button className="danger" onClick={() => void mutate(`/api/admin/users/${host.account_id}/hosts/${host.id}/revoke`)}>撤销</button></span></div>)}</section>}
      {tab === "invites" && <section><div className="toolbar"><button onClick={() => void createInvite("user")}><UserPlus size={17} />普通用户邀请</button><button className="quiet" onClick={() => void createInvite("admin")}><ShieldCheck size={17} />管理员邀请</button></div>{inviteUrl && <div className="invite-output"><code>{inviteUrl}</code><button title="复制" onClick={() => void navigator.clipboard.writeText(inviteUrl)}><Copy size={17} /></button></div>}<div className="data-section"><div className="table-head invite-cols"><span>邀请</span><span>角色</span><span>有效期</span><span>状态</span></div>{invites.map((invite) => <div className="table-row invite-cols" key={invite.id}><span><code>{invite.id}</code></span><span>{invite.role}</span><span>{new Date(invite.expires_at).toLocaleString()}</span><span className={`status ${invite.used_at ? "offline" : "active"}`}>{invite.used_at ? "已使用" : invite.expires_at < Date.now() ? "已过期" : "待使用"}</span></div>)}</div></section>}
      {tab === "audit" && <section className="data-section"><div className="table-head audit-cols"><span>时间</span><span>动作</span><span>执行者</span><span>目标</span></div>{audit.map((item) => <div className="table-row audit-cols" key={item.id}><span>{new Date(item.created_at).toLocaleString()}</span><span><code>{item.action}</code></span><span>{item.actor_kind}</span><span>{item.target_kind || "-"} {item.target_id || ""}</span></div>)}</section>}
    </main>
  </div>;
}

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => { api<Session>("/api/admin/session").then(setSession).catch(() => setSession(null)); }, []);
  if (location.pathname === "/bootstrap") return <Bootstrap />;
  if (location.pathname === "/invite") return <main className="auth-shell"><section className="auth-panel"><div className="brand"><UserPlus size={28} /><div><strong>Agent Pocket</strong><span>用户邀请</span></div></div><p className="notice">请在 Agent Pocket Android 中打开此邀请链接。</p></section></main>;
  if (session === undefined) return <main className="auth-shell"><RefreshCw className="spin" /></main>;
  return session ? <Dashboard session={session} /> : <Login />;
}

createRoot(document.getElementById("root")!).render(<App />);
