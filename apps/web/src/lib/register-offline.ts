/**
 * Touch-register offline outbox.
 *
 * The main register (/pos/register) sells MENU items by `sku` through the restaurant
 * order→checkout path. When the network is down, a quick (no-table) cash sale is queued in
 * IndexedDB with a client-generated UUID, then replayed to the idempotent backend endpoint
 * `POST /api/restaurant/offline-sync` when connectivity returns. The server dedups on
 * (tenant, client_uuid) so a replayed/duplicated op never double-posts (see
 * apps/api/src/modules/restaurant/offline-sync.service.ts).
 *
 * Distinct from `lib/offline-pos.ts` (the portal/inventory POS outbox) — different catalog,
 * different sale path, its OWN IndexedDB store — but the same idempotency contract.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

export interface RegisterOfflineLine { sku?: string; menu_item_id?: number; qty: number; modifier_option_ids?: number[]; notes?: string }
export interface RegisterOfflineSale {
  client_uuid: string;          // idempotency key — stable across retries
  captured_at: string;          // ISO timestamp the sale was rung on the device
  lines: RegisterOfflineLine[];
  method?: string;
  discount_pct?: number;
  device_id?: string;
  total?: number;               // client-computed total (display only; the server re-prices authoritatively)
}
export interface RegisterSyncResult { client_uuid: string; status: 'synced' | 'duplicate' | 'failed'; sale_no: string | null; error: string | null }

const DB_NAME = 'ierp-register-offline';
const STORE = 'outbox';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'client_uuid' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const store = db.transaction(STORE, mode).objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Queue a register sale for later sync. Returns the client_uuid used as the idempotency key. */
export async function enqueueRegisterSale(sale: Omit<RegisterOfflineSale, 'client_uuid'> & { client_uuid?: string }): Promise<string> {
  const client_uuid = sale.client_uuid ?? crypto.randomUUID();
  await tx('readwrite', (s) => s.put({ ...sale, client_uuid }));
  return client_uuid;
}

export function pending(): Promise<RegisterOfflineSale[]> {
  return tx<RegisterOfflineSale[]>('readonly', (s) => s.getAll() as IDBRequest<RegisterOfflineSale[]>);
}

export async function pendingCount(): Promise<number> {
  return (await pending()).length;
}

function remove(client_uuid: string): Promise<void> {
  return tx('readwrite', (s) => s.delete(client_uuid)).then(() => undefined);
}

/**
 * Replay the outbox. Synced AND duplicate ops are removed locally (both mean the server holds the
 * sale); failed ops stay queued for the next attempt. Safe to call repeatedly and on `online` events.
 */
export async function syncRegister(): Promise<RegisterSyncResult[]> {
  const sales = await pending();
  if (!sales.length) return [];
  const res = await api<{ results: RegisterSyncResult[] }>('/api/restaurant/offline-sync', {
    method: 'POST',
    body: JSON.stringify({ sales }),
  });
  const results = res.results ?? [];
  for (const r of results) if (r.status === 'synced' || r.status === 'duplicate') await remove(r.client_uuid);
  return results;
}

/** Pending-count + a flush(), with auto-sync on reconnect. Drives the register's offline badge. */
export function useRegisterOutbox(): { count: number; refresh: () => void; flush: () => Promise<RegisterSyncResult[]> } {
  const [count, setCount] = useState(0);
  const refresh = useCallback(() => { void pendingCount().then(setCount).catch(() => { /* IndexedDB unavailable */ }); }, []);
  const flush = useCallback(async () => {
    const r = await syncRegister();
    refresh();
    return r;
  }, [refresh]);
  useEffect(() => {
    refresh();
    const onOnline = () => { void flush().catch(() => { /* stay queued; retry next online */ }); };
    window.addEventListener('online', onOnline);
    if (typeof navigator !== 'undefined' && navigator.onLine) onOnline();
    return () => window.removeEventListener('online', onOnline);
  }, [refresh, flush]);
  return { count, refresh, flush };
}
