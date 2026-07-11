// QMS-2 server-shell (CAPA register) — prefetches the CAPA list on the server (cookie-forwarded, see
// lib/server-api.ts) so the first paint carries the register. All interactivity — tabs, create form, the
// action checklist, and the QC-02 effectiveness maker-checker — lives in the client island.
import { serverApi } from '@/lib/server-api';
import CapaClient from './capa-client';

export const dynamic = 'force-dynamic';

export default async function CapaPage() {
  const initialCapas = await serverApi<unknown>('/api/quality/capa');
  return <CapaClient initialCapas={initialCapas ?? undefined} />;
}
