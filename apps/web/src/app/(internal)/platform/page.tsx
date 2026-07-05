// Server component shell (docs/28 §4 — RSC server shell + client island). Prefetches the company directory
// and the pending-onboarding queue on the server (cookie-forwarded, see lib/server-api.ts) so a god's first
// paint carries data. All interactivity (provision/suspend/approve/invite, act-as jump) lives in the client
// island. Access is enforced by the API (@PlatformAdmin → 403 for non-owners); the nav only surfaces this
// route for a platform owner.
import { serverApi } from '@/lib/server-api';
import PlatformConsole from './platform-client';

export const dynamic = 'force-dynamic';

export default async function PlatformPage() {
  const [companies, requests] = await Promise.all([
    serverApi<any[]>('/api/admin/tenants'),
    serverApi<{ requests: any[] }>('/api/admin/signup-requests?status=pending'),
  ]);
  return <PlatformConsole initialCompanies={companies ?? undefined} initialRequests={requests?.requests ?? undefined} />;
}
