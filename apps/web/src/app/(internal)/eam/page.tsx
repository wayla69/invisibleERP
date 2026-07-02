// Server component shell (docs/28 §4 / docs/27 R5-2 — RSC conversion #2, same pattern as accounting).
// Prefetches the default tab's work-order list on the server (cookie-forwarded, see lib/server-api.ts);
// all interactivity — WO forms, PM runs, reliability drill-down — stays in the client island, unchanged.
import { serverApi } from '@/lib/server-api';
import EamWorkspace from './eam-client';

export const dynamic = 'force-dynamic';

export default async function EamPage() {
  const initialWo = await serverApi<unknown>('/api/eam/work-orders?limit=200');
  return <EamWorkspace initialWo={initialWo ?? undefined} />;
}
