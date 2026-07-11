// Server component shell (GRC-2 / ITGC-AC-21) — prefetches the recertification-campaign history on the server
// (cookie-forwarded, see lib/server-api.ts) so the first paint carries the list. All interactivity — opening a
// campaign, per-user keep/revoke, and certification (which auto-removes revoked grants) — lives in the client
// island (access-recert-client.tsx).
import { serverApi } from '@/lib/server-api';
import AccessRecertClient from './access-recert-client';

export const dynamic = 'force-dynamic';

export default async function AccessRecertPage() {
  const initialCerts = await serverApi<unknown>('/api/admin/users/access-review/certifications');
  return <AccessRecertClient initialCerts={initialCerts ?? undefined} />;
}
