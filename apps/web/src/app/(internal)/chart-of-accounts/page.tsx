// Server shell (docs/28 §4 RSC pattern — like accounting/page.tsx): prefetch the chart on the server
// (cookie-forwarded) so the first paint carries data; all interactivity — search, type filter, industry↔full
// toggle, CSV export — stays in the client island (chart-of-accounts-client.tsx). serverApi returns null on
// any failure, in which case the island's react-query simply fetches client-side as before.
import { serverApi } from '@/lib/server-api';
import { ChartOfAccountsClient } from './chart-of-accounts-client';

// cookies() (via serverApi) already opts this route out of prerendering; explicit for clarity.
export const dynamic = 'force-dynamic';

export default async function ChartOfAccountsPage() {
  const [canon, overlay] = await Promise.all([
    serverApi<any>('/api/ledger/accounts?all=true'),
    serverApi<any>('/api/ledger/accounts'),
  ]);
  return <ChartOfAccountsClient initialCanon={canon ?? undefined} initialOverlay={overlay ?? undefined} />;
}
