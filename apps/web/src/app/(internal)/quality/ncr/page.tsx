// Server-component shell (QMS-1, QC-01) — prefetches the NCR register + the defect-code lookup on the server
// (cookie-forwarded) so the first paint carries the data. All interactivity (raise, disposition-approve/reject,
// add defect code) lives in the client island ncr-client.tsx.
import { serverApi } from '@/lib/server-api';
import NcrClient from './ncr-client';

export const dynamic = 'force-dynamic';

export default async function QualityNcrPage() {
  const [ncrs, defectCodes] = await Promise.all([
    serverApi<unknown>('/api/quality/ncr'),
    serverApi<unknown>('/api/quality/defect-codes'),
  ]);
  return <NcrClient initialNcrs={ncrs ?? undefined} initialDefects={defectCodes ?? undefined} />;
}
