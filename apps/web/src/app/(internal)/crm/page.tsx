// CRM-2 — the modern CRM workspace (docs/41 module-depth uplift). Server shell: the interactivity
// (kanban DnD, tabs, dialogs, i18n t()) lives in the client island crm-client.tsx. Deep links:
// /crm?tab=board|leads|accounts|contacts (URL-synced tabs); the retail member CRM 360 moved to
// /crm/members; /pipeline and /projects/crm redirect here.
import CrmWorkspaceClient from './crm-client';

export default function CrmWorkspacePage() {
  return <CrmWorkspaceClient />;
}
