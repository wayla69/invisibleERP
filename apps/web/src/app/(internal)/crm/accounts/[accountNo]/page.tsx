// CRM-2 — account (company) page server shell. Prefetches the composed account payload (header +
// contacts + deals + recent activities across its deals); rendering + interactivity in account-client.tsx.
// (The full finance-joined Customer-360 is CRM-3 — no AR joins here.)
import { serverApi } from '@/lib/server-api';
import AccountClient from './account-client';

export const dynamic = 'force-dynamic';

export default async function AccountPage({ params }: { params: Promise<{ accountNo: string }> }) {
  const accountNo = decodeURIComponent((await params).accountNo ?? '');
  const initial = await serverApi<unknown>(`/api/crm/accounts/${encodeURIComponent(accountNo)}`);
  return <AccountClient accountNo={accountNo} initial={initial ?? undefined} />;
}
