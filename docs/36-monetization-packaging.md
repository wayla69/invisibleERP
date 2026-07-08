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
| **manufacturing** *(premium)* | — token-less; gated by `@RequiresSuite('manufacturing')` on the Manufacturing/MRP/QC/APS controllers |
| **projects** *(premium)* | — token-less; gated by `@RequiresSuite('projects')` on the Projects + PMR controllers |
| **hcm** *(premium)* | — token-less; gated by `@RequiresSuite('hcm')` on the HCM + Payroll controllers |
| **realestate** *(premium)* | — token-less; gated by `@RequiresSuite('realestate')` on the Real-estate controller |

## 3. Plans → suites (default; DB may override)

| Plan (code) | Commercial name | Price (THB/mo) | Seats | Suites |
|-------------|-----------------|----------------|-------|--------|
| `free` | Free / trial-limited | 0 | 2 | core, portal, selfservice |
| `starter` | **Standard** | 1,900 | 10 | core, finance, sales, inventory, masterdata, portal, selfservice |
| `pro` | **Professional** | 9,900 | 50 | + procurement, planning, crm_loyalty, ai, multibranch |
| `enterprise` | **Enterprise** | quote (custom) | ∞ | all suites (custom deals tune via `features.suites`) |

Prices/seats/suites are seeded in `PLAN_SEED` (`billing.service.ts`) and upserted idempotently by
`seedPlans()` at startup — which also **backfills `features.suites`** onto every plan row (the grandfather
step). Codes are unchanged (`starter`/`pro`) so existing `subscriptions.plan_code` FKs stay valid; only the
display names/prices changed. Prices are the recommended market-entry defaults — tune after market testing.

## 4. Premium/add-on suites — the `@RequiresSuite` mechanism (1.1b, RESOLVED)

Manufacturing / PPM / HCM / Real-estate have **no distinct coarse token** (their controllers ride on
generic tokens like `exec`/`planner`/`bom_master`), so token→suite mapping alone would hand them to any
plan that has `finance`. 1.1b resolves this with **token-less suites** gated by a class decorator:

- `apps/api/src/modules/billing/requires-suite.decorator.ts` — `@RequiresSuite('<suite>')`.
- `PlanGuard` reads it and blocks (`403 SUITE_NOT_ENTITLED`) when the tenant's plan does not include the
  suite — under the same `ENTITLEMENTS_ENFORCE` kill-switch (off = ignored), god-bypassed, trial-granted.
- Applied to: `ManufacturingController`, mfg-depth (`Routing`/`ShopFloor`/`Quality`/`Mrp`/`WorkCenter`/`Aps`),
  `ProjectsController`, `PmrController`, `HcmController`, `PayrollController`, `RealEstateController`.
- Default packaging: these four suites are **Enterprise-only** (`PLAN_SUITES.enterprise`); sell to lower
  tiers as add-ons via a per-tenant `features.suites` override. `KNOWN_UNGATED` is now empty.

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

## 5b. Usage metering → overage billing (1.5, DONE)

Beyond seats/suites, two **usage meters** turn high-volume activity into revenue, mirroring the AI-token
meter (AIG-03) — per-event capture, a monthly included quota on the plan, and an idempotent monthly charge:

| Meter (`usage_events.meter`) | Counts | Recorded at | Idempotency key |
|---|---|---|---|
| `etax_docs` | e-Tax documents accepted by the RD/SP | `EtaxService.submit` (on `status='Accepted'`) | `doc_no` (TIV/ATV) |
| `pos_txns` | Completed POS / dine-in sales | `PortalPosService.createSale` | `sale_no` (SALE-…) |

- **Capture** — `UsageMeterService.record(tenantId, meter, eventKey)` (`modules/usage`) does a best-effort
  AUTOCOMMIT `INSERT … ON CONFLICT (tenant_id, meter, event_key) DO NOTHING` (like `ai_token_usage`), so a
  metered event survives a request-tx rollback and **re-processing the same document never double-counts**.
  It is `@Optional()`-injected and swallows errors — a metering hiccup can never block the sale/submission.
- **Quota + price** — each plan's `features` carries `etax_docs_monthly` / `pos_txns_monthly` (included, −1 =
  unlimited) and `etax_overage_rate_thb_per_doc` / `pos_overage_rate_thb_per_txn`. Seeded in `PLAN_SEED`
  (fresh DBs) **and** backfilled by migration `0281` (existing DBs). Defaults (tune after testing):

  | Plan | e-Tax docs/mo | POS txns/mo | e-Tax overage | POS overage |
  |---|---|---|---|---|
  | Standard | 100 | 3,000 | ฿3/doc | ฿0.5/txn |
  | Professional | 1,000 | 30,000 | ฿2/doc | ฿0.3/txn |
  | Enterprise | unlimited | unlimited | — | — |

- **Bill** — `BillingService.runUsageOverageBilling()` counts each meter's events in the month, subtracts the
  quota, and appends **one Stripe invoice item per (tenant, meter, month)** — idempotent via the
  `usage_overage_billing_runs` UNIQUE (the run row is reserved before charging; the Stripe idempotency key is a
  second guard). Runs unattended via the BI scheduler (report type **`usage_overage_billing`**) or
  `POST /api/billing/usage-overage/run`. Read views: `GET /api/billing/usage` (live snapshot per meter) and
  `GET /api/billing/usage-overage/runs`.
- **Verify** — `tools/cutover/src/saas-metrics.ts` (+8: e-Tax overage 1005→5 over quota = ฿10, POS within
  quota = ฿0, dedup no double-count, run idempotency, ledger). No RLS (operator/job-scoped, like the AI meter).

## 6. Verify

```
pnpm --filter @ierp/shared build
node tools/ci/check-entitlements.mjs      # asserts every MODULE_KEY maps to exactly one suite
NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover saas-metrics   # usage-metering + overage billing
```

## Revision history

| Version | Date | Author | Change |
|---------|------|--------|--------|
| 0.1 | 2026-07-07 | Platform | Initial packaging spec — plan→suite→module entitlement map (`entitlements.ts`) + CI guard (`check-entitlements.mjs`). Map-only; no enforcement yet (PlanGuard rewire is 1.2). Documented `KNOWN_UNGATED` gap (manufacturing/PPM/HCM/real-estate need gating tokens — 1.1b). |
| 0.2 | 2026-07-07 | Platform | 1.2 — `PlanGuard` rewired: suite gating behind `ENTITLEMENTS_ENFORCE`/`ENTITLEMENTS_SHADOW` (default off = legacy behaviour), per-tenant Admin bypass removed (god-only), fail-open on infra error / fail-closed on missing plan, `resolveEntitledSuites` grandfather fallback. No behaviour change until enabled; enable SHADOW → backfill (1.3) → ENFORCE. |
| 0.7 | 2026-07-08 | Platform | 1.5 — **usage metering → overage billing** (see §5b). Two generic meters (`etax_docs`, `pos_txns`) in `usage_events` (migration `0281`), captured best-effort/autocommit at `EtaxService.submit` (accepted docs) + `PortalPosService.createSale` (idempotent per doc_no/sale_no) via the new `modules/usage` `UsageMeterService`. Monthly included quota + per-unit overage price added to `PLAN_SEED` **and** backfilled by `0281`. `BillingService.runUsageOverageBilling` charges one Stripe item per (tenant, meter, month), idempotent via `usage_overage_billing_runs` UNIQUE; scheduled BI report type `usage_overage_billing`; read views `GET /api/billing/usage` + `/usage-overage/runs`. No RLS (operator/job meter, like AI tokens). ToE `saas-metrics` +8 (22 total); `taxdocs`/`restaurant`/`sub-billing`/`tenant-idx`/`migration-parity` unregressed. Monetization infra — no ICFR control change. |
| 0.6 | 2026-07-07 | Platform | 1.6 — mid-cycle **proration** on `changePlan`. `modules/billing/proration.ts` `computeProration()` returns the unused credit on the old plan + prorated charge on the new plan for the days left in the period (`net` >0 = charge, <0 = credit); `changePlan` now returns it. Informational (the Stripe proration-invoice-item is a follow-up). ToE `cutover/proration` (10/10). No behaviour change to the plan switch itself; onboarding 75/75 unregressed. |
| 0.5 | 2026-07-07 | Platform | 1.4 (grace) — PastDue subscriptions get a `BILLING_GRACE_DAYS` (default 7) read-only grace window after `current_period_end`: reads pass, mutations → `403 SUBSCRIPTION_PASTDUE_READONLY`, and only past the window is all access blocked (`SUBSCRIPTION_INACTIVE`); `Canceled` blocks immediately (no grace). So enabling enforcement never abruptly locks a lapsed payer out of their own data. `evaluatePastDueGrace`/`billingGraceDays` pure helpers; plan-gating ToE +9 (34 total). *(In-app billing UI — the `/settings/billing` page + invoice/usage endpoints — remains as frontend work.)* |
| 0.4 | 2026-07-07 | Platform | 1.1b — token-less premium suites (manufacturing/projects/hcm/realestate) + `@RequiresSuite` decorator honoured by PlanGuard; applied to 11 controllers; Enterprise-only by default; `KNOWN_UNGATED` emptied. plan-gating ToE extended (+6 checks). |
| 0.3 | 2026-07-07 | Platform | 1.3 — real prices + names (Standard ฿1,900 / Professional ฿9,900 / Enterprise quote), seats bumped, and `features.suites` embedded in `PLAN_SEED` so `seedPlans()` backfills every plan row (grandfather done). 1.8 — ToE harness `tools/cutover/src/plan-gating.ts` (19 checks: legacy/shadow/enforce modes, god-only bypass incl. the Admin-bypass fix, fail-open/closed, trial/past-due) — all green. |
