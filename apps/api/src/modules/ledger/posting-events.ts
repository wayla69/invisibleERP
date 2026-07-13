// ───────────────────────── Posting-event REGISTRY (docs/43 PR-1 — the single source of truth) ─────────────────────────
// Catalogue of every business event that posts to the GL, each leg's semantic ROLE, its REAL default
// account (the literal the posting site ships with — NOT the aspirational 0158 demo rows, some of which
// drift from the code), and the role's override TIER:
//
//   • 'free'   — a tenant posting-rule override applies (override ?? default), docs/43 Tier A.
//   • 'widen'  — overridable ONLY once the reconciliation that reads this account sums a widened account
//                SET (docs/43 Tier B; flipped per-role by PR-7). Until then upsert is rejected like pinned.
//   • 'pinned' — never overridable (sub-ledger control accounts, equity plugs, the cash set — docs/43
//                Tier C, incl. the five REC-04 accounts pinned PERMANENTLY per the §8 owner decision).
//
// INVARIANTS (boot-asserted from seedChartOfAccounts via assertPostingEventDefaults):
//   1. every role default exists in the canonical COA;
//   2. tiers are valid; no event declares zero roles.
// The posting_event_types seed migration is derived from this registry (0331); consuming services import
// their fallback literal from here so code and catalogue can never drift. Maintained ON /setup/posting-rules;
// governance (validation + maker-checker + audit) = control GL-24 in posting.service.ts.
//
// docs/46 Phase 5: the catalogue is COMPOSED from per-domain definition files (posting-events.<domain>.ts)
// so a new event is a one-domain-file change and merge conflicts stay local — this file remains the single
// exported POSTING_EVENTS and the only lookup API (postingRole / postingDefault / assertPostingEventDefaults).

export type { PostingSide, RoleTier, PostingRoleDef, PostingEventDef } from './posting-events.types';
import type { PostingEventDef, PostingRoleDef } from './posting-events.types';
import { SALES_POSTING_EVENTS } from './posting-events.sales';
import { SCM_POSTING_EVENTS } from './posting-events.scm';
import { PAYROLL_POSTING_EVENTS } from './posting-events.payroll';
import { ASSETS_POSTING_EVENTS } from './posting-events.assets';
import { LEASES_POSTING_EVENTS } from './posting-events.leases';
import { FINANCE_POSTING_EVENTS } from './posting-events.finance';
import { TREASURY_POSTING_EVENTS } from './posting-events.treasury';
import { REVENUE_POSTING_EVENTS } from './posting-events.revenue';
import { PROJECTS_POSTING_EVENTS } from './posting-events.projects';

export const POSTING_EVENTS: Record<string, PostingEventDef> = {
  ...SALES_POSTING_EVENTS,
  ...SCM_POSTING_EVENTS,
  ...PAYROLL_POSTING_EVENTS,
  ...ASSETS_POSTING_EVENTS,
  ...LEASES_POSTING_EVENTS,
  ...FINANCE_POSTING_EVENTS,
  ...TREASURY_POSTING_EVENTS,
  ...REVENUE_POSTING_EVENTS,
  ...PROJECTS_POSTING_EVENTS,
};

// ── Introspection helpers ──
export const POSTING_EVENT_KEYS = Object.keys(POSTING_EVENTS);

export function postingRole(eventType: string, role: string): PostingRoleDef | undefined {
  return POSTING_EVENTS[eventType]?.roles[role];
}

/** Boot fail-fast (called from seedChartOfAccounts, like assertTemplatesSubsetOf): every registry
 *  default must exist in the canonical COA and every event must declare at least one role. */
export function assertPostingEventDefaults(canonicalCodes: Iterable<string>): void {
  const canon = new Set(canonicalCodes);
  for (const [key, ev] of Object.entries(POSTING_EVENTS)) {
    const roles = Object.entries(ev.roles);
    if (!roles.length) throw new Error(`posting-events registry: event ${key} declares no roles`);
    for (const [role, def] of roles) {
      if (!canon.has(def.default)) {
        throw new Error(`posting-events registry: ${key}.${role} default account ${def.default} is not in the canonical COA`);
      }
    }
  }
}

/** The registry default for an event role — posting sites use `override ?? postingDefault(...)` so the
 *  literal can never drift from the catalogue (docs/43 PR-2+). Throws at module-eval time via the boot
 *  assert rather than here; an unknown pair is a programming error surfaced by tests. */
export function postingDefault(eventType: string, role: string): string {
  const def = POSTING_EVENTS[eventType]?.roles[role];
  if (!def) throw new Error(`posting-events registry: unknown ${eventType}.${role}`);
  return def.default;
}
