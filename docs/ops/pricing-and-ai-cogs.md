# Pricing & AI COGS — tier caps, metered overage, and gross margin

> **Status: v1.0 (2026-06-30) — illustrative.** The subscription prices and AI-token economics below are the
> agreed **illustrative defaults** (PwC Capital Markets follow-up). They are real, deployable numbers — the
> founder can overwrite any figure, but there are no longer `<<PLACEHOLDER>>` blanks: the meter is connected
> to a price. Code source of truth: `apps/api/src/modules/billing/billing.service.ts` (`PLAN_SEED`) +
> migration `0198_ai_overage_pricing.sql`. Unit economics: [`unit-economics-model.md`](unit-economics-model.md).

## Why this exists (panel Round-2 #3 + PwC Capital Markets)

The platform meters AI tokens per tenant (`ai_token_usage`) but previously (a) priced AI as an unlimited
Enterprise bucket and (b) left prices as placeholders. On a usage-priced upstream (Anthropic) under a flat
subscription, **one heavy tenant could burn more in API spend than their seat costs** — negative gross margin
that worsens as the best customers scale. This is now a **ceiling + metered-overage** model: every tier is
finite, and usage above the included cap is **billed**, not given away.

## Price list (synced to `PLAN_SEED`, 2026-07-21)

| Plan (code) | Price/mo (THB) | `ai_chat` | Included AI tokens/day | Hard ceiling/day | Overage rate |
|------|----------------|-----------|------------------------|------------------|--------------|
| Free (`free`) | 0 | off | 0 | 0 | — |
| SME (`sme`) | 690 | on | 100,000 | 200,000 | 12 THB / 1k overage tokens |
| Standard (`starter`) | 2,900 | off | 0 | 0 | — |
| Business (`business`) | 4,900 | off | 0 | 0 | — |
| Professional (`pro`) | 9,900 | on | 200,000 | 500,000 | 12 THB / 1k overage tokens |
| Franchise (`franchise`) | 14,900 | on | 500,000 | 1,000,000 | 10 THB / 1k overage tokens |
| Enterprise (`enterprise`) | custom (contact sales) | on | 2,000,000 | 5,000,000 | 8 THB / 1k overage tokens |

Feature keys in `PLAN_SEED.features`: `ai_tokens_daily` (included, free band), `ai_tokens_daily_max` (hard
ceiling), `ai_overage_rate_thb_per_1k` (price of the band between them).

## How the three thresholds behave

1. **Included cap (`ai_tokens_daily`)** — free tokens within the subscription. Usage here is not billed.
2. **Overage band (included → max)** — metered: every token above the included cap accrues to
   `ai_token_usage.overage_tokens` and is billed at the plan's overage rate. The user keeps working.
3. **Hard ceiling (`ai_tokens_daily_max`)** — the absolute daily cutoff. At the ceiling the next request is
   blocked with `AI_BUDGET_EXCEEDED` (resets at midnight Asia/Bangkok). This bounds the blast radius of a
   prompt-injection loop or a runaway integration.

Enforcement: `AgentService.checkBudget()` resolves both thresholds, blocks at the ceiling, and returns the
included cap so `recordUsage()` meters the overage. Legacy `-1` ("unlimited") still maps to a finite ceiling
(`AI_ENTERPRISE_DAILY_CAP`); a plan that omits the cap falls back to `DEFAULT_AI_DAILY = 50,000`.

## Billing the overage (collected, not just shown)

- **Read view:** `GET /api/billing/ai-usage` returns today's `overage_tokens`, the rate, and
  `projected_overage_thb`; the web billing screen surfaces it (`apps/web/.../billing/page.tsx`).
- **Invoice line:** `GET /api/billing/ai-overage?month=YYYY-MM` → `BillingService.aiOverageInvoice()` sums the
  month's metered overage tokens and prices them (`overage_tokens / 1000 × rate`).
- **Collection (Wave 1):** the **`ai_overage_billing`** monthly action job (`BillingService.runAiOverageBilling`,
  rides the BI scheduler — see `bi.service.ts`) appends a **Stripe invoice item** per tenant for the
  just-closed month's overage, which Stripe attaches to the tenant's next subscription invoice. It is
  **idempotent per (tenant, month)** via `ai_overage_billing_runs` (migration `0201`, UNIQUE guard) plus a
  Stripe idempotency key — a re-run never double-charges. Without `STRIPE_SECRET_KEY` it records a mock line
  (status `recorded`) so the flow is testable offline. Trigger: schedule a `monthly` BI subscription of type
  `ai_overage_billing`, or `POST /api/billing/ai-overage/run` (exec); history at `GET /api/billing/ai-overage/runs`.
- **Re-pricing without a deploy:** the rate is data-driven — per-plan `ai_overage_rate_thb_per_1k`, with an
  optional global env override `AI_OVERAGE_RATE_THB_PER_1K`. ToE: `tools/cutover/src/saas-metrics.ts`.

## Usage meters beyond AI (1.5) — e-Tax documents & POS transactions

The same meter→quota→overage machinery now covers two more high-volume, cost-bearing activities, so heavy
users on a flat plan don't erode margin (full spec: `docs/36-monetization-packaging.md` §5b):

| Meter | Included / mo (Standard · Pro) | Overage rate (Standard · Pro) | Recorded at |
|---|---|---|---|
| `etax_docs` (e-Tax invoices/receipts submitted) | 100 · 1,000 | ฿3 · ฿2 / doc | `EtaxService.submit` (accepted only) |
| `pos_txns` (completed POS/dine-in sales) | 3,000 · 30,000 | ฿0.5 · ฿0.3 / txn | `PortalPosService.createSale` |

Feature keys in `PLAN_SEED.features` (and backfilled by migration `0281`): `etax_docs_monthly` /
`pos_txns_monthly` (included, −1 = unlimited) and `etax_overage_rate_thb_per_doc` /
`pos_overage_rate_thb_per_txn`. Events land in `usage_events` (idempotent per `doc_no`/`sale_no`), and the
**`usage_overage_billing`** monthly job (`BillingService.runUsageOverageBilling`) appends one Stripe item per
(tenant, meter, month) — idempotent via `usage_overage_billing_runs`. Read views: `GET /api/billing/usage`
(live snapshot per meter) and `/usage-overage/runs`. ToE: `saas-metrics` (+8).

## AI cost-of-goods (COGS) — the margin lever

- **Model tiering** (`apps/api/src/common/ai-models.ts`) routes mechanical tasks (doc extraction, NL→query,
  tool-relay) to **Haiku** and reserves **Sonnet** for reasoning/synthesis — **no task defaults to Opus**.
  Regression-guarded by `apps/api/test/ai-cost.test.ts` (a test fails if any task resolves to Opus). This is
  the primary COGS lever and was the PwC AI-desk ask; it is already in `main`.
- **Prompt caching** (system prompt + tool manifest `cache_control`) cuts input-token cost per turn.
- **Loop bound:** 15-turn agent loop × 4,096 max output tokens per turn caps a single conversation.

See [`unit-economics-model.md`](unit-economics-model.md) for blended COGS per tenant, gross margin, and the
CAC/ARPU/payback model that consume these numbers.

## Revision history

| Date | Version | Change |
|------|---------|--------|
| 2026-06-30 | v1.0 | Connected meter→price: ceiling + metered-overage model, illustrative prices + overage rates filled (no placeholders), overage invoice line + UI, links to unit-economics model. PwC Capital Markets follow-up. |
| 2026-06-30 | v0.1 (DRAFT) | Initial — finite tier caps, overage metering, AI-COGS note (placeholders pending sign-off). |
