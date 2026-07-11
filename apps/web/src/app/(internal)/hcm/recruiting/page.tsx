// Server component shell (HR-4, docs/42 Wave 2) — prefetches the requisition list on the server
// (cookie-forwarded, see lib/server-api.ts) so the first paint carries the recruiting queue. All
// interactivity — tabs, create forms, the HR-04 maker-checker approve/authorize/convert mutations — lives in
// the client island (recruiting-client.tsx).
import { serverApi } from '@/lib/server-api';
import RecruitingClient from './recruiting-client';

export const dynamic = 'force-dynamic';

export default async function HcmRecruitingPage() {
  const initialReqs = await serverApi<unknown>('/api/hcm/recruiting/requisitions');
  return <RecruitingClient initialReqs={initialReqs ?? undefined} />;
}
