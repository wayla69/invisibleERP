// CRM-2 (docs/41): the standalone stage-board page merged into the unified CRM workspace. Server-side
// redirect keeps every old deep link working (`/pipeline` → the /crm kanban board).
import { redirect } from 'next/navigation';

export default function PipelineRedirect() {
  redirect('/crm');
}
