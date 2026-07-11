// Server-component shell (INV-1, COST-01) — prefetches the tenant's landed-cost vouchers on the server
// (cookie-forwarded, see lib/server-api.ts) so the first paint carries the list. All interactivity — the
// voucher entry form, the allocation preview, and the maker-checker post — lives in the client island
// (landed-cost-client.tsx). serverApi returns null on any failure, in which case the island's react-query
// simply fetches client-side.
import { serverApi } from '@/lib/server-api';
import { LandedCostClient } from './landed-cost-client';

export const dynamic = 'force-dynamic';

export default async function LandedCostPage() {
  const initialList = await serverApi<unknown>('/api/costing/landed-cost');
  return <LandedCostClient initialList={initialList ?? undefined} />;
}
