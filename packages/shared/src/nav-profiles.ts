// SME industry-aware nav folding (docs/50 Track B — B1).
//
// A control_profile='sme' company is stamped at PROVISIONING with a per-industry navigation profile so a
// solo owner's first login shows only the ~15 sidebar items their business actually uses instead of the
// full ~210-item enterprise menu ("210 → ~15" launch UX). The profile is resolved ONCE from
// `tenants.industry` (the CoA template key chosen at signup) by `smeNavProfile()` and merged into the
// tenant's stamped `sme_prefs` copy by `tenant-provisioning.service.ts`:
//
//   - `hidden`  → unioned into `sme_prefs.hidden_nav_groups` (top-level nav GROUP title keys the sidebar
//                 removes entirely for this tenant; the ⌘K palette + favourites still reach them, and the
//                 platform owner can edit the list per tenant via POST /api/admin/tenants/:id/sme-prefs).
//   - `open`    → stored as `sme_prefs.open_nav_groups` (group/subgroup title keys that default OPEN in
//                 the sidebar; everything else starts folded). Surfaced to the web as
//                 `sme_open_nav_groups` on GET /api/auth/me; a user's own navFold toggle always wins.
//
// Enterprise tenants are untouched (no stamp, no /me fields, behaviour byte-identical).
//
// ⚠️ KEY SYNC: the string keys below are the group/subgroup `title` i18n keys of
// `apps/web/src/lib/nav.ts` (INTERNAL_NAV). That file cannot be imported here (it carries Lucide icon
// components), so the census below is a hand-maintained mirror — renaming/adding a nav group or moving
// items MUST update `SME_NAV_CENSUS` in the same change. `apps/api/test/nav-profiles.test.ts` guards the
// internal consistency (unknown keys, hidden∩open, per-industry visible-item budget); unknown keys are
// ignored gracefully by the web, so drift degrades folding rather than breaking navigation.

/** Industry keys — mirrors the CoA template keys (`apps/api/src/modules/ledger/coa-templates.ts`). */
export const SME_NAV_INDUSTRIES = ['restaurant', 'retail', 'distribution', 'services', 'general'] as const;
export type SmeNavIndustry = (typeof SME_NAV_INDUSTRIES)[number];

export interface SmeNavProfile {
  /** Top-level nav GROUP title keys removed from the sidebar for this industry (union with god defaults). */
  hidden: string[];
  /** Group/subgroup title keys that default OPEN; everything not listed starts folded. */
  open: string[];
}

/**
 * Census of the internal nav tree: every group/subgroup title key → its direct item count.
 * A group that only holds subgroups has `items: 0`; each subgroup carries `parent` (its group key).
 * Mirrors `apps/web/src/lib/nav.ts` INTERNAL_NAV — keep in sync (see header note).
 */
export const SME_NAV_CENSUS: Record<string, { items: number; parent?: string }> = {
  'nav.group.overview': { items: 2 },
  'nav.group.pos_sales': { items: 0 },
  'nav.sub.pos_frontline': { items: 6, parent: 'nav.group.pos_sales' },
  'nav.sub.pos_dining': { items: 6, parent: 'nav.group.pos_sales' },
  'nav.sub.pos_shift': { items: 4, parent: 'nav.group.pos_sales' },
  'nav.group.store_ops': { items: 0 },
  'nav.group.store': { items: 3, parent: 'nav.group.store_ops' },
  'nav.group.devices': { items: 3, parent: 'nav.group.store_ops' },
  'nav.group.restaurant': { items: 3, parent: 'nav.group.store_ops' },
  'nav.group.commercial': { items: 0 },
  'nav.group.crm': { items: 11, parent: 'nav.group.commercial' },
  'nav.group.loyalty': { items: 12, parent: 'nav.group.commercial' },
  'nav.group.pricing': { items: 2, parent: 'nav.group.commercial' },
  'nav.group.supply_chain': { items: 0 },
  'nav.group.inventory': { items: 18, parent: 'nav.group.supply_chain' },
  'nav.group.procurement': { items: 14, parent: 'nav.group.supply_chain' },
  'nav.group.production': { items: 7, parent: 'nav.group.supply_chain' },
  'nav.group.finance': { items: 0 },
  'nav.sub.ar_ap': { items: 7, parent: 'nav.group.finance' },
  'nav.sub.ledger': { items: 12, parent: 'nav.group.finance' },
  'nav.sub.banking': { items: 4, parent: 'nav.group.finance' },
  'nav.sub.fin_reports': { items: 7, parent: 'nav.group.finance' },
  'nav.sub.interco': { items: 2, parent: 'nav.group.finance' },
  'nav.group.tax': { items: 6, parent: 'nav.group.finance' },
  'nav.group.hr': { items: 13 },
  'nav.group.projects': { items: 0 },
  'nav.group.pm': { items: 10, parent: 'nav.group.projects' },
  'nav.group.realestate': { items: 1, parent: 'nav.group.projects' },
  'nav.group.planning': { items: 11 },
  'nav.group.controls': { items: 9 },
  'nav.group.ai': { items: 3 },
  'nav.group.settings': { items: 0 },
  'nav.sub.master_data': { items: 10, parent: 'nav.group.settings' },
  'nav.sub.customise': { items: 7, parent: 'nav.group.settings' },
  'nav.sub.integrations': { items: 7, parent: 'nav.group.settings' },
  'nav.sub.admin': { items: 6, parent: 'nav.group.settings' },
};

/**
 * Per-industry SME nav profiles. Design intent (docs/50 B1): the first login of a solo owner surfaces
 * the industry's daily-work items (target ~15 visible; guarded 8–25 by the unit test) with everything
 * else folded, and removes whole domains the industry clearly never uses (still reachable via ⌘K and
 * re-enableable per tenant by the platform owner). 'general' is the safe fallback: hides nothing and
 * keeps today's only-active-open behaviour.
 */
export const SME_NAV_PROFILES: Record<SmeNavIndustry, SmeNavProfile> = {
  restaurant: {
    hidden: ['nav.group.projects'],
    open: ['nav.group.overview', 'nav.group.pos_sales', 'nav.sub.pos_frontline', 'nav.sub.pos_dining'],
  },
  retail: {
    hidden: ['nav.group.projects'],
    open: ['nav.group.overview', 'nav.group.pos_sales', 'nav.sub.pos_frontline', 'nav.group.commercial', 'nav.group.pricing'],
  },
  distribution: {
    hidden: ['nav.group.pos_sales', 'nav.group.store_ops', 'nav.group.projects'],
    open: ['nav.group.overview', 'nav.group.supply_chain', 'nav.group.procurement'],
  },
  services: {
    hidden: ['nav.group.supply_chain', 'nav.group.store_ops'],
    open: ['nav.group.overview', 'nav.group.commercial', 'nav.group.crm', 'nav.group.projects'],
  },
  general: {
    hidden: [],
    open: ['nav.group.overview'],
  },
};

/** Resolve the SME nav profile for a tenant's industry; unknown/absent industries fall back to 'general'. */
export function smeNavProfile(industry: string | null | undefined): SmeNavProfile {
  const key = (SME_NAV_INDUSTRIES as readonly string[]).includes(industry ?? '') ? (industry as SmeNavIndustry) : 'general';
  return SME_NAV_PROFILES[key];
}

/**
 * Count of items visible on first load under a profile: items of every OPEN flat group, plus items of
 * every OPEN subgroup whose parent group is also open (a subgroup can't show inside a folded group).
 * Hidden groups contribute nothing regardless. Used by the unit test to hold the "~15 items" budget.
 */
export function smeNavVisibleItemCount(profile: SmeNavProfile): number {
  const open = new Set(profile.open);
  const hidden = new Set(profile.hidden);
  let n = 0;
  for (const [key, meta] of Object.entries(SME_NAV_CENSUS)) {
    if (meta.parent == null) {
      if (open.has(key) && !hidden.has(key)) n += meta.items;
    } else if (open.has(key) && open.has(meta.parent) && !hidden.has(meta.parent)) {
      n += meta.items;
    }
  }
  return n;
}

/** Total item count of the census (the "~210" denominator); used by the test as a drift sanity floor. */
export function smeNavCensusTotal(): number {
  return Object.values(SME_NAV_CENSUS).reduce((s, m) => s + m.items, 0);
}
