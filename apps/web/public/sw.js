/* Invisible ERP POS — minimal offline app-shell cache.
   Runtime stale-while-revalidate for GET navigations & static assets so the POS screen
   loads with no network. Sales made offline are queued client-side (see lib/offline.ts)
   and replayed to /api/portal/pos/offline-sync — so we never cache or replay API writes here. */
const CACHE = 'ierp-pos-v1';

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // never touch API writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // same-origin only
  if (url.pathname.startsWith('/api/')) return;      // let API calls hit the network (offline-sync handles queueing)

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => { if (res && res.status === 200) cache.put(req, res.clone()); return res; }).catch(() => cached);
      return cached || network;                       // stale-while-revalidate
    }),
  );
});
