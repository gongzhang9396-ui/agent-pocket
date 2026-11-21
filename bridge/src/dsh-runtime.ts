import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyRuntime, DSH_VERSION } from '../../dsh-bridge-plugin/runtime-integrity.mjs';
import { desktopUrl as validateDesktopUrl, publishDesktopLink, removeDesktopLink } from '../../dsh-bridge-plugin/desktop-link.mjs';
import { readProfileSettings } from '../../dsh-bridge-plugin/profile-settings.mjs';
import { privateRuntime } from '../../dsh-bridge-plugin/private-runtime.mjs';
import { RpcError } from './protocol.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const mutation = new Set(['create', 'send', 'interrupt', 'respond']);
const pluginRoot = fileURLToPath(new URL('../../dsh-bridge-plugin/', import.meta.url));
const PROFILE = { name: 'agent-pocket-dsh-profile', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } };
const PATCH = [
  ...['hmr', 'schedule', 'session-title-llm', 'session-telemetry-otel', 'desktop-product-telemetry'].map(id => ({ id, disabled: true })),
  { id: 'approval', config: { policy: 'ask' } },
  { insert: [{ id: 'agent-pocket-bridge', name: pathToFileURL(join(pluginRoot, 'index.mjs')).href }] },
];

export async function prepareDshProfile(home: string, runtime: string) {
  // A home patch applies to every profile and may install auto-approval hooks.
  // Preserve it, and refuse automatic startup rather than overriding it.
  if (existsSync(join(home, 'cordis.patch.yml'))) throw new RpcError('VERSION_UNSUPPORTED', 'DSH 有全局插件补丁，暂不能自动启动 Pocket 专用配置；原配置已保留');
  const parent = join(home, 'profiles'), profile = join(parent, 'agent-pocket');
  await mkdir(parent, { recursive: true });
  if (!existsSync(profile)) {
    const temp = join(parent, `.agent-pocket-${process.pid}-${Date.now()}`);
    await mkdir(temp, { mode: 0o700 });
    await writeFile(join(temp, 'package.json'), JSON.stringify(PROFILE));
    await writeFile(join(temp, 'cordis.patch.yml'), '[]\n');
    await writeFile(join(temp, '.agent-pocket-profile-v1'), 'agent-pocket-profile-v1\n');
    await symlink(join(runtime, 'node_modules'), join(temp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await rename(temp, profile);
  }
  const stat = await lstat(profile);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (await readFile(join(profile, '.agent-pocket-profile-v1'), 'utf8')) !== 'agent-pocket-profile-v1\n'
    || JSON.stringify(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))) !== JSON.stringify(PROFILE)
    || (await realpath(join(profile, 'node_modules'))).toLowerCase() !== (await realpath(join(runtime, 'node_modules'))).toLowerCase()) {
    throw new RpcError('VERSION_UNSUPPORTED', 'Pocket 的 DSH 专用配置已更改，请先检查电脑配置；不会自动覆盖');
  }
  let settings;
  try {
    const native = await readProfileSettings(join(parent, 'web', 'cordis.patch.yml'), runtime);
    const local = await readProfileSettings(join(profile, 'cordis.patch.yml'), runtime, true);
    settings = [...new Map([...native, ...local].map(row => [row.id, row])).values()];
  } catch (error) { throw new RpcError('VERSION_UNSUPPORTED', error.message); }
  // Provider settings may contain custom headers. New launch files inherit only
  // the current user's and SYSTEM's access, including on an existing profile.
  await privateRuntime(profile, true);
  const patch = join(profile, 'pocket-launch.patch.json');
  const temporary = `${patch}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify([...settings, ...PATCH]), { flag: 'wx', mode: 0o600 });
    await rename(temporary, patch);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return patch;
}

/** Inherited Node IPC replaces a network/Named Pipe control endpoint. Its only
 * peer is the verified child we spawned; no bearer token or registration exists. */
export class DshRuntime extends EventEmitter {
  roots: string[];
  root?: string;
  home: string;
  explicitHome: boolean;
  child?: ChildProcess;
  ready = false;
  ipcReady = false;
  verifiedCapabilities = new Set<string>();
  stopped = false;
  startup?: Promise<void>;
  error = 'DeepSeek 正在准备，请稍后刷新';
  generation = 0;
  nextId = 0;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; method: string }>();
  desktopDirectory = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'AgentPocket', 'dsh-desktop');
  constructor(roots: string[], options: { runtimeRoot?: string; home?: string } = {}) {
    super(); this.roots = roots; this.root = options.runtimeRoot;
    this.explicitHome = Boolean(options.home || process.env.DSH_HOME);
    this.home = resolve(options.home || process.env.DSH_HOME || join(homedir(), '.dsh'));
  }
  ensure() {
    if (this.stopped) return Promise.reject(new RpcError('AGENT_OFFLINE', 'DeepSeek 连接已关闭'));
    if (this.ready) return Promise.resolve();
    return this.startup ??= this.start().catch(error => {
      this.error = error instanceof RpcError ? error.message : 'DeepSeek 运行时不可用，请在电脑准备经过验证的官方版本';
      throw error;
    }).finally(() => { this.startup = undefined; });
  }
  async start() {
    const stateRoot = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'AgentPocket');
    let root = this.root;
    try {
      const saved = JSON.parse(await readFile(join(stateRoot, 'dsh-runtime.json'), 'utf8'));
      root ||= saved.root;
      if (!this.explicitHome && typeof saved.home === 'string') this.home = resolve(saved.home);
    } catch {}
    if (!root) throw new RpcError('AGENT_UNAVAILABLE', '请先在电脑安装 Pocket 的 DeepSeek 运行时');
    const verified = await verifyRuntime(root);
    const patch = await prepareDshProfile(this.home, root);
    if (this.stopped) throw new RpcError('AGENT_OFFLINE', 'DeepSeek 连接已关闭');
    const generation = ++this.generation;
    const runtimeStartedAt = Date.now();
    let desktopUrl: string | undefined;
    let desktopLink: { file: string; nonce: string } | undefined;
    const child = spawn(process.execPath, [join(verified.cli, 'lib', 'bin.js'), '--profile', 'agent-pocket', '--patch', patch,
      '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: this.roots[0], shell: false, windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '',
        DSH_HOME: this.home, DSH_PERMISSION_MODE: 'workspace-write',
        AGENT_POCKET_DSH_PARENT: String(process.pid), AGENT_POCKET_DSH_RUNTIME: root,
        AGENT_POCKET_DSH_VERSION: DSH_VERSION, AGENT_POCKET_DSH_ROOTS: JSON.stringify(this.roots) } });
    this.child = child;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new RpcError('AGENT_TIMEOUT', 'DeepSeek 启动超时，请检查电脑配置')); void this.stopChild(child); }, 45000);
      const onReady = (message: any) => {
        if (message?.type !== 'ready') return;
        if (message.protocolVersion !== 1 || message.runtimeVersion !== DSH_VERSION) { reject(new RpcError('VERSION_UNSUPPORTED', 'DeepSeek 适配协议版本不兼容')); void this.stopChild(child); return; }
        try { desktopUrl = validateDesktopUrl(message.desktopUrl); }
        catch { clearTimeout(timer); child.off('message', onReady); reject(new RpcError('VERSION_UNSUPPORTED', 'DeepSeek 共用桌面入口未通过验证')); void this.stopChild(child); return; }
        clearTimeout(timer); child.off('message', onReady); this.ipcReady = true; resolve();
      };
      child.on('message', onReady);
      child.once('error', () => { clearTimeout(timer); reject(new RpcError('AGENT_UNAVAILABLE', '无法启动 DeepSeek 运行时')); });
      child.once('exit', () => { clearTimeout(timer); child.off('message', onReady); reject(new RpcError('AGENT_OFFLINE', 'DeepSeek 启动进程已退出')); });
    });
    child.on('message', (message: any) => {
      if (generation !== this.generation || this.child !== child) return;
      if (!message || Buffer.byteLength(JSON.stringify(message)) > MAX_BYTES) { void this.stopChild(child); return; }
      if (message.type === 'event' && this.ready) this.emit('event', message.event);
      if (message.type !== 'response') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new RpcError(mutation.has(pending.method) && message.error.code === 'AGENT_ERROR' ? 'OPERATION_UNKNOWN' : message.error.code || 'AGENT_ERROR', message.error.message || 'DeepSeek 请求失败'));
      else pending.resolve(message.result);
    });
    child.once('exit', () => {
      void removeDesktopLink(desktopLink).catch(() => undefined);
      if (this.child !== child) return;
      this.ready = false; this.ipcReady = false; this.verifiedCapabilities.clear(); this.child = undefined;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RpcError(mutation.has(pending.method) ? 'OPERATION_UNKNOWN' : 'AGENT_OFFLINE', 'DeepSeek 连接已中断；请先确认原操作状态')); }
      this.pending.clear(); this.emit('offline');
    });
    try {
      await ready;
      const probe = await this.sendRequest('probe', {});
      if (probe.protocolVersion !== 1 || probe.runtimeVersion !== DSH_VERSION || !Array.isArray(probe.capabilities)
        || !['approval-waterfall-safe', 'questions-v1', 'desktop-web-entry-v1'].every(capability => probe.capabilities.includes(capability))) {
        throw new RpcError('VERSION_UNSUPPORTED', 'DeepSeek 运行时未通过审批能力验证');
      }
      if (this.stopped || this.child !== child || !child.connected) throw new RpcError('AGENT_OFFLINE', 'DeepSeek 连接已关闭');
      if (desktopUrl && process.platform === 'win32') {
        desktopLink = await publishDesktopLink(this.desktopDirectory, { url: desktopUrl, hostPid: process.pid,
          runtimePid: child.pid, hostStartedAt: Date.now() - process.uptime() * 1000, runtimeStartedAt,
          nodeExecutable: process.execPath, runtimeRoot: resolve(root), home: this.home });
        if (this.stopped || this.child !== child || !child.connected) {
          await removeDesktopLink(desktopLink); throw new RpcError('AGENT_OFFLINE', 'DeepSeek 连接已关闭');
        }
      }
      this.verifiedCapabilities = new Set(probe.capabilities); this.ready = true; this.error = ''; this.emit('ready');
    } catch (error) {
      if (this.child === child) { this.ready = false; this.ipcReady = false; this.verifiedCapabilities.clear(); }
      await this.stopChild(child);
      throw error;
    }
  }
  request(method: string, params: any, timeoutMs = 15000): Promise<any> {
    if (!this.ready) return Promise.reject(new RpcError('AGENT_OFFLINE', this.error || 'DeepSeek 尚未连接'));
    return this.sendRequest(method, params, timeoutMs);
  }
  private sendRequest(method: string, params: any, timeoutMs = 15000): Promise<any> {
    if (!this.ipcReady || !this.child?.connected) return Promise.reject(new RpcError('AGENT_OFFLINE', this.error || 'DeepSeek 尚未连接'));
    if (this.pending.size >= 32 || Buffer.byteLength(JSON.stringify(params)) > MAX_BYTES - 1024) return Promise.reject(new RpcError('INVALID_REQUEST', 'DeepSeek 请求过大或过于频繁'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError(mutation.has(method) ? 'OPERATION_UNKNOWN' : 'AGENT_TIMEOUT', 'DeepSeek 响应超时，请查询原操作后再继续')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child!.send({ type: 'request', id, method, params }, error => {
        if (!error) return;
        const pending = this.pending.get(id); if (!pending) return;
        clearTimeout(timer); this.pending.delete(id);
        reject(new RpcError(mutation.has(method) ? 'OPERATION_UNKNOWN' : 'AGENT_OFFLINE', 'DeepSeek 连接中断，请先查询原操作'));
      });
    });
  }
  async stopChild(child = this.child) {
    if (!child || child.exitCode != null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill(); }, 15000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.disconnect(); else child.kill();
    });
  }
  async stop() { this.stopped = true; try { await this.startup; } catch {} await this.stopChild(); }
}
