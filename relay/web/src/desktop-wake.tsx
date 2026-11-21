import React, { useCallback, useEffect, useRef, useState } from "react";
import { Monitor, RefreshCw } from "lucide-react";
import type { DeviceChannel } from "./crypto";
import type { RelayClient } from "./relay-client";
import { desktopStatus, type DesktopRuntime } from "./desktop-status";
import "./desktop-wake.css";

export function DesktopWake({ client, channel, host, disabled, onBusy }: {
  client: RelayClient; channel?: DeviceChannel; host: { id: string; name: string; online?: boolean };
  disabled?: boolean; onBusy: (busy: boolean) => void;
}) {
  const [runtime, setRuntime] = useState<DesktopRuntime>();
  const [message, setMessage] = useState(""); const [waitingUntil, setWaitingUntil] = useState(0);
  const [busy, setBusy] = useState(false); const active = useRef(false); const generation = useRef(0);
  const reading = useRef(-1); const launching = useRef(false);
  const read = useCallback(async () => {
    const epoch = generation.current;
    if (!host.online || !channel || channel.hostId !== host.id || reading.current === epoch || launching.current) return;
    reading.current = epoch;
    try {
      const result = await client.call(channel, "host/runtime", {});
      if (active.current && epoch === generation.current) {
        setRuntime(result);
        if (desktopStatus(result) === "ready") { setWaitingUntil(0); setMessage(""); }
      }
    } catch {
      if (active.current && epoch === generation.current) { setRuntime(undefined); setMessage("无法读取 Codex 状态，请刷新重试。"); }
    } finally { if (reading.current === epoch) reading.current = -1; }
  }, [client, channel, host.id, host.online]);
  useEffect(() => {
    active.current = true; generation.current++; setRuntime(undefined);
    if (channel) void read();
    return () => { active.current = false; generation.current++; };
  }, [read, channel]);
  useEffect(() => {
    if (!waitingUntil || !channel) return;
    const check = () => {
      if (Date.now() >= waitingUntil) {
        setWaitingUntil(0);
        setMessage("尚未确认连接成功，请刷新状态；若应用已打开，请在电脑上检查 Desktop 插件。");
      }
      if (document.visibilityState === "visible") void read();
    };
    const timer = window.setInterval(check, 3000);
    document.addEventListener("visibilitychange", check);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [waitingUntil, channel, read]);
  const launch = async () => {
    if (!host.online || !channel || channel.hostId !== host.id || disabled || launching.current || reading.current === generation.current || waitingUntil
      || desktopStatus(runtime) !== "closed" || runtime?.desktop?.canWake !== true || runtime.desktop.safeLaunch !== true) return;
    const epoch = generation.current; launching.current = true; setBusy(true); onBusy(true); setMessage(""); setWaitingUntil(Date.now() + 45_000);
    try {
      const result = await client.call(channel, "desktop/launch", {});
      if (active.current && epoch === generation.current) { setRuntime(result); setWaitingUntil(Date.now() + 45_000); }
    } catch {
      if (active.current && epoch === generation.current) {
        setRuntime(undefined); setWaitingUntil(Date.now() + 45_000);
        setMessage("启动结果暂不确定，正在检查电脑状态，不会自动重复启动。");
      }
    } finally { launching.current = false; if (active.current) setBusy(false); onBusy(false); }
    if (active.current && epoch === generation.current) void read();
  };
  const state = desktopStatus(runtime);
  const label = !host.online ? "电脑离线，无法启动 Codex" : !channel ? "电脑在线，连接尚未就绪"
    : waitingUntil && state !== "ready" ? "正在检查 Codex 启动状态…"
    : state === "ready" ? "Codex Desktop 已连接"
    : state === "starting" ? "正在等待 Codex 连接"
    : state === "disabled" ? "电脑未启用 Codex 集成"
    : state === "closed" ? "Codex Desktop 未运行" : "Codex 状态暂不可用";
  return <section className="desktop-wake" aria-label="Codex Desktop 状态">
    <div className="desktop-wake-row"><Monitor size={16} /><span role="status">{label}</span>
      <button type="button" className="icon-button" aria-label="刷新 Codex 状态" disabled={!host.online || !channel || busy || disabled} onClick={() => void read()}><RefreshCw size={16} /></button>
    </div>
    {host.online && state === "closed" && runtime?.desktop?.canWake === true && runtime.desktop.safeLaunch === true && !waitingUntil && <button type="button" className="desktop-wake-action" disabled={!channel || busy || disabled} onClick={() => void launch()}>{busy ? "正在请求启动…" : "启动 Codex Desktop"}</button>}
    {host.online && state === "closed" && runtime?.desktop?.canWake === true && runtime.desktop.safeLaunch !== true && <p>请更新电脑端 Agent Pocket Host 后使用远程启动。</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
