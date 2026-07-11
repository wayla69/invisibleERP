// Server-component shell (SVC-3) — prefetches the pending-renewal queue + the expiring-contract worklist on
// the server (cookie-forwarded) so the first paint carries the data. All interactivity (approve/reject, the
// expiry horizon selector) lives in the client island renewals-client.tsx.
import { serverApi } from '@/lib/server-api';
import RenewalsClient from './renewals-client';

export const dynamic = 'force-dynamic';

export default async function ServiceRenewalsPage() {
  const [renewals, expiring] = await Promise.all([
    serverApi<unknown>('/api/service/renewals?status=pending'),
    serverApi<unknown>('/api/service/contracts/expiring?days=60'),
  ]);
  return <RenewalsClient initialRenewals={renewals ?? undefined} initialExpiring={expiring ?? undefined} />;
}
