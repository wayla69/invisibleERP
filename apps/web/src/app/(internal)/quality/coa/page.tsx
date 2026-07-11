// Server component shell (QMS-3, QC-03) — prefetches the CoA register on the server (cookie-forwarded, see
// lib/server-api.ts) so the first paint carries the list. All interactivity — tabs, spec/CoA/results capture,
// evaluate, and the out-of-spec deviation release maker-checker — lives in the client island (coa-client.tsx).
import { serverApi } from '@/lib/server-api';
import CoaClient from './coa-client';

export const dynamic = 'force-dynamic';

export default async function QualityCoaPage() {
  const initialCoa = await serverApi<unknown>('/api/quality/coa');
  return <CoaClient initialCoa={initialCoa ?? undefined} />;
}
