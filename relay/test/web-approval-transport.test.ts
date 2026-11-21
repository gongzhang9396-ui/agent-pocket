import assert from "node:assert/strict";
import test from "node:test";
import { RelayClient } from "../web/src/relay-client.ts";

test("an outer relay failure cleans approval listeners; both possible rejection paths are observed", async () => {
  const previous = (globalThis as any).window;
  (globalThis as any).window = { setTimeout, clearTimeout };
  try {
    const client = new RelayClient("a", "r", "account", "device", {} as any);
    (client as any).request = async () => { throw new Error("relay disconnected"); };
    const channel: any = { estimateFrameBytes: () => 100, encrypt: () => ({}) };
    await assert.rejects(client.call(channel, "approval/respond", {}), /relay disconnected/);
    assert.equal((client as any).listeners.size, 0);
    (client as any).request = async () => {
      for (const listener of (client as any).listeners) listener({ type: "closed" });
      throw new Error("outer closed too");
    };
    await assert.rejects(client.call(channel, "approval/respond", {}));
    assert.equal((client as any).listeners.size, 0);
  } finally { (globalThis as any).window = previous; }
});

test("manual reconnect cancels delayed reconnect and ignores replaced socket events", async () => {
  const original = { window: (globalThis as any).window, WebSocket: (globalThis as any).WebSocket, location: (globalThis as any).location };
  const timers = new Map<number, () => void>(); let timer = 0;
  const sockets: any[] = [];
  class Socket {
    static OPEN = 1; readyState = 1; onopen?: () => void; onmessage?: (v: any) => void; onclose?: (v: any) => void;
    constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
    close() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "" }); }
  }
  Object.assign(globalThis, { window: { setTimeout: (fn: () => void) => { timers.set(++timer, fn); return timer; }, clearTimeout: (id: number) => timers.delete(id) }, WebSocket: Socket, location: { protocol: "https:", host: "local.test" } });
  try {
    const client = new RelayClient("a", "r", "account", "device", {} as any);
    (client as any).ticket = async () => "short-ticket";
    (client as any).request = async () => ({});
    const events: any[] = []; client.on((event) => events.push(event));
    await client.connect(); await client.connect(); assert.equal(sockets.length, 1);
    sockets[0].close(); assert.equal(timers.size, 1);
    await client.reconnect(); assert.equal(timers.size, 0); assert.equal(sockets.length, 2);
    sockets[0].onmessage({ data: JSON.stringify({ method: "stale-event" }) });
    assert.equal(events.some((event) => event.type === "stale-event"), false);
    await client.reconnect(); assert.equal(sockets.length, 2);
    await client.close();
  } finally { Object.assign(globalThis, original); }
});

test("oversized final encrypted frames are identified as never sent", async () => {
  const client = new RelayClient("a", "r", "account", "device", {} as any);
  const channel: any = { estimateFrameBytes: () => 10 * 1024 * 1024, encrypt: () => assert.fail("must not advance counter") };
  await assert.rejects(client.call(channel, "turn/start", {}), (error: any) => error.notSent === true);
});

test("closing an approval dialog while its ticket is in flight cannot open a socket afterwards", async () => {
  const prior = { window: (globalThis as any).window, WebSocket: globalThis.WebSocket };
  let release: ((value: string) => void) | undefined; let requested: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  let sockets = 0;
  (globalThis as any).window = { setTimeout, clearTimeout };
  (globalThis as any).WebSocket = class { static OPEN = 1; constructor() { sockets++; } };
  try {
    const client = new RelayClient("a", "r", "account", "device", {} as any);
    (client as any).ticket = () => { requested!(); return new Promise<string>((resolve) => { release = resolve; }); };
    const connecting = client.connect(); await started;
    await client.close(); release!("late-ticket"); await connecting;
    assert.equal(sockets, 0);
  } finally { Object.assign(globalThis, prior); }
});
