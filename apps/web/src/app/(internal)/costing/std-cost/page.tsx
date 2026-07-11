// Server-component shell (INV-4, control COST-02) — prefetches the standard-cost revision register on the
// server (cookie-forwarded) so the first paint carries the data. All interactivity (propose a revision,
// inspect proposed-vs-current + revalue impact, approve as a distinct user) lives in the client island
// std-cost-client.tsx.
import { serverApi } from '@/lib/server-api';
import StdCostClient from './std-cost-client';

export const dynamic = 'force-dynamic';

export default async function StdCostPage() {
  const revisions = await serverApi<unknown>('/api/costing/std-cost');
  return <StdCostClient initialRevisions={revisions ?? undefined} />;
}
