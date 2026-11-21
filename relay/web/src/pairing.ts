export type HostPairingCode = { enrollmentId: string; secret: string };
export function parseHostPairing(value: string, origin: string): HostPairingCode {
  const input = value.trim(); let code = input;
  if (input.startsWith("https://") || input.startsWith("http://") || input.startsWith("agentpocket://")) {
    const url = new URL(input);
    if (url.username || url.password) throw new Error("配对链接不能包含登录信息");
    if (url.protocol === "agentpocket:") {
      if (url.hostname !== "relay-host") throw new Error("这不是电脑绑定链接");
      const relay = new URL(url.searchParams.get("relay") || "");
      if (relay.origin !== origin || relay.username || relay.password || relay.pathname !== "/" || relay.search || relay.hash) throw new Error("电脑使用的服务端与当前网页不一致");
      code = `${url.searchParams.get("enrollmentId")}.${url.searchParams.get("secret")}`;
    } else {
      if (url.origin !== origin || url.pathname !== "/app/" || url.search) throw new Error("电脑使用的服务端与当前网页不一致");
      code = new URLSearchParams(url.hash.slice(1)).get("pair") || "";
    }
  }
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{24,128})$/i.exec(code);
  if (!match) throw new Error("请粘贴配对助手提供的网页链接或完整配对码");
  return { enrollmentId: match[1], secret: match[2] };
}
export function takePairingFragment(): string {
  if (!location.hash.startsWith("#pair=")) return "";
  const value = `${location.origin}/app/${location.hash}`;
  // Keep the short-lived capability in memory, out of the address bar/history.
  history.replaceState(null, "", location.pathname + location.search);
  return value;
}
