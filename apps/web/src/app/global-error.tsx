'use client';

import { useEffect } from 'react';

// App Router global error boundary. Its main job here is the deploy-safety recovery: if the uncaught error is
// a ChunkLoadError (old hashed chunk 404s after a deploy — see chunk-reload-guard.tsx / public/sw.js), drop
// the caches and reload once so the browser pulls the current build instead of showing a dead white screen.
// For any other error it renders a minimal, friendly retry card (this boundary replaces the whole document,
// so it must render its own <html>/<body> and cannot use the app's providers/i18n).
const COOLDOWN_KEY = 'chunk-reload-at';
const COOLDOWN_MS = 15_000;

function isChunkLoadError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | undefined;
  return (e?.name ?? '') === 'ChunkLoadError' || /Loading chunk [\w-]+ failed/i.test(e?.message ?? '') || /Loading CSS chunk/i.test(e?.message ?? '');
}

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    if (!isChunkLoadError(error)) return;
    let recent = false;
    try {
      recent = Date.now() - Number(sessionStorage.getItem(COOLDOWN_KEY) ?? '0') < COOLDOWN_MS;
      sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
    } catch { /* private mode */ }
    if (recent) return; // avoid a reload loop if the asset is genuinely gone
    (async () => {
      try { if ('caches' in window) { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } } catch { /* ignore */ }
      try { if ('serviceWorker' in navigator) { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map((r) => r.update().catch(() => r.unregister()))); } } catch { /* ignore */ }
      window.location.reload();
    })();
  }, [error]);

  return (
    <html lang="th">
      <body style={{ margin: 0, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', background: '#f8fafc', color: '#0f172a', padding: '1.5rem' }}>
        <div style={{ maxWidth: 420, width: '100%', textAlign: 'center' }}>
          <div style={{ fontSize: 40, lineHeight: 1 }} aria-hidden>⚠️</div>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0.75rem 0 0.25rem' }}>เกิดข้อผิดพลาด • Something went wrong</h1>
          <p style={{ fontSize: 14, color: '#64748b', margin: '0 0 1.25rem' }}>
            กรุณาลองใหม่อีกครั้ง — โหลดหน้าใหม่เพื่อรับเวอร์ชันล่าสุด<br />
            Please try again — reloading fetches the latest version.
          </p>
          <button
            onClick={() => { try { window.location.reload(); } catch { reset(); } }}
            style={{ appearance: 'none', border: 'none', cursor: 'pointer', background: '#1E3C72', color: '#fff', fontSize: 15, fontWeight: 600, padding: '0.6rem 1.4rem', borderRadius: 10 }}
          >
            โหลดใหม่ • Reload
          </button>
        </div>
      </body>
    </html>
  );
}
