// Server component shell (docs/28 §4 / docs/27 R5-2 — RSC conversion #5).
// Prefetches the overview tab's dashboard summary on the server (cookie-forwarded, lib/server-api.ts);
// anomaly/replenishment tabs and the drill-down stay in the client island, unchanged.
import { serverApi } from '@/lib/server-api';
import InsightsWorkspace from './insights-client';

export const dynamic = 'force-dynamic';

export default async function InsightsPage() {
  const initialSummary = await serverApi<unknown>('/api/analytics/dashboard-summary');
  return <InsightsWorkspace initialSummary={initialSummary ?? undefined} />;
}
