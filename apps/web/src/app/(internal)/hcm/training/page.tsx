// Server component shell (HR-7, docs/42 Wave 3) — prefetches the course catalogue on the server (cookie-
// forwarded, see lib/server-api.ts) so the first paint carries the courses. All interactivity — tabs, create
// forms, the HR-07 completion → certification mint, and the certification-compliance read — lives in the
// client island (training-client.tsx).
import { serverApi } from '@/lib/server-api';
import TrainingClient from './training-client';

export const dynamic = 'force-dynamic';

export default async function HcmTrainingPage() {
  const initialCourses = await serverApi<unknown>('/api/hcm/training/courses');
  return <TrainingClient initialCourses={initialCourses ?? undefined} />;
}
