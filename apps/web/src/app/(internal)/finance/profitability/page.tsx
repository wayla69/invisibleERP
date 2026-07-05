// Segment profitability (docs/35 Phase 5). Read-only P&L by dimension: server-prefetch the by-branch view
// (cookie-forwarded) and hand it to a client island that lets the user switch dimension + renders it.
import { serverApi } from '@/lib/server-api';
import { ProfitabilityClient } from './profitability-client';

export const dynamic = 'force-dynamic';

export default async function ProfitabilityPage() {
  const data = await serverApi<any>('/api/finance/metrics/profitability?by=branch');
  return <ProfitabilityClient initialData={data} />;
}
