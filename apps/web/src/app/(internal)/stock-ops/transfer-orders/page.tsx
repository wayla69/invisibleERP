// Server-component shell (INV-2, INV-16) — prefetches the transfer-order list + the in-transit aging report
// on the server (cookie-forwarded) so the first paint carries the data. All interactivity (create, ship,
// receive, detail) lives in the client island transfer-orders-client.tsx.
import { serverApi } from '@/lib/server-api';
import TransferOrdersClient from './transfer-orders-client';

export const dynamic = 'force-dynamic';

export default async function TransferOrdersPage() {
  const [orders, aging] = await Promise.all([
    serverApi<unknown>('/api/stock-ops/transfer-orders'),
    serverApi<unknown>('/api/stock-ops/transfer-orders/in-transit/aging'),
  ]);
  return <TransferOrdersClient initialOrders={orders ?? undefined} initialAging={aging ?? undefined} />;
}
