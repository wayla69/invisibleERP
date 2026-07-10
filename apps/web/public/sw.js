/* Invisible ERP POS — offline app-shell cache.
   Strategy (deploy-safe):
   - HTML navigations  → NETWORK-FIRST (fall back to cache only when offline). Serving *stale* HTML after a
     deploy was the root cause of the "Application error: a client-side exception (Loading chunk failed)"
     crash: cached old HTML references old hashed chunk filenames that the new deploy has removed → 404.
   - /_next/static/*   → CACHE-FIRST. These are content-hashed (immutable): a given URL never changes bytes,
     so caching forever is safe and they never go stale. Fresh HTML always points at chunks that exist.
   - GET /api/menu     → stale-while-revalidate (POS-6: cache DATA, not HTML). The menu + prices are the one
     read-only catalog the offline register needs to keep ringing; serving the last snapshot on a reload
     mid-outage keeps the till sellable. Every OTHER /api/* (auth'd, mutable, writes) bypasses the SW.
   - other same-origin GETs → stale-while-revalidate (fast, self-healing).
   Sales made offline are queued client-side (lib/offline.ts, lib/register-offline.ts) and replayed to the
   idempotent offline-sync endpoints, so we never cache or replay API writes here. */
const CACHE = 'ierp-pos-v4'; // v4: add GET /api/menu data caching (POS-6); purge older shells on activate

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  // Purge every older cache (incl. the v1 that may hold stale HTML/chunks) and take control immediately.
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                  // never touch API writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // same-origin only
  if (url.pathname.startsWith('/api/')) {
    // POS-6: cache DATA (not HTML) — the read-only menu/prices GET is served stale-while-revalidate so a
    // reload while offline still renders a sellable menu. All other /api/* bypass the SW (network only).
    if (url.pathname === '/api/menu') {
      event.respondWith(
        caches.open(CACHE).then(async (cache) => {
          const cached = await cache.match(req);
          const network = fetch(req).then((res) => { if (res && res.status === 200 && !res.redirected) cache.put(req, res.clone()); return res; }).catch(() => cached);
          return cached || network;
        }),
      );
    }
    return;
  }

  const isNavigation = req.mode === 'navigate' || req.destination === 'document';
  const isHashedAsset = url.pathname.startsWith('/_next/static/');

  if (isNavigation) {
    // Network-first: always try to load the *current* HTML (with today's chunk hashes). Only if the network
    // is unavailable do we fall back to the last cached shell, so the installed app still opens offline.
    // Never cache a redirect-followed response: an expired session bouncing /pos/register → /login would
    // otherwise poison the offline shell with the login page under the register's URL.
    event.respondWith(
      fetch(req)
        .then((res) => { if (res && res.status === 200 && !res.redirected) { const c = res.clone(); caches.open(CACHE).then((cache) => cache.put(req, c)); } return res; })
        .catch(() => caches.open(CACHE).then((cache) => cache.match(req).then((cached) => cached || cache.match('/')))),
    );
    return;
  }

  if (isHashedAsset) {
    // Cache-first for immutable, content-hashed build assets — instant, and it can never serve wrong bytes.
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res && res.status === 200) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // Everything else same-origin (images, manifest, icons): stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => { if (res && res.status === 200 && !res.redirected) cache.put(req, res.clone()); return res; }).catch(() => cached);
      return cached || network;
    }),
  );
});
