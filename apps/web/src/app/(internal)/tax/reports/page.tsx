// Server component shell (docs/28 §4 / docs/27 R5-2 — RSC conversion #4, "reports").
// Prefetches the default tab's output-VAT view for the default period on the server (cookie-forwarded,
// lib/server-api.ts); the period picker, the other statutory tabs (input VAT, ภ.พ.30, filings calendar)
// and the filing mutations stay in the client island, unchanged.
import { serverApi } from '@/lib/server-api';
import TaxReportsWorkspace from './tax-reports-client';

export const dynamic = 'force-dynamic';

export default async function TaxReportsPage() {
  // Must match the island's initial period state (month=6, year=2026) so the prefetch lands on the
  // initial queryKey; any period change fetches fresh client-side as before.
  const initialOutputVat = await serverApi<unknown>('/api/tax-reports/output-vat?month=6&year=2026');
  return <TaxReportsWorkspace initialOutputVat={initialOutputVat ?? undefined} />;
}
