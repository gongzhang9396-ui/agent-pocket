const CACHE = "agent-pocket-web-shell-v2";
const activeWrites = new Set();

self.addEventListener("install", event => {
  // Keep a new worker waiting for the current page. The page may explicitly
  // send SKIP_WAITING after showing an idle update prompt; writes are never
  // cut over automatically during an active request.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(["/app/", "/app/manifest.webmanifest"])));
});

self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING" && activeWrites.size === 0) self.skipWaiting();
  if (event.data?.type === "write-state" && event.source?.id) {
    if (event.data.active) activeWrites.add(event.source.id);
    else activeWrites.delete(event.source.id);
  }
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith("agent-pocket-web-shell-") && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;
  if (url.pathname.startsWith("/app/assets/")) {
    event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request).then(response => {
      const copy = response.clone();
      if (response.ok) void caches.open(CACHE).then(cache => cache.put(event.request, copy));
      return response;
    })));
    return;
  }
  if (event.request.mode === "navigate" || url.pathname === "/app/" || url.pathname === "/app") {
    event.respondWith(fetch(event.request).then(response => {
      const copy = response.clone();
      if (response.ok) void caches.open(CACHE).then(cache => cache.put("/app/", copy));
      return response;
    }).catch(() => caches.match("/app/")));
  }
});
