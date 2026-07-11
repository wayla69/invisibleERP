// Server component shell (GRC-1 / ITGC-MON-01) — prefetches the RCM catalogue on the server
// (cookie-forwarded, see lib/server-api.ts) so the first paint carries the control inventory + census. All
// interactivity — family/status filters, the control-detail drawer, and the record-test-run mutation — lives
// in the client island (rcm-client.tsx).
import { serverApi } from '@/lib/server-api';
import RcmClient from './rcm-client';

export const dynamic = 'force-dynamic';

export default async function ControlConsolePage() {
  const initialRcm = await serverApi<unknown>('/api/controls/rcm');
  return <RcmClient initialRcm={initialRcm ?? undefined} />;
}
