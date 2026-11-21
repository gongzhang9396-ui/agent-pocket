export type DesktopRuntime = { desktop?: { state?: string; attachReady?: boolean; processRunning?: boolean; canWake?: boolean; safeLaunch?: boolean } };

export function desktopStatus(runtime?: DesktopRuntime) {
  const desktop = runtime?.desktop;
  if (desktop?.attachReady === true && desktop.state === "ready") return "ready";
  if (desktop?.state === "starting" && (desktop.processRunning === true || desktop.safeLaunch === true)) return "starting";
  if (desktop?.state === "disabled" && desktop.safeLaunch === true) return "disabled";
  if (desktop?.state === "closed" && desktop.processRunning === false) return "closed";
  return "unknown";
}
