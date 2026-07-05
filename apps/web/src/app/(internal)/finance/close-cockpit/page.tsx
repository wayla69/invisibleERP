// Controller Close Cockpit (docs/35 Phase 3). Read-only period-close readiness board: server-prefetch the
// close-status aggregate (cookie-forwarded) and hand it to a client island for rendering + i18n.
import { serverApi } from '@/lib/server-api';
import { CloseCockpitClient } from './close-cockpit-client';

export const dynamic = 'force-dynamic';

export default async function CloseCockpitPage() {
  const data = await serverApi<any>('/api/finance/metrics/close/status');
  return <CloseCockpitClient initialData={data} />;
}
