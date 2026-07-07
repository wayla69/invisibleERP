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
  | 'inventory'
  | 'procurement'
  | 'masterdata'
  | 'planning'
  | 'crm_loyalty'
  | 'ai'
  | 'multibranch'
  | 'portal'
  | 'selfservice';

// suite → the coarse module permission tokens it unlocks. EVERY MODULE_KEY must appear in exactly one
// suite (asserted by validateEntitlements()). Sub-permissions are NOT listed here — they are inherited
// via PERMISSION_IMPLICATIONS or granted directly to SoD-clean roles, and are gated by @Permissions,
// not by suite entitlement.
export const SUITES: Record<SuiteKey, Permission[]> = {
  // Base capabilities every tenant keeps regardless of plan (ALWAYS_ON). Never gated.
  core: ['users', 'dashboard', 'approvals', 'mobile', 'images', 'track'],
  // Finance / GL / AR / AP ('exec' implies gl_post/gl_close/recon_prep/fin_report).
  finance: ['ar', 'creditors', 'exec'],
  // Sales & order management / POS front office.
  sales: ['pos', 'order_mgt', 'claim_mgt', 'crm', 'delivery', 'returns', 'pricelist', 'promos'],
  // Warehouse / inventory.
  inventory: ['warehouse', 'lots', 'locations'],
  // Procurement (PR/PO). pr_raise is the low-risk company-wide requisition step.
  procurement: ['procurement', 'pr_raise'],
  // Master data & BoM master.
  masterdata: ['masterdata', 'bom_master'],
  // Supply-chain planning & marketing analytics.
  planning: ['planner', 'marketing'],
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
};

// Suites that are always granted regardless of plan (mirrors ALWAYS_ON_MODULES). Never gated.
export const ALWAYS_ON_SUITES: SuiteKey[] = ['core'];

// Human-readable suite labels (TH/EN) for the pricing/packaging UI.
export const SUITE_LABELS: Record<SuiteKey, { en: string; th: string }> = {
  core: { en: 'Core', th: 'พื้นฐาน' },
  finance: { en: 'Finance & Accounting', th: 'บัญชีการเงิน' },
  sales: { en: 'Sales & POS', th: 'ขาย & POS' },
  inventory: { en: 'Inventory & Warehouse', th: 'คลังสินค้า' },
  procurement: { en: 'Procurement', th: 'จัดซื้อ' },
  masterdata: { en: 'Master Data', th: 'ข้อมูลหลัก' },
  planning: { en: 'Planning & Analytics', th: 'วางแผน & วิเคราะห์' },
  crm_loyalty: { en: 'CRM & Loyalty', th: 'CRM & สมาชิก' },
  ai: { en: 'AI Copilot', th: 'ผู้ช่วย AI' },
  multibranch: { en: 'Multi-branch', th: 'หลายสาขา' },
  portal: { en: 'Customer Portal', th: 'พอร์ทัลลูกค้า' },
  selfservice: { en: 'Self-service Portals', th: 'พอร์ทัลพนักงาน/ผู้ขาย' },
};

// plan code → suites included. DEFAULT map (a plan row's features.suites JSONB overrides at runtime).
// Keyed by the CURRENTLY SEEDED plan codes (free/starter/pro/enterprise); workstream 1.3 renames the
// commercial tiers to Standard/Professional/Enterprise and can re-map here + in the DB seed.
export const PLAN_SUITES: Record<string, SuiteKey[]> = {
  // Free / trial-limited: base + customer/self-service only.
  free: ['core', 'portal', 'selfservice'],
  // Standard (current 'starter'): SME finance-first core.
  starter: ['core', 'finance', 'sales', 'inventory', 'masterdata', 'portal', 'selfservice'],
  // Professional (current 'pro'): adds procurement, planning, loyalty, AI, multi-branch.
  pro: [
    'core', 'finance', 'sales', 'inventory', 'masterdata', 'portal', 'selfservice',
    'procurement', 'planning', 'crm_loyalty', 'ai', 'multibranch',
  ],
  // Enterprise: everything (custom deals may still tune via features.suites).
  enterprise: [
    'core', 'finance', 'sales', 'inventory', 'masterdata', 'portal', 'selfservice',
    'procurement', 'planning', 'crm_loyalty', 'ai', 'multibranch',
  ],
};

// Sellable capabilities that do NOT yet have a distinct coarse permission token and therefore cannot be
// suite-gated by this map. Follow-up 1.1b must introduce gating tokens for these before they can be sold
// as add-on packs. Documented so the gap is explicit and machine-visible, not silently missing.
export const KNOWN_UNGATED: string[] = [
  'manufacturing', // modules/manufacturing, mfg-depth, bom, planning(demand-ml) — no coarse token
  'projects_ppm',  // modules/projects, pmr — gated by proj_* SUB_PERMISSIONS, not a suite token
  'hcm_payroll',   // modules/hcm, payroll, ess(partly) — no coarse HR/payroll token
  'realestate',    // gated by re_* SUB_PERMISSIONS (vertical), not a suite token
];

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
export function resolveEntitledSuites(planCode: string | null | undefined, featuresSuites?: unknown): SuiteKey[] {
  const valid: SuiteKey[] = Array.isArray(featuresSuites)
    ? (featuresSuites.filter((s) => typeof s === 'string' && (s as string) in SUITES) as SuiteKey[])
    : [];
  const base = valid.length ? valid : (planCode && PLAN_SUITES[planCode]) || ALWAYS_ON_SUITES;
  return [...new Set<SuiteKey>([...ALWAYS_ON_SUITES, ...base])];
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
