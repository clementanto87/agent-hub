// AgentHub service worker — app-shell caching so the UI opens instantly and offline.
// API calls and WebSockets are never cached.
const CACHE = 'agenthub-__BUILD__';
const SHELL = [
  '/',
  '/static/styles.css?v=__BUILD__',
  '/static/app.js?v=__BUILD__',
  '/manifest.json',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;

  const sameOrigin = url.origin === self.location.origin;
  const isPage = req.mode === 'navigate';

  if (sameOrigin && (isPage || url.pathname === '/sw.js' || url.pathname === '/manifest.json')) {
    // Network first so updates land immediately; cache is the offline fallback.
    event.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(isPage ? '/' : req, copy)); return res; })
        .catch(() => caches.match(isPage ? '/' : req))
    );
    return;
  }

  // Static assets and CDN libraries: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => { if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
        .catch(() => hit);
      return hit || net;
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sid = event.notification.data?.sessionId;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (sid) client.postMessage({ type: 'OPEN_SESSION', sessionId: sid });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(sid ? `/?session=${encodeURIComponent(sid)}` : '/');
      }
    })
  );
});
