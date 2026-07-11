// Server component shell (GRC-3, MDM-01) — prefetches the pending sensitive master-data change queue on the
// server (cookie-forwarded, see lib/server-api.ts) so the reviewer's worklist is in the first paint. All
// interactivity — the propose form, approve/reject mutations, t() — lives in the client island.
import { serverApi } from '@/lib/server-api';
import MasterdataChangesClient, { type ChangeReq } from './mdchange-client';

export const dynamic = 'force-dynamic';

export default async function MasterdataChangeRequestsPage() {
  const initialPending = await serverApi<{ requests: ChangeReq[]; count: number }>('/api/masterdata/change-requests');
  return <MasterdataChangesClient initialPending={initialPending ?? undefined} />;
}
