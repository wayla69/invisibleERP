// Server component shell (HR-6, docs/42 Wave 2) — prefetches the pay-grade bands on the server (cookie-
// forwarded, see lib/server-api.ts) so the first paint carries the grades. All interactivity — tabs, create
// forms, and the HR-06 comp-change request/approve maker-checker — lives in the client island (comp-client.tsx).
import { serverApi } from '@/lib/server-api';
import CompClient from './comp-client';

export const dynamic = 'force-dynamic';

export default async function HcmCompPage() {
  const initialGrades = await serverApi<unknown>('/api/hcm/comp/grades');
  return <CompClient initialGrades={initialGrades ?? undefined} />;
}
