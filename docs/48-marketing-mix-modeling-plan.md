# 48 — Marketing Mix Modeling (MMM · staging → core → analytics pipeline)

> **Date:** 2026-07-13 · **Status:** v0.1 — backend + doc-sync delivered (web UI + cutover ToE harness are
> phase 2) · **Owner:** ERP / Product
> **Origin:** a design draft proposing three raw Postgres schemas (`staging`/`core`/`analytics`) with
> per-platform social feeds, per-channel daily sales, sentiment trends, customer behaviour and an MMM result
> table — to feed a channel ROI / budget-allocation dashboard.
> **Discipline (same as docs/45/47):** the code change ships with its migration + module + RCM control +
> narrative + UAT in one doc-synced PR, merged only on a green CI matrix.

---

## 0. Why the draft could not land as-is (Architecture Gatekeeper)

The pasted DDL violated several non-negotiable invariants of this codebase, so it was **redesigned**, not
applied verbatim:

| Draft | Problem | Redesign |
| --- | --- | --- |
| 3 separate PG schemas (`staging`/`core`/`analytics`) | The app is single-schema (`public`); the generic RLS loop, the guards and the `tenant-idx` gate all assume `public`. | All tables in `public`, prefixed `mmm_` with the stage in the name. |
| No `tenant_id` / no RLS on any table | Multi-tenant leak — every company would share social feeds, customer behaviour, results. | Every table `tenant_id`-scoped + canonical org-clause `tenant_isolation` RLS + leading `(tenant_id, …)` index. |
| `staging.erp_sales_daily` `date PRIMARY KEY` | One row per day **globally** — collapses product/channel/tenant. | Surrogate id + `unique(tenant_id, biz_date, sku, utm_source, promo_code)`. |
| `core.customer_behavior` `customer_id VARCHAR PK` | Collides across tenants and duplicates the customer master. | Keyed by `customer_no` (master business key), `unique(tenant_id, customer_no)`; a materialised roll-up, not a second source of truth. |
| `analytics.mmm_results` `channel PK` | Overwrites history; no record of inputs (spend, window, who). | Split into an audited `mmm_model_runs` header + `mmm_channel_results` rows. |
| Raw `CREATE TABLE` DDL | Not journaled → `drizzle-kit migrate` silently skips it in prod. | Drizzle schema (`schema/mmm.ts`) + journaled migration `0403`. |
| "Streamlit pulls `mmm_results`" | No Streamlit in this stack (NestJS API + Next.js web; analytics = `modules/bi`). | Results served via `GET /api/mmm/*` + `GET /api/bi/mmm-summary`. |

## 1. Bounded context

**New module: `modules/mmm`** — a distinct business responsibility (ingest external marketing signals →
model channel effectiveness) from `modules/marketing` (campaigns/segments), `modules/reputation` (external
review/GA4 ingestion, docs/47) and `modules/connectors` (canonical order/product import). It **never joins
the sales/customer tables directly** (bounded-context rule 3): external signals are pushed IN via explicit
ingest endpoints (the warehouse staging pattern), and the model reads only MMM-owned tables. Registered in
`sales-crm-domain.module.ts` alongside marketing + reputation.

## 2. Schema (migration `0403`)

Staging → core → analytics, all in `public`, all tenant-scoped:

- **`mmm_social_raw_feeds`** (staging) — append-only raw platform payloads (`platform`, `raw_payload jsonb`,
  `extracted_at`), kept for replay/re-derivation.
- **`mmm_sales_daily`** (staging) — per-channel daily sales grain (`biz_date`, `product_sku`, `revenue`,
  `units_sold`, `utm_source`, `promo_code`). Dimension-key columns are `NOT NULL DEFAULT ''` so the composite
  unique index + idempotent upsert are stable across PGlite/Postgres.
- **`mmm_sentiment_trends`** (core) — cleaned daily sentiment (`platform`, `keyword_or_topic`,
  `mention_count`, `sentiment_score` with a DB `CHECK` in `[-1, 1]`).
- **`mmm_customer_behavior`** (core) — derived per-customer roll-up keyed by `customer_no`.
- **`mmm_model_runs`** (analytics) — one audited run: `window_days`, `total_spend`, `spend_by_channel jsonb`,
  `created_by`, `created_at`, `run_no` (`MMM-YYYYMMDD-NNN`).
- **`mmm_channel_results`** (analytics) — per-channel output (`spend`, `attributed_revenue`, `roi`,
  `sales_lift_contribution`, `optimal_budget_allocation`) referencing the run.

All six get the canonical org-scoped `tenant_isolation` policy + a leading tenant index in the same
migration (auto-satisfying the `pg-core` RLS assertion + the `tenant-idx` gate).

## 3. The model (v1 heuristic — deliberately transparent)

`mmm-model.ts` `computeMmm()` is a **pure, deterministic, unit-tested** function — an explicit v1 lift-share
attribution, **not** an econometric marketing-mix regression (adstock/saturation/Bayesian priors):

1. `contribution = attributed_revenue × (1 + boost)`, where `boost ∈ [0, 0.25]` scales with the channel's
   positive-buzz signal (`Σ mention_count × max(0, sentiment_score)`) relative to the strongest channel.
2. `roi = contribution ÷ spend` — **null (not Infinity)** when spend is 0.
3. `sales_lift_contribution` = the channel's share of total contribution (%, sums to 100).
4. `optimal_budget_allocation` = the total spend split proportional to ROI efficiency (equal-split fallback
   when no channel has a positive ROI), rounded to sum **exactly** to the total.

Swapping in a real regression later means replacing this one function — ingest/persistence/BI are
model-agnostic.

## 4. API (gated `marketing`/`exec` throughout)

- Ingest: `POST /api/mmm/ingest/{social-feed|sales-daily|sentiment|customer-behavior}` (idempotent upserts).
- Model: `POST /api/mmm/run` (`{ windowDays?, spendByChannel? }`), `GET /api/mmm/runs`,
  `GET /api/mmm/runs/:runNo` (BOLA-safe — filtered by tenant AND run_no), `GET /api/mmm/summary`.
- Reads: `GET /api/mmm/sales-daily`, `GET /api/mmm/sentiment`.
- BI (docs/46 registry): report types **`mmm_run`** (scheduled refresh action job) + **`mmm_summary`**
  (dashboard aggregate), plus the live read `GET /api/bi/mmm-summary` (same shape as `marketing_roi` /
  `reputation-summary`).

## 5. Control & risk impact

New RCM control **MKT-15** (marketing-mix modeling): every run persists an auditable header (inputs + actor
+ timestamp) so a budget recommendation is reproducible; the attribution is pure/deterministic/unit-tested;
all six tables are tenant-scoped (RLS + explicit filter). It is an analytical **read** model — no GL posting.
Marked **Partial** in the RCM: the math is unit-tested and RLS is hard-asserted generically by `pg-core`, but
the dedicated end-to-end ToE harness (cross-tenant boundary + audit-trail re-performance) is phase 2.

## 6. Delivery

- **This PR (backend + docs):** `schema/mmm.ts`, migration `0403` (+ journal), `modules/mmm` (ingest / model
  / reads / BI / controller), BI registry + live read wiring, `test/mmm-model.test.ts`, RCM control **MKT-15**
  + regenerated xlsx + census, narrative **PN-19 §7 item 39** + control-matrix row + revision history, UAT.
- **Phase 2 (follow-up):** a `/mmm` web workspace (Signals / Model / Recommendation tabs), a dedicated
  `cutover/mmm.ts` ToE harness (cross-tenant boundary + audit-trail), and — if a real modeler is wanted — a
  regression backend behind the same `computeMmm` seam.
