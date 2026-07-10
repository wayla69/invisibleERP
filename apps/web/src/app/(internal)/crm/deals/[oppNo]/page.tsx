// CRM-2 — deal detail server shell. Prefetches the composed deal payload (opportunity + account/contact +
// stage history + activities + linked CPQ quotes) on the server (cookie-forwarded); the stage stepper,
// unified timeline and quick-add activity live in the client island deal-client.tsx.
import { serverApi } from '@/lib/server-api';
import DealClient from './deal-client';

export const dynamic = 'force-dynamic';

export default async function DealPage({ params }: { params: Promise<{ oppNo: string }> }) {
  const oppNo = decodeURIComponent((await params).oppNo ?? '');
  const initial = await serverApi<unknown>(`/api/crm/pipeline/opportunities/${encodeURIComponent(oppNo)}`);
  return <DealClient oppNo={oppNo} initial={initial ?? undefined} />;
}
