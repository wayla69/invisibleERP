// Server-component shell (GRC-4, GOV-02) — prefetches the KCI roll-up + findings on the server
// (cookie-forwarded, see lib/server-api.ts) so the first paint carries the dashboard. All interactivity —
// the scan trigger, the disposition workflow (owner/due/root-cause → remediate), and the KCI tiles — lives
// in the client island (controls-client.tsx).
import { serverApi } from '@/lib/server-api';
import ControlsClient from './controls-client';

export const dynamic = 'force-dynamic';

export default async function ControlsPage() {
  const [initialKci, initialFindings] = await Promise.all([
    serverApi<unknown>('/api/controls/kci'),
    serverApi<unknown>('/api/controls/findings'),
  ]);
  return <ControlsClient initialKci={initialKci ?? undefined} initialFindings={initialFindings ?? undefined} />;
}
