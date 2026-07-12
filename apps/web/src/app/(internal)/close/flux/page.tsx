// CLS-01 (GL-25) — Flux / variance analysis. Server shell: prefetch the tenant's analyses (cookie-forwarded)
// and hand them to the client island for generate + per-line explanation + maker-checker sign-off.
import { serverApi } from '@/lib/server-api';
import { FluxClient } from './flux-client';

export const dynamic = 'force-dynamic';

export default async function FluxPage() {
  const data = await serverApi<any>('/api/close/flux').catch(() => null);
  return <FluxClient initialList={data?.analyses ?? []} />;
}
