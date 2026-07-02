// Server component shell (docs/28 §4 / docs/27 R5-2 — RSC conversion #1).
// Prefetches the default tab's trial balance on the server (cookie-forwarded, see lib/server-api.ts) so
// the first paint carries data instead of a client fetch waterfall. All interactivity — tabs, JE forms,
// maker-checker actions, date filters — stays in the client island (accounting-client.tsx), unchanged.
import { serverApi } from '@/lib/server-api';
import AccountingWorkspace from './accounting-client';

// cookies() already opts this route out of prerendering; explicit for clarity.
export const dynamic = 'force-dynamic';

export default async function AccountingPage() {
  const initialTb = await serverApi<unknown>('/api/ledger/trial-balance');
  return <AccountingWorkspace initialTb={initialTb ?? undefined} />;
}
