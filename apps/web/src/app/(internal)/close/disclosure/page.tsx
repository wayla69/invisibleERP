// CLS-02 (GL-26) — Disclosure / close-package checklist (governed close binder). Server-shell: prefetch the
// tenant's checklists (cookie-forwarded) and hand them to a client island for rendering + i18n + workflow.
import { serverApi } from '@/lib/server-api';
import { DisclosureClient } from './disclosure-client';

export const dynamic = 'force-dynamic';

export default async function DisclosurePage() {
  const initial = await serverApi<any>('/api/close/disclosure').catch(() => ({ checklists: [], count: 0 }));
  return <DisclosureClient initialData={initial} />;
}
