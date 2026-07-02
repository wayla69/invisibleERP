// Server component shell (docs/28 §4 / AUD-ARC-09) — prefetches the recovery worklist on the server
// (cookie-forwarded, see lib/server-api.ts); the status filter and contact/resolve mutations stay in the
// client island. Converted from client-first to bring the use-client ratchet back to its baseline (the
// page landed in PR #320 while the ratchet was being armed in #322).
import { serverApi } from '@/lib/server-api';
import RecoveryWorklist from './recovery-client';

export const dynamic = 'force-dynamic';

export default async function RecoveryPage() {
  const initial = await serverApi<unknown>('/api/recovery/cases');
  return <RecoveryWorklist initial={initial ?? undefined} />;
}
