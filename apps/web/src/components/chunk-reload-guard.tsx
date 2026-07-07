'use client';

import { useEffect } from 'react';

// Deploy-safety net. When a new version is deployed the JS chunk filenames change (content hashes); a tab
// still running the old page — or one served stale HTML by a caching layer / old service worker — then
// requests chunk files that no longer exist → 404 → webpack throws a ChunkLoadError → Next.js shows the
// generic "Application error: a client-side exception has occurred" white screen. This guard catches that
// specific failure and does ONE clean recovery: drop the SW caches, update the service worker, and reload so
// the browser fetches the current HTML + chunks. A short sessionStorage cooldown prevents a reload loop if the
// asset is genuinely, persistently missing (then the crash surfaces normally instead of reloading forever).
const COOLDOWN_KEY = 'chunk-reload-at';
const COOLDOWN_MS = 15_000;

function isChunkLoadError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | undefined;
  const name = e?.name ?? '';
  const msg = e?.message ?? '';
  return name === 'ChunkLoadError' || /Loading chunk [\w-]+ failed/i.test(msg) || /Loading CSS chunk/i.test(msg) || /import\(\) .*failed/i.test(msg);
}

async function recover() {
  try {
    const last = Number(sessionStorage.getItem(COOLDOWN_KEY) ?? '0');
    if (Date.now() - last < COOLDOWN_MS) return; // already tried very recently — let the error surface, no loop
    sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
  } catch { /* private mode: fall through and reload once */ }
  try { if ('caches' in window) { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } } catch { /* ignore */ }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.update().catch(() => r.unregister())));
    }
  } catch { /* ignore */ }
  window.location.reload();
}

export function ChunkReloadGuard() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => { if (isChunkLoadError(e.error) || isChunkLoadError({ message: e.message })) void recover(); };
    const onRejection = (e: PromiseRejectionEvent) => { if (isChunkLoadError(e.reason)) void recover(); };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  }, []);
  return null;
}
