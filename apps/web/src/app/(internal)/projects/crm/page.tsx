// CRM-2 (docs/41): the PM-workspace leads & opportunities page merged into the unified CRM workspace.
// Server-side redirect keeps every old deep link working (`/projects/crm` → the /crm leads tab; the
// won-deal → project conversion lives on the deal page /crm/deals/[oppNo]).
import { redirect } from 'next/navigation';

export default function ProjectsCrmRedirect() {
  redirect('/crm?tab=leads');
}
