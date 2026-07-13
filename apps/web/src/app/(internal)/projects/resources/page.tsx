// Server component shell (PPM-A1, PROJ-20) — prefetches the time-phased capacity heatmap + named skills +
// availability calendar + role/skill supply-vs-demand on the server (cookie-forwarded, see lib/server-api.ts)
// so the first paint carries them. All interactivity — tag a skill, set a calendar override — lives in the
// client island (resources-client.tsx).
import { serverApi } from '@/lib/server-api';
import ResourcesClient from './resources-client';

export const dynamic = 'force-dynamic';

export default async function ProjectResourcesPage() {
  const [initialCapacity, initialSkills, initialCalendar, initialRoleDemand] = await Promise.all([
    serverApi<unknown>('/api/projects/resources/capacity?months=6'),
    serverApi<unknown>('/api/projects/resources/skills'),
    serverApi<unknown>('/api/projects/resources/calendar'),
    serverApi<unknown>('/api/projects/resources/role-demand?months=6'),
  ]);
  return (
    <ResourcesClient
      initialCapacity={initialCapacity ?? undefined}
      initialSkills={initialSkills ?? undefined}
      initialCalendar={initialCalendar ?? undefined}
      initialRoleDemand={initialRoleDemand ?? undefined}
    />
  );
}
