/**
 * B1 — Offline-first POS client (outbox).
 *
 * Lets the till keep selling when the network is down: sales are queued in IndexedDB with a
 * client-generated UUID, then replayed to the idempotent backend endpoint
 * `POST /api/portal/pos/offline-sync` when connectivity returns. The server dedups on
 * (tenant_id, client_uuid) so a replayed/duplicated op never double-posts (see
 * apps/api/src/modules/portal/offline-sync.service.ts).
 *
 * ⚠️ Scaffold: typechecked but NOT runtime-verified in this environment (needs a browser + IndexedDB).
 * The service worker for app-shell/menu caching is a separate follow-up.
 */
import { api } from '@/lib/api';

export interface OfflineLine { item_id: string; item_description?: string; qty: number; unit_price: number; uom?: string; discount_pct?: number }
export interface OfflineSale {
  client_uuid: string;          // idempotency key — stable across retries
  captured_at: string;          // ISO timestamp of the sale on the device (booked on the offline day)
  lines: OfflineLine[];
  discount?: number;
  payment_method?: string;
  device_id?: string;
  branch_id?: number;
}
export interface SyncResult { client_uuid: string; status: 'synced' | 'duplicate' | 'failed'; sale_no: string | null; error: string | null }

const DB_NAME = 'ierp-pos-offline';
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

/** Queue a sale for later sync. Returns the client_uuid used as the idempotency key. */
export async function enqueue(sale: Omit<OfflineSale, 'client_uuid'> & { client_uuid?: string }): Promise<string> {
  const client_uuid = sale.client_uuid ?? crypto.randomUUID();
  await tx('readwrite', (s) => s.put({ ...sale, client_uuid }));
  return client_uuid;
}

/** All sales currently waiting to sync. */
export function pending(): Promise<OfflineSale[]> {
  return tx<OfflineSale[]>('readonly', (s) => s.getAll() as IDBRequest<OfflineSale[]>);
}

/** Count waiting to sync (for the online/offline + pending-sync badge). */
export async function pendingCount(): Promise<number> {
  return (await pending()).length;
}

function remove(client_uuid: string): Promise<void> {
  return tx('readwrite', (s) => s.delete(client_uuid)).then(() => undefined);
}

/**
 * Replay the outbox to the backend. Synced AND duplicate ops are removed locally (both mean the
 * server holds the sale); failed ops stay queued for the next attempt. Safe to call repeatedly and
 * on `online` events. Returns the per-op results.
 */
export async function sync(): Promise<SyncResult[]> {
  const sales = await pending();
  if (!sales.length) return [];
  const res = await api<{ results: SyncResult[] }>('/api/portal/pos/offline-sync', {
    method: 'POST',
    body: JSON.stringify({ sales }),
  });
  const results = res.results ?? [];
  for (const r of results) if (r.status === 'synced' || r.status === 'duplicate') await remove(r.client_uuid);
  return results;
}

/** Register auto-sync on reconnect. Call once from the POS shell; returns an unsubscribe fn. */
export function autoSyncOnReconnect(onResult?: (r: SyncResult[]) => void): () => void {
  const handler = () => { void sync().then((r) => onResult?.(r)).catch(() => { /* stay queued; retry next online */ }); };
  window.addEventListener('online', handler);
  if (navigator.onLine) handler();
  return () => window.removeEventListener('online', handler);
}
