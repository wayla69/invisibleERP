# 36 — Monetization & Packaging (plan → suite → module entitlements)

> **Status:** Wave 1 in progress. This document is the living spec for how subscription plans gate access.
> **Source of truth (code):** `packages/shared/src/entitlements.ts` (validated by `tools/ci/check-entitlements.mjs`).
> Revision history at the bottom.

## 1. Model

Access is gated at the level of the **coarse module permission tokens** — `MODULE_KEYS` in
`packages/shared/src/permissions.ts` (the 42 tokens = `PERMISSIONS` minus the single-duty
`SUB_PERMISSIONS`). These tokens are what `@Permissions` and `ModuleEnabledGuard` already check, so they
are the only unit a plan can enforce today.

Layering:

```
PLAN (free / starter / pro / enterprise)
  └── SUITES  (core, finance, sales, inventory, procurement, masterdata,
                planning, crm_loyalty, ai, multibranch, portal, selfservice)
        └── MODULE PERMISSION TOKENS (42; the live RBAC gating currency)
              └── (sub-permissions inherited via PERMISSION_IMPLICATIONS / granted directly — NOT suite-gated)
```

- A plan row's `features.suites` JSONB (DB, set in workstream 1.3) **overrides** the static
  `PLAN_SUITES` default in code when present. The code map is the seed / source of truth.
- `core` is **ALWAYS_ON** — never gated, every plan keeps it (mirrors `ALWAYS_ON_MODULES`).
- Sub-permissions (`gl_post`, `pos_sell`, `proj_*`, `re_*`, …) are **not** suite-gated; they stay governed
  by RBAC/`@Permissions`. Suite gating only governs the 42 module tokens.

## 2. Suites → module tokens

| Suite | Modules (tokens) |
|-------|------------------|
| **core** (always-on) | users, dashboard, approvals, mobile, images, track |
| **finance** | ar, creditors, exec |
| **sales** | pos, order_mgt, claim_mgt, crm, delivery, returns, pricelist, promos |
| **inventory** | warehouse, lots, locations |
| **procurement** | procurement, pr_raise |
| **masterdata** | masterdata, bom_master |
| **planning** | planner, marketing |
| **crm_loyalty** | loyalty, survey |
| **ai** | ai_chat |
| **multibranch** | branch |
| **portal** | order_cust, cust_dash, cust_inventory, cust_pos, cust_bom, cust_variance, cust_my_crm, cust_my_suppliers, cust_my_pos, cust_my_users |
| **selfservice** | ess, vendor_portal |

## 3. Plans → suites (default; DB may override)

| Plan (current code) | Commercial name (1.3) | Suites |
|---------------------|------------------------|--------|
| `free` | Free / trial-limited | core, portal, selfservice |
| `starter` | **Standard** | core, finance, sales, inventory, masterdata, portal, selfservice |
| `pro` | **Professional** | + procurement, planning, crm_loyalty, ai, multibranch |
| `enterprise` | **Enterprise** | all suites (custom deals tune via `features.suites`) |

## 4. Known gap — capabilities not yet suite-gatable (follow-up **1.1b**)

The permission-token model is retail/finance-centric. These sellable capabilities have **no distinct
coarse token**, so they cannot be gated by this map yet. `entitlements.ts` lists them in `KNOWN_UNGATED`;
1.1b must introduce gating tokens (or a parallel module-registry entitlement) before selling them as packs:

- **manufacturing** — `modules/manufacturing`, `mfg-depth`, `bom`, `demand-ml`
- **projects_ppm** — `modules/projects`, `pmr` (currently gated by `proj_*` sub-permissions)
- **hcm_payroll** — `modules/hcm`, `payroll` (partly `ess`)
- **realestate** — gated by `re_*` sub-permissions (vertical)

## 5. Enforcement status

- **1.1 (done):** map + helpers + CI invariant. Pure data; no runtime effect.
- **1.2 (done):** `PlanGuard` rewired (`apps/api/src/modules/billing/plan.guard.ts`), **DEFAULT-OFF** via two
  env flags (see `.env.example`):
  - both off (default) → **legacy behaviour, byte-for-byte** (only `@RequiresPlanFeature` gates, e.g. ai_chat);
  - `ENTITLEMENTS_SHADOW=true` → evaluate + log `[shadow] WOULD block …`, never block (rollout dry-run);
  - `ENTITLEMENTS_ENFORCE=true` → gate the route's `@Permissions` token(s) against the tenant's entitled
    suites → `403 SUITE_NOT_ENTITLED`, plus legacy `@RequiresPlanFeature` → `403 PLAN_FEATURE_REQUIRED`.
  Fixes: the per-tenant `Admin` bypass is **removed** — only the platform owner (`PLATFORM_ADMIN_USERNAMES`)
  bypasses; infra error fails **open**, successfully-read missing/unknown plan fails **closed** to `ALWAYS_ON`
  (via `resolveEntitledSuites`). Blocking mirrors `ModuleEnabledGuard` (block only when NONE of the route's
  tokens is entitled). Decision logic verified across 20 plan/route combos.
- **1.2 rollout order (MANDATORY):** enable SHADOW → watch logs → run the 1.3 backfill (every tenant gets
  `features.suites`) → only then enable ENFORCE. Do NOT enable ENFORCE before the backfill.
- **1.8 (pending):** cutover harness `tools/cutover/src/billing.ts` — plan→suite→403 matrix + god-bypass +
  kill-switch modes end-to-end (this is where the UAT negative case is codified).

## 6. Verify

```
pnpm --filter @ierp/shared build
node tools/ci/check-entitlements.mjs      # asserts every MODULE_KEY maps to exactly one suite
```

## Revision history

| Version | Date | Author | Change |
|---------|------|--------|--------|
| 0.1 | 2026-07-07 | Platform | Initial packaging spec — plan→suite→module entitlement map (`entitlements.ts`) + CI guard (`check-entitlements.mjs`). Map-only; no enforcement yet (PlanGuard rewire is 1.2). Documented `KNOWN_UNGATED` gap (manufacturing/PPM/HCM/real-estate need gating tokens — 1.1b). |
| 0.2 | 2026-07-07 | Platform | 1.2 — `PlanGuard` rewired: suite gating behind `ENTITLEMENTS_ENFORCE`/`ENTITLEMENTS_SHADOW` (default off = legacy behaviour), per-tenant Admin bypass removed (god-only), fail-open on infra error / fail-closed on missing plan, `resolveEntitledSuites` grandfather fallback. No behaviour change until enabled; enable SHADOW → backfill (1.3) → ENFORCE. |
