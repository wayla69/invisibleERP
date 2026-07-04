// Server component (docs/28 §4 / docs/27 R5-2 — RSC conversion). A read-only Win/Loss analytics
// dashboard: one fetch, no client interactivity, so it prefetches on the server (cookie-forwarded, see
// lib/server-api.ts) and hands the payload to a client island for rendering + i18n. The recharts visuals
// are client islands composed from that child.
import { serverApi } from '@/lib/server-api';
import { PipelineClient } from './pipeline-client';

// cookies() (via serverApi) already opts this route out of prerendering; explicit for clarity.
export const dynamic = 'force-dynamic';

export default async function PipelineDashboardPage() {
  const d = await serverApi<any>('/api/crm/pipeline/win-loss?months=12');
  return <PipelineClient data={d} />;
}
