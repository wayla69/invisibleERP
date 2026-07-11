// Server component shell (INV-3 / INV-17) — prefetches the ABC classification + the cadence-driven due
// worklist on the server (cookie-forwarded, see lib/server-api.ts) so the first paint carries them. All
// interactivity — recompute ABC, generate a BLIND count, enter physical counts — lives in the client island
// (cycle-counts-client.tsx). Posting the variance reuses the existing /stock-adjustment (wh_adjust) path.
import { serverApi } from '@/lib/server-api';
import CycleCountsClient from './cycle-counts-client';

export const dynamic = 'force-dynamic';

export default async function CycleCountsPage() {
  const [initialAbc, initialDue, initialTasks] = await Promise.all([
    serverApi<unknown>('/api/stock-ops/abc'),
    serverApi<unknown>('/api/stock-ops/cycle-counts/due'),
    serverApi<unknown>('/api/stock-ops/cycle-counts'),
  ]);
  return <CycleCountsClient initialAbc={initialAbc ?? undefined} initialDue={initialDue ?? undefined} initialTasks={initialTasks ?? undefined} />;
}
