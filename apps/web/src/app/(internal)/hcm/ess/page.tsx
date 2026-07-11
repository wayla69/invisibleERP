// Server component shell (HR-8, docs/42 Wave 3) — prefetches the employee's own profile-change requests on the
// server (cookie-forwarded, see lib/server-api.ts) so the first paint carries the list. All interactivity —
// tabs, the profile-change form (HR-08 maker-checker), document upload, HR approvals — lives in the client
// island (ess-client.tsx).
import { serverApi } from '@/lib/server-api';
import EssProfileClient from './ess-client';

export const dynamic = 'force-dynamic';

export default async function HcmEssPage() {
  const initialRequests = await serverApi<unknown>('/api/hcm/ess/profile-requests');
  return <EssProfileClient initialRequests={initialRequests ?? undefined} />;
}
