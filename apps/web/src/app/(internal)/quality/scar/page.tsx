// Server component shell (QMS-4) — prefetches the SCAR register + the overdue worklist on the server
// (cookie-forwarded, see lib/server-api.ts) so the first paint carries the data. All interactivity — tabs,
// the raise form, the 8D response, and the QC-04 closure maker-checker — lives in the client island.
import { serverApi } from '@/lib/server-api';
import ScarClient from './scar-client';

export const dynamic = 'force-dynamic';

export default async function QualityScarPage() {
  const [initialScars, initialOverdue] = await Promise.all([
    serverApi<unknown>('/api/quality/scar'),
    serverApi<unknown>('/api/quality/scar/open?days=0'),
  ]);
  return <ScarClient initialScars={initialScars ?? undefined} initialOverdue={initialOverdue ?? undefined} />;
}
