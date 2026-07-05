// Treasury / Cash Command (docs/35 Phase 4). Read-only liquidity board: server-prefetch the cash-position
// aggregate (cookie-forwarded) and hand it to a client island for rendering + i18n.
import { serverApi } from '@/lib/server-api';
import { TreasuryClient } from './treasury-client';

export const dynamic = 'force-dynamic';

export default async function TreasuryPage() {
  const data = await serverApi<any>('/api/finance/metrics/cash/position');
  return <TreasuryClient initialData={data} />;
}
