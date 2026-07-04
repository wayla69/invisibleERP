// Read-only working-capital dashboard: one fetch, no client interactivity, so it prefetches on the server
// (cookie-forwarded, see lib/server-api.ts) and hands the snapshot to a client island for rendering + i18n.
import { serverApi } from '@/lib/server-api';
import { FinancialHealthClient } from './financial-health-client';

// cookies() (via serverApi) already opts this route out of prerendering; explicit for clarity.
export const dynamic = 'force-dynamic';

export default async function FinancialHealthPage() {
  const data = await serverApi<any>('/api/finance/health');
  return <FinancialHealthClient data={data} />;
}
