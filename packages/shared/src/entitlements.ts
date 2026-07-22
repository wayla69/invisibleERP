// ── SaaS packaging / plan entitlements (Wave 1 · workstream 1.1) ─────────────────────────────────
// Maps the LIVE gating currency — the coarse module permission tokens (`MODULE_KEYS`, i.e. PERMISSIONS
// minus the single-duty SUB_PERMISSIONS) — into sellable SUITES, then maps subscription plans to the
// suites they include. This is the data layer that `PlanGuard` (workstream 1.2) will enforce so a
// tenant's plan actually gates which modules they can reach.
//
// IMPORTANT — scope of this file:
//   • It is a PURE map + helpers. It changes NO runtime behaviour on its own; nothing enforces it until
//     PlanGuard is rewired in 1.2. It is safe to review/tune the tier assignments here first.
//   • The gating unit is the ~42 permission tokens, NOT the 123 backend module directories. Several
//     sellable capabilities (Manufacturing/MRP, PPM, HCM/Payroll) have NO distinct coarse token today
//     and therefore cannot be suite-gated yet — see KNOWN_UNGATED below (follow-up 1.1b adds tokens).
//   • A plan row's `features.suites` JSONB (set in the DB by 1.3) OVERRIDES the static PLAN_SUITES
//     default below when present; keep this map as the code-default / source of truth for seeding.

import { MODULE_KEYS, type Permission } from './permissions.js';

// The sellable suites. Keyed at the permission-token level so guards can enforce them directly.
export type SuiteKey =
  | 'core'
  | 'finance'
  | 'sales'
  | 'pos_frontoffice' // docs/53 C1 — the register/till surface split out of `sales` for the POS line
  | 'inventory'
  | 'procurement'
  | 'masterdata'
  | 'planning'
  | 'marketing' // split out of `planning` (2026-07-21) so each is sellable per-module as an add-on
  | 'crm_loyalty'
  | 'ai'
  | 'multibranch'
  | 'portal'
  | 'selfservice'
  // ── Premium/add-on suites (1.1b). These have NO coarse module token of their own — their modules ride on
  //    generic tokens (exec/planner/bom_master/…) — so they are gated by the class-level @RequiresSuite
  //    decorator on their controllers rather than by an @Permissions token. Sold as Enterprise/add-on packs. ──
  | 'manufacturing'
  | 'projects'
  | 'hcm'
  | 'realestate'
  // ── À-la-carte ADD-ON suites (the /plans configurator's "Advanced add-ons"). Token-less: their
  //    surfaces ride on generic tokens (procurement/marketing/users), so they are gated by
  //    @RequiresSuite on the specific controllers/handlers. Granted either by the plan (see the
  //    grandfathering in PLAN_SUITES) or per-tenant via subscriptions.addons (resolveEntitledSuites). ──
  | 'scm_advanced' // Advanced Supply Chain & Procurement Routing (RFQ, three-way match)
  | 'integrations' // Inbound Webhook for Chat/CRM integration (web-to-lead, email inbound)
  | 'cdp' // Ad-network Audience Export (CDP sync)
  | 'sandbox'; // Dedicated Sandbox/Staging (developer portal, key tiers)

// suite → the coarse module permission tokens it unlocks. EVERY MODULE_KEY must appear in exactly one
// suite (asserted by validateEntitlements()). Sub-permissions are NOT listed here — they are inherited
// via PERMISSION_IMPLICATIONS or granted directly to SoD-clean roles, and are gated by @Permissions,
// not by suite entitlement.
export const SUITES: Record<SuiteKey, Permission[]> = {
  // Base capabilities every tenant keeps regardless of plan (ALWAYS_ON). Never gated.
  core: ['users', 'dashboard', 'approvals', 'mobile', 'images', 'track'],
  // Finance / GL / AR / AP ('exec' implies gl_post/gl_close/recon_prep/fin_report). Treasury (debt/EIR,
  // hedge, investments, pooling — TRE-01..05) is finance depth; its checker duty (treasury_approve) is a
  // sub-permission, not suite-gated.
  finance: ['ar', 'creditors', 'exec', 'treasury'],
  // Order-to-cash back office (docs/53 C1 split — the ERP line's sales surface, register-less).
  // The POS front-of-house tokens moved to `pos_frontoffice` so a POS-only SKU can exist; every plan
  // that carried the old combined `sales` suite lists BOTH suites (breadth unchanged for bundles).
  sales: ['order_mgt', 'claim_mgt', 'crm'],
  // POS front of house (docs/53 C1): the register + everything a till operator touches. Sold per branch
  // on the POS line; bundled beside `sales` everywhere the old combined suite appeared.
  pos_frontoffice: ['pos', 'delivery', 'returns', 'pricelist', 'promos'],
  // Warehouse / inventory.
  inventory: ['warehouse', 'lots', 'locations'],
  // Procurement (PR/PO). pr_raise is the low-risk company-wide requisition step.
  procurement: ['procurement', 'pr_raise'],
  // Master data & BoM master.
  masterdata: ['masterdata', 'bom_master'],
  // Supply-chain planning / forecasting (split 2026-07-21: `marketing` moved to its own sellable suite —
  // every plan that carried the combined suite lists BOTH, so bundle breadth is unchanged/grandfathered).
  // docs/54 demand planning (`scm_plan`) belongs here — same buyer as `planner`; its checker duty
  // (scm_approve) is a sub-permission, not gated.
  planning: ['planner', 'scm_plan'],
  // Marketing & campaigns (own suite so it can be sold per-module as an add-on).
  marketing: ['marketing'],
  // CRM loyalty / surveys (loyalty back-office single-duties are granted directly, not suite-gated).
  crm_loyalty: ['loyalty', 'survey'],
  // AI copilot / chat (also token-metered separately).
  ai: ['ai_chat'],
  // Multi-branch consolidation.
  multibranch: ['branch'],
  // Customer self-service portal.
  portal: [
    'order_cust', 'cust_dash', 'cust_inventory', 'cust_pos', 'cust_bom', 'cust_variance',
    'cust_my_crm', 'cust_my_suppliers', 'cust_my_pos', 'cust_my_users',
  ],
  // Employee & vendor self-service portals.
  selfservice: ['ess', 'vendor_portal'],
  // ── Premium suites (1.1b) — primarily gated via @RequiresSuite on their controllers. Coarse tokens
  //    added AFTER the 1.1 map (QMS `quality`, HCM-depth `hr`/`hr_admin`) are owned here so the token
  //    path agrees with the decorator path; the *_approve checker duties are sub-permissions. ──
  manufacturing: ['quality'],
  projects: [],
  hcm: ['hr', 'hr_admin'],
  realestate: [],
  // Add-on suites own no token (their endpoints keep their @Permissions RBAC; the suite is the
  // commercial gate layered on top via @RequiresSuite).
  scm_advanced: [],
  integrations: [],
  cdp: [],
  sandbox: [],
};

// Suites that own no module token and are therefore gated exclusively by the @RequiresSuite decorator.
export const TOKENLESS_SUITES: SuiteKey[] = ['projects', 'realestate', 'scm_advanced', 'integrations', 'cdp', 'sandbox'];

// All suite keys (handy for validating @RequiresSuite arguments).
export const SUITE_KEYS = Object.keys(SUITES) as SuiteKey[];

// Suites that are always granted regardless of plan (mirrors ALWAYS_ON_MODULES). Never gated.
export const ALWAYS_ON_SUITES: SuiteKey[] = ['core'];

// Human-readable suite labels (TH/EN) for the pricing/packaging UI.
export const SUITE_LABELS: Record<SuiteKey, { en: string; th: string }> = {
  core: { en: 'Core', th: 'พื้นฐาน' },
  finance: { en: 'Finance & Accounting', th: 'บัญชีการเงิน' },
  sales: { en: 'Sales & Order Management', th: 'ขาย & จัดการออเดอร์' },
  pos_frontoffice: { en: 'POS Front of House', th: 'POS หน้าร้าน' },
  inventory: { en: 'Inventory & Warehouse', th: 'คลังสินค้า' },
  procurement: { en: 'Procurement', th: 'จัดซื้อ' },
  masterdata: { en: 'Master Data', th: 'ข้อมูลหลัก' },
  planning: { en: 'Planning & Forecasting', th: 'วางแผน & พยากรณ์' },
  marketing: { en: 'Marketing & Campaigns', th: 'การตลาด & แคมเปญ' },
  crm_loyalty: { en: 'CRM & Loyalty', th: 'CRM & สมาชิก' },
  ai: { en: 'AI Copilot', th: 'ผู้ช่วย AI' },
  multibranch: { en: 'Multi-branch', th: 'หลายสาขา' },
  portal: { en: 'Customer Portal', th: 'พอร์ทัลลูกค้า' },
  selfservice: { en: 'Self-service Portals', th: 'พอร์ทัลพนักงาน/ผู้ขาย' },
  manufacturing: { en: 'Manufacturing / MRP', th: 'การผลิต / MRP' },
  projects: { en: 'Projects / PPM', th: 'บริหารโครงการ' },
  hcm: { en: 'HCM & Payroll', th: 'บุคคล & เงินเดือน' },
  realestate: { en: 'Real Estate (Developer)', th: 'อสังหาริมทรัพย์' },
  scm_advanced: { en: 'Advanced Supply Chain & Procurement Routing', th: 'ซัพพลายเชน & เส้นทางอนุมัติจัดซื้อขั้นสูง' },
  integrations: { en: 'Inbound Webhook (Chat/CRM)', th: 'Webhook ขาเข้า (แชต/CRM)' },
  cdp: { en: 'Audience Export (CDP Sync)', th: 'ส่งออกกลุ่มเป้าหมายโฆษณา (CDP)' },
  sandbox: { en: 'Dedicated Sandbox/Staging', th: 'สภาพแวดล้อมทดสอบเฉพาะราย' },
};

// plan code → suites included. DEFAULT map (a plan row's features.suites JSONB overrides at runtime).
// Keyed by the CURRENTLY SEEDED plan codes (free/starter/pro/enterprise); workstream 1.3 renames the
// commercial tiers to Standard/Professional/Enterprise and can re-map here + in the DB seed.
export const PLAN_SUITES: Record<string, SuiteKey[]> = {
  // Free / trial-limited: base + customer/self-service only.
  free: ['core', 'portal', 'selfservice'],
  // SME (single-operator edition, docs/49): the full day-to-day operational ERP so one owner can run the
  // whole business from one place — finance, sales, inventory, procurement, planning, CRM/loyalty, AI — but
  // NOT the heavy enterprise verticals (manufacturing/projects/hcm/realestate) and single-location only
  // (features.users/locations cap the seats). The self-approval maker-checker relaxation is orthogonal
  // (control_profile='sme'), not a suite. Upgrading to Enterprise adds the verticals + multi-seat.
  sme: [
    'core', 'finance', 'sales', 'pos_frontoffice', 'inventory', 'masterdata', 'portal', 'selfservice',
    'procurement', 'planning', 'marketing', 'crm_loyalty', 'ai',
  ],
  // Standard (current 'starter'): finance-first core. docs/53 Q1 — BASE procurement (PR→PO→blind-count
  // GRN, the F&B/retail receiving-controls story) is included from Standard up; the ADVANCED routing
  // (RFQ / three-way match) stays behind the scm_advanced add-on / Business+.
  starter: ['core', 'finance', 'sales', 'pos_frontoffice', 'inventory', 'masterdata', 'portal', 'selfservice', 'procurement'],
  // Business (mid-tier, 1.9): Standard + procurement + multi-branch. Closes the 5× price jump between
  // Standard and Professional; planning/loyalty/AI stay the Professional differentiators.
  // scm_advanced is GRANDFATHERED: RFQ/three-way match were reachable via the 'procurement' token
  // before the add-on suite existed, so plans that had procurement keep them.
  business: [
    'core', 'finance', 'sales', 'pos_frontoffice', 'inventory', 'masterdata', 'portal', 'selfservice',
    'procurement', 'multibranch', 'scm_advanced',
  ],
  // Professional (current 'pro'): adds procurement, planning, loyalty, AI, multi-branch.
  // cdp/integrations GRANDFATHERED: audience export rode the 'marketing' token (planning suite) and
  // web-to-lead was un-gated, so the plan that had planning keeps both.
  pro: [
    'core', 'finance', 'sales', 'pos_frontoffice', 'inventory', 'masterdata', 'portal', 'selfservice',
    'procurement', 'planning', 'marketing', 'crm_loyalty', 'ai', 'multibranch',
    'scm_advanced', 'integrations', 'cdp',
  ],
  // Franchise (multi-brand, between Professional and Enterprise — the /plans configurator's 4th pack):
  // Professional + the central-kitchen/ops verticals (manufacturing, projects) + every add-on suite.
  franchise: [
    'core', 'finance', 'sales', 'pos_frontoffice', 'inventory', 'masterdata', 'portal', 'selfservice',
    'procurement', 'planning', 'marketing', 'crm_loyalty', 'ai', 'multibranch',
    'manufacturing', 'projects',
    'scm_advanced', 'integrations', 'cdp', 'sandbox',
  ],
  // Enterprise: everything, incl. the premium/add-on suites (custom deals tune via features.suites).
  enterprise: [
    'core', 'finance', 'sales', 'pos_frontoffice', 'inventory', 'masterdata', 'portal', 'selfservice',
    'procurement', 'planning', 'marketing', 'crm_loyalty', 'ai', 'multibranch',
    'manufacturing', 'projects', 'hcm', 'realestate',
    'scm_advanced', 'integrations', 'cdp', 'sandbox',
  ],
  // ── Product lines (docs/53 C1, ADDITIVE codes) — split-sell entry SKUs beside the Complete bundles.
  //    POS line is priced PER BRANCH (features.per_branch); ERP line is flat per company. Upgrading any
  //    line SKU to a bundle is a plan change (entitlement flip) on the same tenant — never a migration. ──
  // POS Lite: counter/quick-service register only. Master data included (a register needs its items).
  pos_lite: ['core', 'pos_frontoffice', 'masterdata'],
  // POS Pro: full front of house — + inventory (recipes/stock depletion), customer-facing portal (QR
  // ordering), delivery channels ride pos_frontoffice.
  pos_pro: ['core', 'pos_frontoffice', 'masterdata', 'inventory', 'portal'],
  // ERP Essentials: register-less back office — finance + order-to-cash + inventory.
  erp_essentials: ['core', 'finance', 'sales', 'inventory', 'masterdata', 'selfservice'],
  // ERP Growth: + base procurement + planning + multi-branch consolidation (3 locations).
  erp_growth: ['core', 'finance', 'sales', 'inventory', 'masterdata', 'selfservice', 'procurement', 'planning', 'marketing', 'multibranch'],
};

// ── À-la-carte add-ons (the /plans configurator) ────────────────────────────────────────────────
// An add-on is a sellable suite purchasable per tenant on top of any plan (stored on
// subscriptions.addons; resolveEntitledSuites unions them in). Two families:
//   • the original token-less add-on suites (scm_advanced/integrations/cdp/sandbox), and
//   • per-MODULE add-ons (2026-07-21): planning / marketing / crm_loyalty / ai — full token-bearing
//     suites previously only reachable by upgrading to Professional. Priced so the sum of the module
//     add-ons (1,900+1,290+1,490+1,990 = ฿6,670) exceeds the Business→Professional step (฿5,000):
//     buying 1–2 modules is cheaper than upgrading; wanting 3+ makes the bundle the better deal.
// Prices are indicative THB, annual = 10 × monthly like every seeded plan.
export type AddonKey = 'scm_advanced' | 'integrations' | 'cdp' | 'sandbox' | 'planning' | 'marketing' | 'crm_loyalty' | 'ai';
export const ADDON_KEYS: AddonKey[] = ['scm_advanced', 'integrations', 'cdp', 'sandbox', 'planning', 'marketing', 'crm_loyalty', 'ai'];
export const ADDONS: Record<AddonKey, { priceMonthly: number; labels: { en: string; th: string } }> = {
  scm_advanced: { priceMonthly: 1500, labels: SUITE_LABELS.scm_advanced },
  integrations: { priceMonthly: 990, labels: SUITE_LABELS.integrations },
  cdp: { priceMonthly: 1290, labels: SUITE_LABELS.cdp },
  sandbox: { priceMonthly: 2900, labels: SUITE_LABELS.sandbox },
  planning: { priceMonthly: 1900, labels: SUITE_LABELS.planning },
  marketing: { priceMonthly: 1290, labels: SUITE_LABELS.marketing },
  crm_loyalty: { priceMonthly: 1490, labels: SUITE_LABELS.crm_loyalty },
  ai: { priceMonthly: 1990, labels: SUITE_LABELS.ai }, // carries its own token band — see AI_ADDON_FEATURES
};
export const isAddonKey = (x: unknown): x is AddonKey => typeof x === 'string' && (ADDON_KEYS as string[]).includes(x);

// What a purchased add-on actually GRANTS. Mostly just its own suite, but an add-on whose surfaces sit
// behind another module token must carry that base suite too, or buying it on a plan without the token
// would grant nothing: scm_advanced's RFQ/three-way-match endpoints are @Permissions('procurement'),
// so the add-on includes the procurement suite (you cannot route procurement without procurement). The
// cdp endpoints pass via their 'exec' alternate token (finance, in every paid plan); integrations is
// enforced in-service against the 'integrations' suite alone; sandbox rides the always-on 'users' token.
// The per-module add-ons grant exactly their own token-bearing suite.
export const ADDON_GRANTS: Record<AddonKey, SuiteKey[]> = {
  scm_advanced: ['scm_advanced', 'procurement'],
  integrations: ['integrations'],
  cdp: ['cdp'],
  sandbox: ['sandbox'],
  planning: ['planning'],
  marketing: ['marketing'],
  crm_loyalty: ['crm_loyalty'],
  ai: ['ai'],
};

// ── AI add-on token band ────────────────────────────────────────────────────────────────────────
// AI is not just a route gate — it has real upstream token COGS, so the plan features carry a metered
// band (ai_tokens_daily / _max / overage rate) that is 0 on non-AI plans. A purchased `ai` add-on must
// therefore ALSO confer a band, or the buyer would be entitled to the routes and blocked at the first
// token. Solo-tier band at ฿1,990/mo: 100k tokens/day included, hard ceiling 200k, overage ฿12/1k —
// same economics as the `sme` plan (docs/ops/pricing-and-ai-cogs.md); heavier use is what Professional
// (200k/500k) is for. applyAiAddonFeatures overlays these onto the plan's features wherever AI limits
// are read (PlanGuard feature check, agent budget gate, billing usage view).
export const AI_ADDON_FEATURES = { ai_chat: true, ai_tokens_daily: 100_000, ai_tokens_daily_max: 200_000, ai_overage_rate_thb_per_1k: 12 } as const;

/** Overlay the AI add-on's feature band onto a plan's features. No-op unless `addons` includes 'ai'.
 *  Numeric limits merge as MAX (an add-on can only widen), preserving a legacy -1 "unlimited"; the
 *  overage rate applies only when the plan itself prices none. Returns a NEW object; input untouched. */
export function applyAiAddonFeatures(features: Record<string, unknown> | null | undefined, addons?: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(features ?? {}) };
  if (!Array.isArray(addons) || !addons.includes('ai')) return base;
  const widen = (key: 'ai_tokens_daily' | 'ai_tokens_daily_max') => {
    const cur = Number(base[key] ?? 0);
    base[key] = cur === -1 ? -1 : Math.max(Number.isFinite(cur) ? cur : 0, AI_ADDON_FEATURES[key]);
  };
  base.ai_chat = true;
  widen('ai_tokens_daily');
  widen('ai_tokens_daily_max');
  if (!(Number(base.ai_overage_rate_thb_per_1k ?? 0) > 0)) base.ai_overage_rate_thb_per_1k = AI_ADDON_FEATURES.ai_overage_rate_thb_per_1k;
  return base;
}

// Marketing pack id (the /plans configurator tiers) → seeded plan code. The signup request stores the
// REAL plan code so the approve flow can provision it directly.
export const PACK_TO_PLAN: Record<string, string> = {
  essential: 'starter',
  growth: 'business',
  scale: 'pro',
  franchise: 'franchise',
  enterprise: 'enterprise',
};

// (Resolved in 1.1b) Manufacturing/PPM/HCM/Real-estate had no coarse token; they are now sold as the
// token-less premium suites above, gated by the @RequiresSuite decorator on their controllers. Empty now —
// kept as the machine-visible "nothing left ungated" marker.
export const KNOWN_UNGATED: string[] = [];

// Reverse index: permission token → the suite that owns it (built once).
const PERMISSION_TO_SUITE: Partial<Record<Permission, SuiteKey>> = (() => {
  const idx: Partial<Record<Permission, SuiteKey>> = {};
  for (const suite of Object.keys(SUITES) as SuiteKey[]) {
    for (const perm of SUITES[suite]) idx[perm] = suite;
  }
  return idx;
})();

/** The suite that owns a given module permission token (undefined for sub-permissions / unmapped). */
export function suiteForPermission(perm: Permission): SuiteKey | undefined {
  return PERMISSION_TO_SUITE[perm];
}

/** All coarse module permission tokens unlocked by a set of suites (ALWAYS_ON suites always included). */
export function permissionsForSuites(suites: readonly SuiteKey[]): Permission[] {
  const active = new Set<SuiteKey>([...ALWAYS_ON_SUITES, ...suites]);
  const out = new Set<Permission>();
  for (const s of active) for (const p of SUITES[s]) out.add(p);
  return [...out];
}

/** Convenience: the module tokens a plan code unlocks by the DEFAULT map (ignores DB features.suites). */
export function permissionsForPlan(planCode: string): Permission[] {
  const suites = PLAN_SUITES[planCode] ?? ALWAYS_ON_SUITES;
  return permissionsForSuites(suites);
}

/**
 * Is a module permission token entitled given the tenant's active suites?
 * A sub-permission or any token NOT owned by a suite (i.e. not in the packaging model) is treated as
 * ENTITLED (true) — suite gating only governs the mapped module tokens; access to sub-permissions is
 * still governed by @Permissions/RBAC. ALWAYS_ON suites are always entitled.
 */
export function isPermissionEntitled(entitledSuites: readonly SuiteKey[], perm: Permission): boolean {
  const owner = PERMISSION_TO_SUITE[perm];
  if (!owner) return true; // not part of the packaging model → not suite-gated
  if (ALWAYS_ON_SUITES.includes(owner)) return true;
  return entitledSuites.includes(owner);
}

/**
 * Resolve the suites a tenant is entitled to, given their plan code and the plan row's `features.suites`
 * JSONB (if any). Precedence: (1) a valid non-empty `features.suites` array (per-plan/DB override, set by
 * 1.3), else (2) the static PLAN_SUITES default for the plan code (this is the in-code GRANDFATHER — a
 * legacy plan row without `suites` still resolves to sensible defaults), else (3) ALWAYS_ON only.
 * ALWAYS_ON suites are always included.
 */
export function resolveEntitledSuites(planCode: string | null | undefined, featuresSuites?: unknown, addons?: unknown): SuiteKey[] {
  const valid: SuiteKey[] = Array.isArray(featuresSuites)
    ? (featuresSuites.filter((s) => typeof s === 'string' && (s as string) in SUITES) as SuiteKey[])
    : [];
  const base = valid.length ? valid : (planCode && PLAN_SUITES[planCode]) || ALWAYS_ON_SUITES;
  // Per-tenant purchased add-ons (subscriptions.addons JSONB) union in on top of whatever the plan
  // grants — each add-on expands to its ADDON_GRANTS set (its own suite + any base suite its surfaces need).
  const extra: SuiteKey[] = Array.isArray(addons) ? addons.filter(isAddonKey).flatMap((a) => ADDON_GRANTS[a]) : [];
  return [...new Set<SuiteKey>([...ALWAYS_ON_SUITES, ...base, ...extra])];
}

/**
 * Invariant check (used by tools/ci/check-entitlements.mjs): every MODULE_KEY maps to EXACTLY ONE suite,
 * no suite lists a non-module (sub-permission) token, and every PLAN_SUITES entry references real suites.
 * Throws with a precise message on any violation so CI fails loudly. Returns a coverage summary.
 */
export function validateEntitlements(): { modules: number; suites: number; plans: number } {
  const moduleKeys = new Set<Permission>(MODULE_KEYS);

  // 1. Every module key is mapped exactly once.
  const seen = new Map<Permission, SuiteKey>();
  for (const suite of Object.keys(SUITES) as SuiteKey[]) {
    for (const perm of SUITES[suite]) {
      if (!moduleKeys.has(perm)) {
        throw new Error(`entitlements: suite '${suite}' lists '${perm}', which is not a MODULE_KEY (sub-permission or unknown).`);
      }
      const prior = seen.get(perm);
      if (prior) {
        throw new Error(`entitlements: '${perm}' is mapped to both '${prior}' and '${suite}' (must be exactly one).`);
      }
      seen.set(perm, suite);
    }
  }
  // 2. No module key left unmapped.
  const missing = [...moduleKeys].filter((k) => !seen.has(k));
  if (missing.length) {
    throw new Error(`entitlements: ${missing.length} MODULE_KEY(s) not assigned to any suite: ${missing.join(', ')}`);
  }
  // 3. PLAN_SUITES references only real suites.
  const suiteKeys = new Set(Object.keys(SUITES) as SuiteKey[]);
  for (const [plan, suites] of Object.entries(PLAN_SUITES)) {
    for (const s of suites) {
      if (!suiteKeys.has(s)) throw new Error(`entitlements: plan '${plan}' references unknown suite '${s}'.`);
    }
  }
  return { modules: moduleKeys.size, suites: suiteKeys.size, plans: Object.keys(PLAN_SUITES).length };
}
