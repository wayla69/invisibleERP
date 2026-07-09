import { and, eq } from 'drizzle-orm';
import { featureFlags } from '../database/schema';
import { tenantALS } from './tenant-context';

// Per-tenant AI-processing opt-out (PDPA มาตรา 27/30 — disclosure + the data subject's right to object).
// Layered UNDER the platform DPA gate (`aiDpaBlocked()`, common/ai-models.ts):
//   • platform: no acknowledged Anthropic DPA in prod → AI hard-blocked (fail-closed, unchanged);
//   • tenant:   a feature-flag override `ai_external_processing = false` means THIS company's data must
//               not be transmitted to the external AI provider — AI surfaces degrade to their
//               deterministic path (template/keyword/rules), or raise `AI_TENANT_OPTED_OUT` where no
//               deterministic equivalent exists (the chat assistant).
// Default (no override row) = allowed; the disclosure text lives on the flag itself so the settings UI
// shows what "on" means before an admin toggles it (Settings › Labs & AI).
// The read is filtered by an EXPLICIT tenant_id (works for @NoTx system callers like the LINE webhook,
// where the tenant-aware proxy has no request transaction) and additionally RLS-scoped when a tenant tx
// is active. An infra error falls back to the default (allowed): opt-out is a tenant preference read on
// the hot path — the DPA gate stays the hard stop, and a flags-table blip must not take down every AI
// feature. `db` is typed loosely to avoid a common → database.module import cycle (tenant-run.ts does
// the same).
export const AI_CONSENT_FLAG = 'ai_external_processing';

export async function aiTenantOptedOut(db: any, tenantId?: number | null): Promise<boolean> {
  const tid = tenantId ?? tenantALS.getStore()?.tenantId;
  if (!db || tid == null) return false;
  try {
    const rows: Array<{ enabled: boolean }> = await db
      .select({ enabled: featureFlags.enabled })
      .from(featureFlags)
      .where(and(eq(featureFlags.tenantId, tid), eq(featureFlags.flagKey, AI_CONSENT_FLAG)))
      .limit(1);
    return rows.length > 0 && rows[0]!.enabled === false;
  } catch {
    return false;
  }
}
