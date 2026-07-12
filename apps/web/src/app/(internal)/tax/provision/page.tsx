// Server component shell (TAX-11 — current income-tax provision + ETR reconciliation). Prefetches the
// provision register on the server (cookie-forwarded, lib/server-api.ts); the run form, the ETR schedule
// view and the maker-checker post mutation stay in the client island.
import { serverApi } from '@/lib/server-api';
import IncomeTaxProvisionWorkspace from './provision-client';

export const dynamic = 'force-dynamic';

export default async function IncomeTaxProvisionPage() {
  const initialList = await serverApi<unknown>('/api/tax/provision');
  return <IncomeTaxProvisionWorkspace initialList={initialList ?? undefined} />;
}
