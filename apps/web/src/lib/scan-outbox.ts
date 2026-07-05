// Generic offline scan outbox. Any scan POST whose endpoint is idempotent on a client_uuid
// (No 'use client' directive — imported only by client pages, so it's already in their client bundle;
//  adding the directive would trip the use-client ratchet, tools/ci/check-use-client.mjs.)
// (asset audit scans → asset_audit_scans; mobile-scan lines → scan_lines, both keyed in migration 0251)
// can be queued here when offline and replayed on reconnect without double-counting. Mirrors the POS
// outbox in lib/offline.ts; reuses its useOnline() so we don't duplicate the connectivity listener.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useOnline } from './offline';

export { useOnline };

const KEY = 'ierp_scan_outbox_v1';

export interface ScanOp {
  client_uuid: string;
  url: string;
  body: Record<string, unknown>;
  label?: string;
  queued_at: string;
}

const canStore = () => typeof window !== 'undefined' && !!window.localStorage;
export function newUuid(): string {
  // Use the Web Crypto API for the idempotency key (CodeQL js/insecure-randomness flags Math.random even
  // for a non-token id). Falls back to getRandomValues, then a time-based id — never Math.random.
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) return `sx-${c.randomUUID()}`;
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(12));
    return 'sx-' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return `sx-${Date.now().toString(36)}-${(typeof performance !== 'undefined' ? performance.now() : 0).toString(36).replace('.', '')}`;
}
function read(): ScanOp[] {
  if (!canStore()) return [];
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function write(ops: ScanOp[]) { if (canStore()) localStorage.setItem(KEY, JSON.stringify(ops)); }

export function outboxCount(): number { return read().length; }
function enqueue(op: Omit<ScanOp, 'queued_at'>) { write([...read(), { ...op, queued_at: new Date().toISOString() }]); }

/** Submit a scan. Online → POST immediately (idempotent client_uuid); offline or on network error →
 *  queue it for replay. Returns `queued:true` when it went to the outbox. */
export async function submitScan(url: string, body: Record<string, unknown>, label?: string): Promise<{ queued: boolean; result?: unknown }> {
  const client_uuid = newUuid();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    enqueue({ client_uuid, url, body, label });
    return { queued: true };
  }
  try {
    const result = await api(url, { method: 'POST', body: JSON.stringify({ ...body, client_uuid }) });
    return { queued: false, result };
  } catch {
    enqueue({ client_uuid, url, body, label });
    return { queued: true };
  }
}

/** Replay the whole outbox. Each op is idempotent on its client_uuid, so a re-send is safe. */
export async function flushScans(): Promise<{ synced: number; remaining: number }> {
  const pending = read();
  if (!pending.length) return { synced: 0, remaining: 0 };
  let synced = 0;
  const stay: ScanOp[] = [];
  for (const op of pending) {
    try { await api(op.url, { method: 'POST', body: JSON.stringify({ ...op.body, client_uuid: op.client_uuid }) }); synced++; }
    catch { stay.push(op); }
  }
  write(stay);
  return { synced, remaining: stay.length };
}

/** Pending-count + a flush callback; auto-flushes when connectivity returns. */
export function useScanOutbox(): { count: number; refresh: () => void; flush: () => Promise<{ synced: number; remaining: number }> } {
  const [count, setCount] = useState(0);
  const refresh = useCallback(() => setCount(outboxCount()), []);
  const flush = useCallback(async () => { const r = await flushScans(); refresh(); return r; }, [refresh]);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    const onReconnect = () => { void flush(); };
    window.addEventListener('online', onReconnect);
    return () => { clearInterval(id); window.removeEventListener('online', onReconnect); };
  }, [refresh, flush]);
  return { count, refresh, flush };
}
