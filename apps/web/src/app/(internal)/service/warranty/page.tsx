// SVC-2 server-shell (Warranty & Entitlement registry) — prefetches the warranty-term catalogue on the
// server (cookie-forwarded, see lib/server-api.ts) so the first paint carries the terms. All interactivity —
// tabs, create forms, and the SVC-01 coverage-authorization maker-checker — lives in the client island.
import { serverApi } from '@/lib/server-api';
import WarrantyClient from './warranty-client';

export const dynamic = 'force-dynamic';

export default async function WarrantyPage() {
  const initialTerms = await serverApi<unknown>('/api/service/warranty/terms');
  return <WarrantyClient initialTerms={initialTerms ?? undefined} />;
}
