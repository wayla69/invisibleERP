# 36 — Monetization & Packaging (plan → suite → module entitlements)

> **Status:** Wave 1 in progress. This document is the living spec for how subscription plans gate access.
> **Source of truth (code):** `packages/shared/src/entitlements.ts` (validated by `tools/ci/check-entitlements.mjs`,
> which runs as a step in the CI `build` job — a drifted map fails every PR).
> Revision history at the bottom.

## 1. Model

Access is gated at the level of the **coarse module permission tokens** — `MODULE_KEYS` in
`packages/shared/src/permissions.ts` (the 42 tokens = `PERMISSIONS` minus the single-duty
`SUB_PERMISSIONS`). These tokens are what `@Permissions` and `ModuleEnabledGuard` already check, so they
are the only unit a plan can enforce today.

Layering:

```
PLAN (free / starter / business / pro / enterprise)
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
| **finance** | ar, creditors, exec, treasury *(TRE-01..05 depth; `treasury_approve` is a sub-permission)* |
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
| **manufacturing** *(premium)* | quality *(QMS NCR/CAPA/SCAR; `quality_approve` is a sub-permission)* — plus `@RequiresSuite('manufacturing')` on the Manufacturing/MRP/QC/APS controllers |
| **projects** *(premium)* | — token-less; gated by `@RequiresSuite('projects')` on the Projects + PMR controllers |
| **hcm** *(premium)* | hr, hr_admin *(HCM depth, docs/42)* — plus `@RequiresSuite('hcm')` on the HCM + Payroll controllers |
| **realestate** *(premium)* | — token-less; gated by `@RequiresSuite('realestate')` on the Real-estate controller |

## 3. Plans → suites (default; DB may override)

| Plan (code) | Commercial name | THB/mo | THB/yr (2 mo free) | USD/mo · USD/yr | Seats | Suites |
|-------------|-----------------|--------|--------------------|------------------|-------|--------|
| `free` | Free / trial-limited | 0 | — | — | 2 | core, portal, selfservice |
| `sme` | **SME (เจ้าของคนเดียว)** | 690 | 6,900 | $20 · $200 | 1 | core, finance, sales, inventory, masterdata, procurement, planning, crm_loyalty, ai, portal, selfservice |
| `starter` | **Standard** | 2,900 | 29,000 | $85 · $850 | 10 | core, finance, sales, inventory, masterdata, portal, selfservice |
| `business` | **Business** | 4,900 | 49,000 | $140 · $1,400 | 25 | + procurement, multibranch |
| `pro` | **Professional** | 9,900 | 99,000 | $285 · $2,850 | 50 | + planning, crm_loyalty, ai |
| `enterprise` | **Enterprise** | quote (custom) | quote | quote | ∞ | all suites (custom deals tune via `features.suites`) |

**SME single-operator edition (docs/49):** the `sme` plan is the DEFAULT a `control_profile='sme'` company
provisions onto (`provisionTenant` picks `sme` when the edition is SME and no explicit `plan_code` is passed;
an explicit plan always wins — the plan and the control profile stay orthogonal). Its differentiator is the
**one-seat / one-location cap**, not a thin module set: a solo owner gets the *full* day-to-day operational
ERP (finance→procurement→planning→CRM/AI) so "one person does every job" is literally true. The seat cap is
the commercial fence versus per-seat Enterprise — at 690/mo for one seat it sits *below* Standard's 2,900
(which buys 10 seats + higher volume quotas), so it does not undercut the multi-seat ladder. Volume caps are
solo-appropriate (200 e-Tax docs, 5,000 POS txns/mo; AI 100k tokens/day, both metered as overage). Upgrading
to Enterprise (`upgradeControlProfile`) adds the heavy verticals (manufacturing/projects/hcm/realestate) +
multi-seat and re-instates full maker-checker segregation; the transition is upgrade-only.

**Ladder rationale (1.9):** the old Standard→Professional step was a 5.2× cliff (1,900 → 9,900) with no
rung in between — customers parked at Standard. `business` (2,900 → 4,900 → 9,900 ≈ 1.7× per step) gives
procurement + multi-branch to growing SMEs while planning/loyalty/AI stay the Professional differentiators.
Standard moved 1,900 → 2,900 (new signups only — existing subscription rows keep their `plan_code` and are
re-priced only at renewal per contract; `seedPlans()` upserts the plan row, it never touches subscriptions).

**Annual + multi-currency (1.7, migration `0284`, DEFAULT-INERT):** `subscriptions.billing_interval`
(default `monthly`) + `subscriptions.currency` (default `THB`) record the billing intent;
`plans.price_yearly` (NULL = not offered annually → `ANNUAL_NOT_OFFERED`) and the per-currency
`plans.prices` map (absent currency → `CURRENCY_NOT_OFFERED` — fail-closed, never a silent THB fallback)
drive `resolvePlanPrice`. Checkout passes the resolved amount/interval to Stripe
(`recurring.interval: month|year`); `changePlan` prorates on the sub's interval basis (365-day annual
periods) and returns `proration: null + proration_note: 'interval_change'` on a monthly↔annual switch
(no honest single number across period bases — applied at the next renewal instead). The `/billing` page
gets a monthly/annual toggle. USD prices are illustrative market-entry defaults — tune after testing.

Prices/seats/suites are seeded in `PLAN_SEED` (`billing.service.ts`) and upserted idempotently by
`seedPlans()` at startup — which also **backfills `features.suites`** onto every plan row (the grandfather
step). Codes are unchanged (`starter`/`pro`) so existing `subscriptions.plan_code` FKs stay valid; only the
display names/prices changed. Prices are the recommended market-entry defaults — tune after market testing.

## 4. Premium/add-on suites — the `@RequiresSuite` mechanism (1.1b, RESOLVED)

Manufacturing / PPM / HCM / Real-estate originally had **no distinct coarse token** (their controllers ride
on generic tokens like `exec`/`planner`/`bom_master`), so token→suite mapping alone would hand them to any
plan that has `finance`. 1.1b resolves this with **token-less suites** gated by a class decorator. (Later
waves DID add coarse tokens for two of them — QMS `quality` and HCM-depth `hr`/`hr_admin` — which are now
mapped into `manufacturing`/`hcm`, so both gating paths agree there; PPM and Real-estate remain purely
decorator-gated, see `TOKENLESS_SUITES`.)

- `apps/api/src/modules/billing/requires-suite.decorator.ts` — `@RequiresSuite('<suite>')`.
- `PlanGuard` reads it and blocks (`403 SUITE_NOT_ENTITLED`) when the tenant's plan does not include the
  suite — under the same `ENTITLEMENTS_ENFORCE` kill-switch (off = ignored), god-bypassed, trial-granted.
- Applied to: `ManufacturingController`, mfg-depth (`Routing`/`ShopFloor`/`Quality`/`Mrp`/`WorkCenter`/`Aps`),
  `ProjectsController`, `PmrController`, `HcmController`, `PayrollController`, `RealEstateController`.
- Default packaging: these four suites are **Enterprise-only** (`PLAN_SUITES.enterprise`); sell to lower
  tiers as add-ons via a per-tenant `features.suites` override. `KNOWN_UNGATED` is now empty.

### 4b. Premium-suite LIST prices (1.9 — published, no longer quote-only)

Add-ons are sold onto **Business or Professional** via the per-tenant `features.suites` override (no code
change per deal). Publishing list prices shortens the SME sales cycle — Thai SMEs don't call for a quote,
they close the tab. Enterprise still bundles all four.

| Add-on suite | THB/mo (list) | THB/yr (2 mo free) | Available on |
|---|---|---|---|
| `manufacturing` (MRP/QC/APS) | +6,000 | +60,000 | Business, Professional |
| `projects` (PPM/EVM) | +4,500 | +45,000 | Business, Professional |
| `hcm` (HR & Payroll) | +3,500 | +35,000 | Business, Professional |
| `realestate` (Developer) | +6,000 | +60,000 | Professional |

List prices are commercial policy (this doc + the sales deck) — billing applies them via the deal's
`features.suites` + a negotiated `priceMonthly` on a custom plan row or invoice line; there is no
self-serve add-on checkout yet (deliberate: add-on buyers need implementation anyway).

### 4c. Implementation packages (one-time, sold with every paid plan)

ERP is not self-serve. Every paid signup is offered a fixed-price onboarding package — this is the churn
insurance, not upsell garnish:

| Package | THB (one-time) | Scope |
|---|---|---|
| **Launch** | 30,000 | Remote: master-data import (the `masterdata` engine), COA review, 2× training sessions, go-live checklist |
| **Standard** | 80,000 | + on-site day, opening-balance migration, per-cycle workflow walkthrough (P2P/O2C/R2R), UAT support |
| **Enterprise** | 150,000+ | + multi-branch rollout plan, custom roles/SoD matrix review, e-Tax/bank-format setup, hypercare 30 days |

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
- **Wave B (done) — staged enforcement rollout tooling** (the operating loop between "shadow for all" and
  "enforce for all"):
  - **B1 — observation ledger** (`entitlement_observations`, migration `0455`, platform-level
    `about_tenant_id`): every would-block (shadow) and did-block (enforce) decision lands one row per
    (business day × tenant × deny code × mode × route-perm set) — fire-and-forget from `PlanGuard.decide()`
    behind an in-process first-seen gate + a DB `dedup_key` UNIQUE, so the request hot path pays at most one
    insert per unique denial per day per process and can NEVER fail a request. God read:
    `GET /api/admin/entitlement-observations?days=N` (rollup + raw rows); Platform Console → **แพ็กเกจ &
    โมดูล** shows the "who would break" triage panel.
  - **B2 — upsell UX:** a plan-level deny code (`SUITE_NOT_ENTITLED` / `PLAN_FEATURE_REQUIRED` /
    `TRIAL_EXPIRED` / `SUBSCRIPTION_INACTIVE` / `SUBSCRIPTION_PASTDUE_READONLY`) reaching `lib/api.ts` raises
    an app-wide `ierp:plan-denied` event; the AppShell-mounted `PlanUpsellDialog` turns the bare 403 into the
    server's localized message + a **ดูแพ็กเกจ & ชำระเงิน** CTA → `/billing` (internal variant only; open
    dialog + per-code cooldown absorb parallel-query 403 bursts). Errors still throw unchanged.
  - **B3 — per-tenant cohort:** `ENTITLEMENTS_ENFORCE_TENANTS` (comma-separated tenant IDs) gives listed
    tenants FULL enforcement (Admin no-bypass semantics included) while everyone else keeps the global mode —
    the legacy path stays zero-cost for non-cohort tenants. Rollout: shadow for all → clear a tenant in the
    B1 panel → add it to the cohort → repeat → finally `ENTITLEMENTS_ENFORCE=true` global.
- **Wave C (done) — Thai payment rails** (`saas_payment_claims`, migration `0456`): a tenant that pays by
  bank transfer / PromptPay (no card) gets a real self-serve loop:
  - **Where + how much:** `GET /api/billing/payment-info` — the platform's dynamic EMVCo PromptPay QR for
    the amount due (`PLATFORM_PROMPTPAY_ID`; reuses the POS `buildPromptPayPayload`, raw payload — never a
    deep link) and/or free-text bank details (`PLATFORM_BANK_ACCOUNT`); amount due = plan price for the
    subscription's interval + purchased add-ons via the ONE A3 pricing rule (`resolveAddonCharges`).
  - **Slip claim:** `POST /api/billing/payment-claims` (perm `users`, always the caller's own tenant) files
    the transfer reference + amount as a **Pending claim** — `(tenant, slip_ref)` UNIQUE refuses a re-filed
    slip (`DUPLICATE_SLIP`); a god-inbox notification fires. A claim is NEVER money by itself.
  - **God verify queue:** `GET /api/admin/payment-claims` + Platform Console **การชำระเงิน** tab — approve
    (after checking the real bank statement) records the A4 `saas_receipt` (source `bank_transfer`,
    idempotent on `claim:<id>` — a double-click approves once), **re-activates the subscription** (the A2
    dunning-recovery signal) and emails the receipt; reject emails the reason (`payment_claim_rejected`
    template). Decided claims are immutable (`CLAIM_NOT_PENDING`).

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
  | SME | 200 | 5,000 | ฿3/doc | ฿0.5/txn |
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
| 1.8 | 2026-07-21 | Platform | **Wave C — Thai payment rails (migration `0456`).** `saas_payment_claims` slip-claim ledger: `GET /api/billing/payment-info` (platform PromptPay dynamic EMVCo QR via the POS `buildPromptPayPayload` + `PLATFORM_PROMPTPAY_ID`/`PLATFORM_BANK_ACCOUNT`; amount due = plan + add-ons via the shared `resolveAddonCharges`, now public), tenant slip claims (`POST/GET /api/billing/payment-claims`, own-tenant only, `(tenant, slip_ref)` UNIQUE → `DUPLICATE_SLIP`, god-inbox notify), god verify queue (`/api/admin/payment-claims` + Platform Console การชำระเงิน tab: approve → A4 receipt source `bank_transfer` idempotent on `claim:<id>` + subscription Active + receipt email; reject → `payment_claim_rejected` email; decided = immutable `CLAIM_NOT_PENDING`). `/billing` gains the ชำระด้วยการโอน card (QR + bank + claim form + status list). ToE: `onboarding` 196→207, platform e2e 5→6. No ICFR control change (platform revenue collection; tenant GL untouched). |
| 1.7 | 2026-07-21 | Platform | **Wave B — staged enforcement rollout (migration `0455`).** B1 observation ledger `entitlement_observations` (would-block/did-block per business day × tenant × code × mode, written fire-and-forget from `PlanGuard.decide()` with in-process + DB dedup; god read `GET /api/admin/entitlement-observations` + Platform Console triage panel on the แพ็กเกจ & โมดูล tab). B2 upsell UX: plan-level deny codes raise `ierp:plan-denied` from `lib/api.ts` → AppShell `PlanUpsellDialog` (localized server message + ดูแพ็กเกจ & ชำระเงิน CTA → `/billing`, internal only; cooldown against parallel-403 bursts). B3 per-tenant cohort `ENTITLEMENTS_ENFORCE_TENANTS` — listed tenants get full enforcement while everyone else keeps the global mode (legacy path stays zero-cost). ToE: `plan-gating` 41→52, `onboarding` 194→196, platform-plans e2e 3→5. No ICFR control change (commercial gating; tenant GL untouched). |
| 1.6 | 2026-07-21 | Platform | **A4 — own-SaaS receipts (migration `0454`).** One `saas_receipts` row per subscription payment the platform collects: Stripe `invoice.paid`/`invoice.payment_succeeded` webhooks (which now also confirm the subscription Active — the A2 dunning-recovery signal) and god-recorded bank transfers (`POST /api/admin/tenants/:id/receipts`). RCPT-S numbering, idempotent on the invoice id (`source_ref` UNIQUE), 7% VAT breakdown ONLY when `RECEIPT_ISSUER_TAX_ID` is configured (else a plain ใบเสร็จรับเงิน — never a false tax-invoice claim), `saas_receipt` email via the A1 outbox, bilingual A4 document via the shared PdfRenderer (HTML fallback). Tenant self-serve: `GET /api/billing/receipts` + printable `/:no/pdf`, hard-scoped to the caller's own tenant (foreign number = 404); `/billing` gains a receipts card. ToE: `onboarding` 186→194. No ICFR control change (platform revenue paper trail; tenant GL untouched). |
| 1.5 | 2026-07-21 | Platform | **A3 — add-on BILLING + tenant self-serve purchase.** Checkout now carries purchased add-ons as extra **recurring Stripe line items** on the same subscription (amount interval-scaled: annual = 10× monthly; keys in session metadata → the webhook stamps `subscriptions.addons` on completion). New tenant self-serve `POST /api/billing/addons` (perm `users`, ALWAYS the caller's own tenant): entitlement applies immediately; a live Stripe subscription gets its add-on line items **reconciled** (`syncAddonItems` — items identified by `metadata.addon_key`, default proration both directions), else entitlement-only (mock/dev/Trialing). Pricing fail-closed: unknown key → 400 `UNKNOWN_ADDON`, non-THB checkout with add-ons → 400 `ADDON_CURRENCY_UNSUPPORTED`, plan-included add-ons dropped from the charge. `/billing` gains an add-on card (toggle + save, "รวมในแพ็กเกจแล้ว" for included ones). ToE: `onboarding` 178→186. No ICFR control change. |
| 1.4 | 2026-07-20 | Platform | **Franchise tier + à-la-carte ADD-ON suites + /plans pack carry-through (migration `0451`).** New seeded plan **`franchise`** (฿14,900/mo · ฿149,000/yr · USD 425; Professional + manufacturing + projects + every add-on suite; 100 seats / 25 locations). Four token-less **add-on suites** `scm_advanced`/`integrations`/`cdp`/`sandbox` (the /plans configurator's "Advanced add-ons"): grandfathered into the plans whose tokens already reached those surfaces (scm_advanced→business+, cdp/integrations→pro+, sandbox→franchise+), purchasable per tenant via **`subscriptions.addons`** (`POST /api/admin/tenants/:id/addons`, god-only; unknown key → 400 `UNKNOWN_ADDON`); `resolveEntitledSuites(plan, features, addons)` unions each purchased add-on's **`ADDON_GRANTS`** set (scm_advanced also carries the base `procurement` suite — its RFQ/match endpoints ride that token). `@RequiresSuite` gates added: `scm_advanced` on RFQ + three-way-match controllers, `sandbox` on the developer portal, `cdp` per-handler on the CRM audience-export/register/rules/CDP-export endpoints; the @Public web-to-lead webhook checks `integrations` IN-SERVICE (mirrors guard semantics; enforce-mode only, trial allows, fail-open on infra error). All gates INERT under the default legacy mode. **Pack carry-through:** the public /plans configurator's CTA carries `?plan=&billing=&addons=` → the signup request stores the PACK_TO_PLAN-mapped REAL plan code + interval + add-ons (`signup_requests.requested_*`), the Platform Console onboarding queue shows them, and **approve provisions the requested pack** (plan + `billing_interval` + `addons` stamped on the trialing subscription; absent ⇒ legacy `free`). ToE: `plan-gating` 34→41 (add-on grants, grandfathering, franchise suites, junk-key ignored, legacy inert) + `onboarding` 157→160 (queue row carries the mapped pack; approve honours it; franchise seeded). No ICFR control change. |
| 1.3 | 2026-07-15 | Platform | **SME single-operator plan** (docs/49) — new `sme` plan seeded (฿690/mo · ฿6,900/yr · $20/$200), full day-to-day operational suites (`PLAN_SUITES.sme` = core/finance/sales/inventory/masterdata/procurement/planning/crm_loyalty/ai/portal/selfservice) but capped to **1 seat / 1 location** (the commercial fence vs per-seat Enterprise; sits below Standard on price). `provisionTenant` defaults a `control_profile='sme'` company with no explicit `plan_code` to the `sme` plan (explicit plan always wins; plan and control profile stay orthogonal). Volume caps solo-appropriate (200 e-Tax/mo, 5,000 POS/mo; AI 100k/day, metered as overage). Seeded via `PLAN_SEED` upsert — existing subscriptions untouched. Commercial policy + seed data; no control/RCM change. |
| 1.2 | 2026-07-13 | Platform | **CI wiring** — `check-entitlements.mjs` added as a step in the `.github/workflows/ci.yml` `build` job (right after the shared build), so entitlement-map drift now fails every PR instead of accumulating silently (the rev-1.1 orphaned-token drift went unnoticed for a week because the guard was doc-only). No map/behaviour change. |
| 1.1 | 2026-07-12 | Platform | **Entitlement-map drift repaired** — four coarse MODULE_KEYs added by post-1.1 waves were never assigned to a suite, failing `check-entitlements.mjs` (`hr, hr_admin, quality, treasury`). Mapped: `treasury` → **finance** (TRE-01..05 is finance depth), `quality` → **manufacturing** (QMS rides the premium suite the doc already scoped as "Manufacturing/MRP/QC/APS"), `hr`+`hr_admin` → **hcm** (those controllers already carry `@RequiresSuite('hcm')`). The `*_approve` checker duties are sub-permissions (not suite-gated). `TOKENLESS_SUITES` narrowed to projects/realestate. Map-only — no runtime change while `ENTITLEMENTS_ENFORCE` is off; guard now reports 46 module keys across 16 suites. No control/RCM change. |
| 1.0 | 2026-07-09 | Platform | 1.9 — **pricing-ladder restructure**: new `business` mid-tier ฿4,900/mo (Standard + procurement + multibranch, 25 seats, metered quotas between Standard/Pro); Standard re-priced ฿1,900→฿2,900 ($85/$850); premium-suite **list prices published** (§4b — was quote-only); **implementation packages** defined (§4c, one-time ฿30k/฿80k/฿150k). `PLAN_SUITES.business` added in `entitlements.ts` (validated by `check-entitlements.mjs`); seeded via `PLAN_SEED` upsert — existing subscriptions untouched (`seedPlans()` never writes `subscriptions`). No control/RCM change (commercial policy + seed data). |
| 0.1 | 2026-07-07 | Platform | Initial packaging spec — plan→suite→module entitlement map (`entitlements.ts`) + CI guard (`check-entitlements.mjs`). Map-only; no enforcement yet (PlanGuard rewire is 1.2). Documented `KNOWN_UNGATED` gap (manufacturing/PPM/HCM/real-estate need gating tokens — 1.1b). |
| 0.2 | 2026-07-07 | Platform | 1.2 — `PlanGuard` rewired: suite gating behind `ENTITLEMENTS_ENFORCE`/`ENTITLEMENTS_SHADOW` (default off = legacy behaviour), per-tenant Admin bypass removed (god-only), fail-open on infra error / fail-closed on missing plan, `resolveEntitledSuites` grandfather fallback. No behaviour change until enabled; enable SHADOW → backfill (1.3) → ENFORCE. |
| 0.9 | 2026-07-08 | Platform | 1.7 — **annual billing + multi-currency** (see §3). `plans.price_yearly` + per-currency `plans.prices`, `subscriptions.billing_interval`/`currency` (migration `0284`, default-inert), fail-closed `resolvePlanPrice` (`ANNUAL_NOT_OFFERED`/`CURRENCY_NOT_OFFERED`), Stripe `recurring.interval` year, interval-aware proration (365-day basis; interval switch → note, not a misleading number), `/billing` monthly/annual toggle. ToE: `proration` 12 (+2 annual basis), `saas-metrics` 29 (+7 flow incl. fail-closed + intent stamping). หมวด 1 (Monetization) now 100% complete. |
| 0.8 | 2026-07-08 | Platform | 1.4 (residual UI) — the `/billing` page now surfaces the FULL meter→price loop: a **metered-usage card** (e-Tax docs / POS txns used-vs-quota for the month, per-meter overage badge + projected charge, from `GET /api/billing/usage`), an **overage charge history** table merging AI + usage runs (`/api/billing/ai-overage/runs` + `/usage-overage/runs`), the **proration** line from `change-plan` shown on plan switch (1.6), and plan-card feature labels for the new quota keys (`etax_docs_monthly`/`pos_txns_monthly`; rate keys + `suites` hidden from the raw dump). No new `'use client'` file (extends the existing page — ratchet flat). |
| 0.7 | 2026-07-08 | Platform | 1.5 — **usage metering → overage billing** (see §5b). Two generic meters (`etax_docs`, `pos_txns`) in `usage_events` (migration `0281`), captured best-effort/autocommit at `EtaxService.submit` (accepted docs) + `PortalPosService.createSale` (idempotent per doc_no/sale_no) via the new `modules/usage` `UsageMeterService`. Monthly included quota + per-unit overage price added to `PLAN_SEED` **and** backfilled by `0281`. `BillingService.runUsageOverageBilling` charges one Stripe item per (tenant, meter, month), idempotent via `usage_overage_billing_runs` UNIQUE; scheduled BI report type `usage_overage_billing`; read views `GET /api/billing/usage` + `/usage-overage/runs`. No RLS (operator/job meter, like AI tokens). ToE `saas-metrics` +8 (22 total); `taxdocs`/`restaurant`/`sub-billing`/`tenant-idx`/`migration-parity` unregressed. Monetization infra — no ICFR control change. |
| 0.6 | 2026-07-07 | Platform | 1.6 — mid-cycle **proration** on `changePlan`. `modules/billing/proration.ts` `computeProration()` returns the unused credit on the old plan + prorated charge on the new plan for the days left in the period (`net` >0 = charge, <0 = credit); `changePlan` now returns it. Informational (the Stripe proration-invoice-item is a follow-up). ToE `cutover/proration` (10/10). No behaviour change to the plan switch itself; onboarding 75/75 unregressed. |
| 0.5 | 2026-07-07 | Platform | 1.4 (grace) — PastDue subscriptions get a `BILLING_GRACE_DAYS` (default 7) read-only grace window after `current_period_end`: reads pass, mutations → `403 SUBSCRIPTION_PASTDUE_READONLY`, and only past the window is all access blocked (`SUBSCRIPTION_INACTIVE`); `Canceled` blocks immediately (no grace). So enabling enforcement never abruptly locks a lapsed payer out of their own data. `evaluatePastDueGrace`/`billingGraceDays` pure helpers; plan-gating ToE +9 (34 total). *(In-app billing UI — the `/settings/billing` page + invoice/usage endpoints — remains as frontend work.)* |
| 0.4 | 2026-07-07 | Platform | 1.1b — token-less premium suites (manufacturing/projects/hcm/realestate) + `@RequiresSuite` decorator honoured by PlanGuard; applied to 11 controllers; Enterprise-only by default; `KNOWN_UNGATED` emptied. plan-gating ToE extended (+6 checks). |
| 0.3 | 2026-07-07 | Platform | 1.3 — real prices + names (Standard ฿1,900 / Professional ฿9,900 / Enterprise quote), seats bumped, and `features.suites` embedded in `PLAN_SEED` so `seedPlans()` backfills every plan row (grandfather done). 1.8 — ToE harness `tools/cutover/src/plan-gating.ts` (19 checks: legacy/shadow/enforce modes, god-only bypass incl. the Admin-bypass fix, fail-open/closed, trial/past-due) — all green. |
