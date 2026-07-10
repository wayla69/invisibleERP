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
const DINEIN_STORE = 'dinein';   // POS-6: offline dine-in ops (open/add/fire), keyed on client_uuid
const DB_VERSION = 2;
const SEQ_KEY = 'ierp_register_seq';  // per-device monotonic counter → replay ops in capture order

// ── offline menu snapshot ─────────────────────────────────────────────────────────────────────
// The service worker deliberately never caches /api/* (auth'd + mutable), so a page reload while
// the network is down used to lose the menu and brick the till even though the outbox still
// worked. Keep the last good /api/menu payload in localStorage and serve it when the live fetch
// fails — the register can then reboot/refresh mid-outage and keep ringing quick sales.
const MENU_CACHE_KEY = 'ierp_register_menu_v1';

export async function fetchMenuOfflineFirst<T>(fetchLive: () => Promise<T>): Promise<T> {
  try {
    const fresh = await fetchLive();
    try { localStorage.setItem(MENU_CACHE_KEY, JSON.stringify(fresh)); } catch { /* quota/unavailable — live data still served */ }
    return fresh;
  } catch (e) {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(MENU_CACHE_KEY) : null;
    if (raw) {
      try { return JSON.parse(raw) as T; } catch { /* corrupt snapshot — fall through to the live error */ }
    }
    throw e;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'client_uuid' });
      if (!db.objectStoreNames.contains(DINEIN_STORE)) db.createObjectStore(DINEIN_STORE, { keyPath: 'client_uuid' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txStore<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const store = db.transaction(storeName, mode).objectStore(storeName);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return txStore(STORE, mode, fn);
}

// per-device monotonic sequence so open→add→fire replay in capture order (the server sorts by client_seq).
function nextSeq(): number {
  if (typeof window === 'undefined' || !window.localStorage) return Date.now();
  const s = Number(localStorage.getItem(SEQ_KEY) || '0') + 1;
  try { localStorage.setItem(SEQ_KEY, String(s)); } catch { /* quota */ }
  return s;
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

// ── POS-6: offline DINE-IN outbox (open table / add items / fire) ───────────────────────────────
// Dine-in was online-only (kitchen/fire). Offline we now capture the order lifecycle — open + fire (and
// optionally add) — as idempotent ops keyed by a client `order_uuid` that links them, and replay to
// `POST /api/restaurant/offline-sync/dinein` on reconnect. SETTLEMENT stays ONLINE: the replay creates
// and fires the order; the cashier settles it through the normal (online) checkout once reconnected.
export interface DineInOfflineOp {
  client_uuid: string;          // per-op idempotency key
  order_uuid: string;           // client offline-order key linking open→add→fire
  op: 'open' | 'add' | 'fire';
  captured_at: string;
  device_id?: string;
  client_seq?: number;
  table_id?: number;
  guest_count?: number;
  fulfillment_type?: string;
  lines?: RegisterOfflineLine[];
  course?: number;
}
export interface DineInSyncResult { client_uuid: string; op: string; status: 'synced' | 'duplicate' | 'failed'; order_no: string | null; error: string | null }

export function pendingDineIn(): Promise<DineInOfflineOp[]> {
  return txStore<DineInOfflineOp[]>(DINEIN_STORE, 'readonly', (s) => s.getAll() as IDBRequest<DineInOfflineOp[]>);
}
function removeDineIn(client_uuid: string): Promise<void> {
  return txStore(DINEIN_STORE, 'readwrite', (s) => s.delete(client_uuid)).then(() => undefined);
}

/**
 * Queue a dine-in order captured offline: an `open` op (table + items) and, when `fire` is set, a linked
 * `fire` op so the kitchen gets it on reconnect. All ops share one `order_uuid`. Returns that key.
 */
export async function enqueueOfflineDineInOrder(input: {
  table_id?: number; guest_count?: number; fulfillment_type?: string; lines: RegisterOfflineLine[]; fire?: boolean; device_id?: string;
}): Promise<string> {
  const order_uuid = crypto.randomUUID();
  const captured_at = new Date().toISOString();
  const openOp: DineInOfflineOp = {
    client_uuid: crypto.randomUUID(), order_uuid, op: 'open', captured_at, device_id: input.device_id, client_seq: nextSeq(),
    table_id: input.table_id, guest_count: input.guest_count, fulfillment_type: input.fulfillment_type, lines: input.lines,
  };
  await txStore(DINEIN_STORE, 'readwrite', (s) => s.put(openOp));
  if (input.fire) {
    const fireOp: DineInOfflineOp = { client_uuid: crypto.randomUUID(), order_uuid, op: 'fire', captured_at, device_id: input.device_id, client_seq: nextSeq() };
    await txStore(DINEIN_STORE, 'readwrite', (s) => s.put(fireOp));
  }
  return order_uuid;
}

export async function pendingDineInCount(): Promise<number> {
  return (await pendingDineIn()).length;
}

/** Replay the dine-in outbox. Synced + duplicate ops are removed; failed ops stay queued for the next try. */
export async function syncDineIn(): Promise<DineInSyncResult[]> {
  const ops = await pendingDineIn();
  if (!ops.length) return [];
  const res = await api<{ results: DineInSyncResult[] }>('/api/restaurant/offline-sync/dinein', {
    method: 'POST',
    body: JSON.stringify({ ops }),
  });
  const results = res.results ?? [];
  for (const r of results) if (r.status === 'synced' || r.status === 'duplicate') await removeDineIn(r.client_uuid);
  return results;
}

/** Pending-count (quick sales + dine-in ops) + a flush(), with auto-sync on reconnect. Drives the register's offline badge. */
export function useRegisterOutbox(): { count: number; refresh: () => void; flush: () => Promise<RegisterSyncResult[]> } {
  const [count, setCount] = useState(0);
  const refresh = useCallback(() => {
    void Promise.all([pendingCount(), pendingDineInCount()]).then(([a, b]) => setCount(a + b)).catch(() => { /* IndexedDB unavailable */ });
  }, []);
  const flush = useCallback(async () => {
    // replay dine-in ops first (kitchen/order lifecycle), then quick sales; both idempotent server-side.
    await syncDineIn().catch(() => { /* stay queued */ });
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
