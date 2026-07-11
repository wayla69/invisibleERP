// Server component shell (HR-1, docs/42) — prefetches the org chart on the server (cookie-forwarded, see
// lib/server-api.ts) so the first paint carries the tree. All interactivity — tabs, create forms, the HR-01
// headcount-governed assignment mutation — lives in the client island (org-client.tsx).
import { serverApi } from '@/lib/server-api';
import OrgClient from './org-client';

export const dynamic = 'force-dynamic';

export default async function HcmOrgPage() {
  const initialChart = await serverApi<unknown>('/api/hcm/org/chart');
  return <OrgClient initialChart={initialChart ?? undefined} />;
}
