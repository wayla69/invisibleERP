// CFO Command Center (docs/35 Phase 2). Read-only KPI scorecard: server-prefetch the canonical pack
// (cookie-forwarded) and hand it to a client island that renders RAG tiles, comparatives, live refresh
// (fin_kpi_refresh SSE) and lazy per-KPI trend/drill. Matches the financial-health prefetch pattern.
import { serverApi } from '@/lib/server-api';
import { CommandCenterClient } from './command-center-client';

export const dynamic = 'force-dynamic';

export default async function CommandCenterPage() {
  const data = await serverApi<any>('/api/finance/metrics/pack');
  return <CommandCenterClient initialData={data} />;
}
