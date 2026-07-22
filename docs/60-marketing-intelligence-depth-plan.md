# 60 — Marketing Intelligence: Depth Roadmap (prescriptive → closed-loop → governed)

> **Date:** 2026-07-22 · **Status:** v0.1 — PLAN (phased; not yet built) · **Owner:** Marketing/Analytics
>
> Builds on the delivered **Marketing Intelligence push-back platform** (docs/48 MMM pipeline; PN-29;
> `modules/marketing-intel`; the external `marketing-intelligence-platform/`). Today the `/marketing-intel`
> page is **descriptive** — it shows the MMM / Sentiment-Weighted RFM / TOWS results the external Python
> platform computes and pushes into the ERP (`POST /api/v1/analytics/snapshots` → `mi_analytics_snapshots`),
> plus a first action loop (activate a segment → **draft** campaign). This roadmap deepens it in four phases:
> **describe → prescribe → measure → govern.**

## Guiding architecture (do not violate)

- **Bounded context.** All new ERP logic lives in `modules/marketing-intel` (its own sub-services as it
  grows — never grow the facade past the `check-service-size` cap). Heavy modelling stays in the external
  `marketing-intelligence-platform/` (Python).
- **Database isolation (push-back only).** The ERP never reaches into the platform's warehouse and never
  cross-joins another domain's tables. The platform **pushes** results in; cross-domain reads (POS sales for
  measurement) go through an owning-module read API / event, never a raw join.
- **Consent-gated delivery reuse.** Any customer contact reuses the existing CRM audience + consent +
  channel-adapter delivery. This roadmap never adds a new send path.
- **Spend-driving actions are controlled.** Anything that can move money (a budget request, a campaign that
  will be sent) is **draft/staged** and passes maker-checker — a human, ≠ the requester, approves. No
  auto-blast, no auto-budget.
- **Doc-sync is part of done** (narrative + user manual + UAT + RCM) for every phase.

---

## Phase 1 — Budget Optimizer (prescriptive MMM) — *recommended first*

**Goal.** Turn "here is each channel's ROI" into "here is where your **next** baht should go." Answer
*"given a ฿X budget, what allocation maximises predicted sales, and what's the marginal return of one more
baht on each channel?"*

**Platform side (`marketing-intelligence-platform/services/analytics-engine`).**
- Extend the MMM fit to emit, per channel, a **saturation/response curve** (adstock + Hill/diminishing-
  returns parameters) alongside the existing contribution/ROI. These params make the response curve
  reconstructable anywhere without re-fitting.
- Add an **allocator** (`scipy.optimize`, constrained: total budget, per-channel min/max, integer step
  optional) that returns the optimal spend split + predicted sales/ROI. Emitted as a new snapshot `kind`
  (`mmm_response`) pushed via the existing `ErpClient`.

**ERP side (`modules/marketing-intel`).**
- Store the response-curve params on the MMM snapshot payload (append-only; no schema change beyond a JSON
  field the snapshot already carries). Add reads: `GET …/response-curves`, `POST …/simulate` (server
  evaluates a proposed allocation against the stored curve params — deterministic, no external call), and
  `POST …/optimize` (returns the platform's optimal split, or computes it ERP-side from the curve params for
  a quick answer).
- **Action:** `POST …/budget-plan/activate` stages a **budget request** (reason-coded, `pr_raise`/marketing)
  into the ERP budget module's existing maker-checker queue — never posts spend directly.

**Web (`/marketing-intel` → new "Budget Planner" tab).**
- Per-channel **response-curve charts** (spend → incremental sales, with the current spend marked).
- Interactive **allocation sliders** (total budget + per-channel), with **live predicted sales/ROI** computed
  client-side from the curve params (instant, no round-trip), plus an **"Optimise" button** that fills the
  optimal split. A "request this budget" button → the staged budget request.
- Reuses the pastel dashboard system; stays one `'use client'` island.

**Controls / ToE.** New detective/preventive control **MKT-17** (budget recommendations are advisory; the
budget request is maker-checker, requester ≠ approver). `ext` harness: response-curve push + `simulate`
determinism + `optimize` respects constraints + `budget-plan/activate` stages (not posts) + a non-approver
can't approve their own request. **Doc-sync:** PN-29 §budget-optimizer + user manual + UAT + RCM (MKT-17).

**Depends on:** nothing (foundational — Phases 3 reuse the response curves).

---

## Phase 2 — Customer Intelligence (CLV / Churn / Next-Best-Action)

**Goal.** Deepen RFM from "which segment" to "what is this customer worth, how likely to churn, and what to
do next."

**Platform side.** Alongside the per-customer RFM `members` already pushed, compute and push **predicted
CLV**, **churn probability**, and a **next-best-action** code per customer (e.g. `WINBACK`, `UPSELL`,
`VIP_CARE`, `REACTIVATE`). Model choice kept simple/interpretable first (BG/NBD + Gamma-Gamma for CLV; a
gradient-boosted churn classifier) — governed under Phase 4.

**ERP side.** Land the per-customer scores on `customer_profiles` (new nullable columns `mi_clv`,
`mi_churn_risk`, `mi_nba` + indexes; RLS already covers the table) — **separate** from any ERP-owned score,
mirroring how `mi_rfm_segment` stays distinct from `rfm_segment`. New reads: segment **drill-down**
(segment → customer list with scores) and a per-customer intelligence card.

**Web.** From an RFM segment card, drill into its customers (sortable by CLV/churn), each with its
next-best-action and a **one-click "create targeted campaign"** that pre-fills the audience + a suggested
offer — routed through the **existing consent-gated delivery** as a draft.

**Controls / ToE.** **MKT-18** (per-customer scores are advisory; any contact stays consent-gated + draft).
`ext`: scores land without clobbering ERP fields; drill-down is tenant-scoped; NBA campaign is a draft.
**Doc-sync:** PN-29 + manual + UAT + RCM (MKT-18).

**Depends on:** Phase 1 not required, but shares the snapshot/push plumbing.

---

## Phase 3 — Closed-loop Measurement (incrementality feedback)

**Goal.** Prove (and learn from) whether an activated campaign actually **caused** sales — and feed that back
so MMM/attribution improves over time. This is what makes the loop *closed*.

**ERP side.** When a `mi_segment` campaign is activated + sent, snapshot its **treatment recipients** and a
**randomised holdout control** (a slice of the eligible segment deliberately not contacted). After a
measurement window, compute **lift = treatment vs control** on real outcomes by reading POS/sales **through
the owning module's read API** (never a cross-domain join into `orders`/GL) — the incremental revenue
attributable to the campaign, with a confidence interval. Store the campaign **outcome**; expose a "Campaign
Performance / Incrementality" view.

**Platform side.** Push the measured outcomes back to the platform (a new outbound path or a pull) so the
next MMM fit can use realised campaign lift as a regressor — the descriptive→prescriptive→measured feedback
loop.

**Controls / ToE.** **MKT-19** (holdout integrity: control group is fixed at send time and never contacted;
outcome read is tenant-scoped and read-only). `ext`: holdout is deterministic + immutable; lift math on a
seeded fixture; the sales read uses the read API (no direct join — enforced by the import-boundary gate).
**Doc-sync:** PN-29 + manual + UAT + RCM (MKT-19).

**Depends on:** Phase 1 (campaigns to measure) + Phase 2 (targeted audiences). The POS/sales read contract
must exist as an API/event first.

---

## Phase 4 — Model Governance (SOX / ICFR-fit)

**Goal.** Because these models now **drive spend and customer contact**, put ITGC-grade governance around
them — the natural fit for the NASDAQ/ICFR posture.

**Scope.**
- **Maker-checker on spend-driving analytics.** A pushed snapshot that will inform a budget decision or a
  campaign must be **approved by a second person (≠ the pusher/requester)** before `activate`/`budget-plan`
  can consume it. Reuses the existing two-person `access_grant_exceptions`-style queue pattern.
- **Model cards.** Each pushed run carries metadata (model version, training window, key metrics, feature
  set) surfaced in-ERP — the auditable "what produced this recommendation."
- **Drift / quality monitoring.** Compare each new run's R²/segment distributions against the prior; flag
  material drift into the GOV-01 pending/attention center; block `activate` on a failed quality gate.
- **End-to-end audit trail.** `recommendation → action (budget/campaign) → outcome (Phase 3 lift)` linked and
  queryable — the ICFR evidence chain.

**Controls / ToE.** **MKT-20** (analytics-run approval + drift gate + model-card completeness). `ext`:
unapproved run can't drive `activate`; a drifted run is flagged + blocked; the audit chain links all three.
**Doc-sync:** PN-29 + manual + UAT + RCM (MKT-20) + `compliance/` readiness plan + control-test harness
`tools/cutover/src/compliance.ts`.

**Depends on:** wraps Phases 1–3 (governs their outputs).

---

## Sequencing & sizing

| Phase | Delivers | Depends on | Rough size |
|---|---|---|---|
| **1 — Budget Optimizer** | prescriptive allocation + what-if + staged budget request | — | 1 platform PR + 1–2 ERP PRs |
| **2 — Customer Intelligence** | CLV/churn/NBA + drill-down + targeted draft | shares plumbing | 1 platform + 1 ERP |
| **3 — Closed-loop** | holdout + lift + feedback to MMM | 1, 2, POS read API | 1 ERP + 1 platform |
| **4 — Governance** | approval + model cards + drift + audit chain | 1–3 | 1 ERP + compliance |

Each phase is independently shippable and doc-synced; land in order (1 → 2 → 3 → 4) so later phases build on
earlier data (response curves, per-customer scores, campaign outcomes).

## Non-goals (explicit)

- No new customer-contact channel or send path — always the existing consent-gated delivery.
- No auto-spend / auto-blast — every money- or contact-driving action is draft/staged + maker-checker.
- No cross-domain DB joins — POS/sales measurement reads go through the owning module's API/event.
- No moving the heavy models into the ERP — the ERP owns the data it displays; the platform models.

## Revision history

| Version | Date | Change |
|---|---|---|
| v0.1 | 2026-07-22 | Initial 4-phase depth roadmap (prescriptive · customer-intel · closed-loop · governance). |
