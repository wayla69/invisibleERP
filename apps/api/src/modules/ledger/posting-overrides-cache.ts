// GL-24 posting-override resolution + its per-tenant cache (docs/43 PR-1; the resolution functions moved
// here from the ledger.service.ts facade in docs/46 Phase 4e cut 3 — beside the cache they wrap, their
// natural home; the PostingService class proper can't host them because LedgerService would then
// value-import posting.service.ts while PostingService DI-injects LedgerService — a require cycle needing
// forwardRef churn for zero benefit). One module-scoped TtlCache shared by the READ side
// (resolvePostingOverrides — hot POS/posting paths take ≤1 short-TTL cached lookup per event) and the
// WRITE side (PostingService approve/reject/deactivate bust the tenant's prefix so a just-approved rule
// applies on the next posting, not a TTL later). Keys MUST carry the tenant id (ttl-cache contract).
// The 5s TTL mirrors ModuleConfigService's guard cache — bust-on-write is the primary freshness mechanism,
// the TTL is the backstop.
import { eq, and, inArray } from 'drizzle-orm';
import { TtlCache } from '../../common/ttl-cache';
import type { DrizzleDb } from '../../database/database.module';
import { postingRules } from '../../database/schema';
import { currentTenantStore } from '../../common/tenant-context';
import { postingDefault } from './posting-events';

export const POSTING_OVERRIDES_TTL_MS = 5_000;

export const postingOverridesCache = new TtlCache(2000);

export const postingOverridesKey = (tenantId: number, eventType: string) => `povr:${tenantId}:${eventType}`;

export function bustPostingOverridesCache(tenantId: number | null | undefined): void {
  if (tenantId == null) return;
  postingOverridesCache.deletePrefix(`povr:${tenantId}:`);
}

// ───────────────────── Posting-rule account overrides (docs/42 step 4) ─────────────────────
// A tenant's ACTIVE posting_rules rows (event_type + role — maintained on /setup/posting-rules) re-map
// where a recurring system posting lands, per company, WITHOUT a code change. Only TENANT-scoped rows
// apply: the NULL-tenant rows seeded by 0158 are display defaults that pre-date the real posting paths
// (some drift from the literals — e.g. PAYROLL.GROSS's seed credits AP 2000 while payroll actually pays
// cash 1000), so they must never shadow the code. Callers keep their literal as the fallback: no
// override ⇒ byte-identical behaviour (parity). A typo'd override account is caught fail-closed by
// postEntry's account-universe guard (INVALID_POSTING_ACCOUNT), never posted.
export async function resolvePostingOverrides(db: DrizzleDb, eventType: string, tenantId?: number | null): Promise<Record<string, string>> {
  const tid = tenantId ?? currentTenantStore()?.tenantId ?? null;
  if (tid == null) return {};
  // GL-24 + hot-path cache (docs/43 PR-1): only ACTIVE + APPROVED rules apply; the per-tenant 5s
  // TtlCache (bust-on-approve in PostingService) keeps POS-frequency callers off the DB.
  return postingOverridesCache.wrap(postingOverridesKey(tid, eventType), POSTING_OVERRIDES_TTL_MS, async () => {
    const rows = await db
      .select({ role: postingRules.role, accountCode: postingRules.accountCode })
      .from(postingRules)
      .where(and(
        eq(postingRules.eventType, eventType),
        eq(postingRules.tenantId, tid),
        eq(postingRules.active, true),
        eq(postingRules.status, 'Approved'),
      ));
    const out: Record<string, string> = {};
    for (const r of rows) if (r.accountCode) out[r.role] = r.accountCode;
    return out;
  });
}

/** docs/43 PR-7: a reconciliation that reads a WIDENED role must sum the account SET
 *  {registry default} ∪ {approved tenant override} — so overriding the role never breaks the tie-out. */
export async function resolvePostingAccountSet(db: DrizzleDb, eventType: string, role: string, tenantId?: number | null): Promise<string[]> {
  const def = postingDefault(eventType, role);
  const ovr = (await resolvePostingOverrides(db, eventType, tenantId))[role];
  return ovr && ovr !== def ? [def, ovr] : [def];
}

// Batch resolve several events in one call (one query on cache miss) — a POS sale resolves its whole
// SALE/POS event set with a single lookup instead of N sequential awaits (docs/43 PR-1).
export async function resolvePostingOverridesMany(db: DrizzleDb, eventTypes: string[], tenantId?: number | null): Promise<Record<string, Record<string, string>>> {
  const tid = tenantId ?? currentTenantStore()?.tenantId ?? null;
  const out: Record<string, Record<string, string>> = {};
  for (const ev of eventTypes) out[ev] = {};
  if (tid == null || !eventTypes.length) return out;
  // serve whatever is cached; fetch the misses in ONE query
  const misses: string[] = [];
  for (const ev of eventTypes) {
    const hit = postingOverridesCache.get<Record<string, string>>(postingOverridesKey(tid, ev));
    if (hit !== undefined) out[ev] = hit; else misses.push(ev);
  }
  if (misses.length) {
    const rows = await db
      .select({ eventType: postingRules.eventType, role: postingRules.role, accountCode: postingRules.accountCode })
      .from(postingRules)
      .where(and(
        inArray(postingRules.eventType, misses),
        eq(postingRules.tenantId, tid),
        eq(postingRules.active, true),
        eq(postingRules.status, 'Approved'),
      ));
    for (const r of rows) if (r.accountCode) (out[r.eventType] ??= {})[r.role] = r.accountCode;
    for (const ev of misses) postingOverridesCache.set(postingOverridesKey(tid, ev), out[ev] ?? {}, POSTING_OVERRIDES_TTL_MS);
  }
  return out;
}
