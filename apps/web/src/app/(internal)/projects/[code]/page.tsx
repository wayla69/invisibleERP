// Server component shell (docs/28 §4 / docs/27 R5-2 — RSC conversion #3).
// Prefetches the project detail + EVM headline on the server (cookie-forwarded, see lib/server-api.ts)
// and passes the route param down as a prop; the Gantt, EVM chart and every mutation stay in the client
// island (project-detail-client.tsx), unchanged.
import { serverApi } from '@/lib/server-api';
import ProjectDetailWorkspace from './project-detail-client';

export const dynamic = 'force-dynamic';

export default async function ProjectDetailPage({ params }: { params: Promise<{ code: string }> }) {
  const code = decodeURIComponent((await params).code ?? '');
  const [initialDetail, initialEvm] = await Promise.all([
    serverApi<unknown>(`/api/projects/${encodeURIComponent(code)}`),
    serverApi<unknown>(`/api/projects/${encodeURIComponent(code)}/evm`),
  ]);
  return <ProjectDetailWorkspace code={code} initialDetail={initialDetail ?? undefined} initialEvm={initialEvm ?? undefined} />;
}
