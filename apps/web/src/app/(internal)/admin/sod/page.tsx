// Server component shell (GRC-5, ITGC-AC-22) — prefetches the standing SoD-conflict dashboard, the accepted
// register and the expired worklist on the server (cookie-forwarded, see lib/server-api.ts) so the first
// paint carries them. All interactivity — accept a conflict (with a mandatory compensating control + owner +
// expiry) and periodic re-review — lives in the client island (sod-client.tsx).
import { serverApi } from '@/lib/server-api';
import SodClient from './sod-client';

export const dynamic = 'force-dynamic';

export default async function AdminSodPage() {
  const [conflicts, dispositions, expired] = await Promise.all([
    serverApi<unknown>('/api/admin/sod/conflicts'),
    serverApi<unknown>('/api/admin/sod/dispositions'),
    serverApi<unknown>('/api/admin/sod/dispositions/expired'),
  ]);
  return <SodClient initialConflicts={conflicts ?? undefined} initialDispositions={dispositions ?? undefined} initialExpired={expired ?? undefined} />;
}
