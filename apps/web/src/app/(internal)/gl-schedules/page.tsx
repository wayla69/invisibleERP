// Server shell (docs/28 §4 RSC pattern): the route is a server component; the interactive create forms
// (recurring template + prepaid schedule, dynamic lines) and "run due" actions live in the client island,
// which owns the fetching.
import { GlSchedulesClient } from './gl-schedules-client';

export const dynamic = 'force-dynamic';

export default function GlSchedulesPage() {
  return <GlSchedulesClient />;
}
