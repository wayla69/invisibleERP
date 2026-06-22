'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

// Offline-first POS outbox. Sales captured while offline are queued in localStorage and replayed
// against /api/portal/pos/offline-sync — which is idempotent on (tenant, client_uuid), so a flaky
// connection or double-flush never double-books. Pairs with the DB unique index added in 0051.

const OUTBOX_KEY = 'ierp_pos_outbox_v1';
const DEVICE_KEY = 'ierp_pos_device_id';
const SEQ_KEY = 'ierp_pos_seq';

export interface OutboxLine { item_id: string; qty: number; unit_price: number; discount_pct?: number }
export interface OutboxSale {
  client_uuid: string;
  device_id: string;
  client_seq: number;
  captured_at: string;
  payment_method?: string;
  discount?: number;
  lines: OutboxLine[];
}

const canStore = () => typeof window !== 'undefined' && !!window.localStorage;

export function deviceId(): string {
  if (!canStore()) return 'srv';
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) { id = 'dev-' + Math.random().toString(36).slice(2, 10); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}
function nextSeq(): number {
  if (!canStore()) return 0;
  const s = Number(localStorage.getItem(SEQ_KEY) || '0') + 1;
  localStorage.setItem(SEQ_KEY, String(s));
  return s;
}
export function newClientUuid(): string {
  return `${deviceId()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function readOutbox(): OutboxSale[] {
  if (!canStore()) return [];
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
}
function writeOutbox(sales: OutboxSale[]) { if (canStore()) localStorage.setItem(OUTBOX_KEY, JSON.stringify(sales)); }

/** Queue a sale for later sync. Stamps device_id / client_seq / client_uuid if absent. */
export function enqueueSale(sale: Omit<OutboxSale, 'device_id' | 'client_seq' | 'client_uuid'> & Partial<Pick<OutboxSale, 'client_uuid'>>): OutboxSale {
  const full: OutboxSale = { client_uuid: sale.client_uuid ?? newClientUuid(), device_id: deviceId(), client_seq: nextSeq(), captured_at: sale.captured_at, payment_method: sale.payment_method, discount: sale.discount, lines: sale.lines };
  writeOutbox([...readOutbox(), full]);
  return full;
}

export interface FlushResult { synced: number; duplicate: number; failed: number; remaining: number }

/** Replay the whole outbox. Synced + duplicate ops are dropped; failed ops stay for the next attempt. */
export async function flushOutbox(): Promise<FlushResult> {
  const pending = readOutbox();
  if (!pending.length) return { synced: 0, duplicate: 0, failed: 0, remaining: 0 };
  const res = await api<{ results: { client_uuid: string; status: string }[]; summary: Record<string, number> }>(
    '/api/portal/pos/offline-sync', { method: 'POST', body: JSON.stringify({ sales: pending }) },
  );
  const done = new Set((res.results ?? []).filter((r) => r.status === 'synced' || r.status === 'duplicate').map((r) => r.client_uuid));
  const remaining = pending.filter((s) => !done.has(s.client_uuid));
  writeOutbox(remaining);
  return { synced: res.summary?.synced ?? 0, duplicate: res.summary?.duplicate ?? 0, failed: res.summary?.failed ?? 0, remaining: remaining.length };
}

/** Register the app-shell service worker (idempotent; no-op without SW support). */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is best-effort */ });
}

/** Live online/offline flag driven by the browser. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

/** Pending-count + a refresh callback; auto-flushes when connectivity returns. */
export function useOutbox(): { count: number; refresh: () => void; flush: () => Promise<FlushResult> } {
  const [count, setCount] = useState(0);
  const refresh = useCallback(() => setCount(readOutbox().length), []);
  const flush = useCallback(async () => { const r = await flushOutbox(); refresh(); return r; }, [refresh]);
  useEffect(() => {
    registerServiceWorker();
    refresh();
    const id = setInterval(refresh, 3000);
    const onReconnect = () => { void flush(); };
    window.addEventListener('online', onReconnect);
    return () => { clearInterval(id); window.removeEventListener('online', onReconnect); };
  }, [refresh, flush]);
  return { count, refresh, flush };
}
