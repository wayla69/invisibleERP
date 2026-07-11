// Server component shell (HR-5, docs/42) — prefetches the lifecycle templates on the server
// (cookie-forwarded, see lib/server-api.ts) so the first paint carries them. All interactivity — tabs,
// template/task create forms, start/patch/complete of a per-employee checklist, and the HR-05
// access-revocation-completeness gate — lives in the client island (onboarding-client.tsx).
import { serverApi } from '@/lib/server-api';
import OnboardingClient from './onboarding-client';

export const dynamic = 'force-dynamic';

export default async function HcmOnboardingPage() {
  const initialTemplates = await serverApi<unknown>('/api/hcm/lifecycle/templates');
  return <OnboardingClient initialTemplates={initialTemplates ?? undefined} />;
}
