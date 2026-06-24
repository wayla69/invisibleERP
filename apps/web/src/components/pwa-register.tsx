'use client';

import { useEffect } from 'react';

// E3 (Platform Phase 28) — PWA installability. Registers the existing app-shell service worker (sw.js: a
// safe same-origin, GET-only, API-skipping stale-while-revalidate cache) so the app is installable + works
// offline. Best-effort; renders nothing. The manifest is served from /manifest.webmanifest.
export function PwaRegister() {
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* SW optional — app still works */ });
    }
  }, []);
  return null;
}
