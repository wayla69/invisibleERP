# 61 — Marketing Activation: 5 fact-driven, sales-driving tools on the CRM × Marketing-Intelligence spine

> **Date:** 2026-07-22 · **Status:** v0.1 — PLAN (phased; not yet built) · **Owner:** Marketing/Analytics
>
> Builds on the delivered **CRM** (`modules/crm`, `customer_profiles`, loyalty, consent-gated campaigns) and
> **Marketing Intelligence** stack (docs/48 MMM push-back; **docs/60** depth — Budget Optimizer MKT-17,
> Customer Intelligence MKT-18, Closed-loop Measurement MKT-19, Model Governance MKT-20; the external
> `marketing-intelligence-platform/`). Those layers made the ERP **descriptive → prescriptive → measured**.
> This plan turns those signals into **activation** — five tools that combine CRM facts with MI outputs to
> **drive sales on evidence**, every one of them consent-gated, maker-checker-staged, and holdout-measured.

## Why this, why now
The data to act on already exists — it is just not yet **orchestrated into revenue actions**:

| Layer | Facts already captured (per customer / per segment) |
|---|---|
| CRM `customer_profiles` | RFM (recency/frequency/monetary), `rfm_segment`, `mi_rfm_segment`, explainable `churn_risk` + `predicted_ltv`, platform **`mi_clv` / `mi_churn_risk` / `mi_nba`**, `preferred_channel`, `preferred_hour`, `favorite_item_ids`, `total_spend`, `visit_count`, recency |
| POS (`dine_in_orders`/items, `cust_pos_*`) | purchase history, basket contents, product margin, business-day timing |
| Marketing Intelligence | MMM channel ROI + **response curves** (MKT-17), sentiment-weighted RFM, TOWS, social sentiment |
| Campaigns / experiments | PDPA per-purpose `member_consents`, delivery outcomes (`message_log`), **measured incrementality/lift** (MKT-19), model governance (MKT-20) |
| AI | in-app copilot / agent (`modules/ai/agent.service.ts`), menu-affinity association rules (`modules/analytics`) |

The gap is a **unified fact view + five action tools** that read it. That is this plan.

---

## Guiding architecture (do not violate — inherited from docs/60)
- **Bounded context.** New activation logic lives in its own module cluster — a `modules/marketing-activation`
  sibling (or sub-services under `modules/marketing-intel`), each tool its **own sub-service** kept under the
  `check-service-size` 600-LOC cap. Heavy modelling stays in the external Python platform.
- **Database isolation.** No cross-domain SQL joins. POS/market-basket/sales reads go through the owning
  module's read API (the `CrmService.revenueByMembers` pattern from MKT-19) or an event — never a raw join.
- **Consent-gated delivery reuse.** Every customer contact reuses the existing CRM audience + `member_consents`
  + channel-adapter delivery. No new send path is ever added.
- **Spend/contact actions are controlled.** Anything that can move money or message a customer is
  **draft/staged** and passes **maker-checker** (a human ≠ the requester approves). No auto-blast, no
  auto-spend. AI output is **always a draft a human edits and sends**.
- **Everything is measured.** Any activation can be attached to a **randomised holdout** (reuse MKT-19) so its
  incremental revenue is provable, not asserted.
- **Doc-sync is part of done** (narrative PN-19 + user manual + UAT + RCM) for every tool.

---

## Foundation — the Marketing Fact Layer (shared, read-only) — **DELIVERED** (Phase 0)
A single read-only aggregator (`modules/marketing-activation/fact-layer.service.ts`) that assembles, per
customer and per segment, the facts above **through owning-module read APIs** (no joins) into one
governed shape every tool consumes. It computes nothing new — it *composes* existing signals — so all five
tools speak the same facts and never drift out of sync. Endpoints: `GET …/facts/customer/:code`,
`GET …/facts/segment/:segment` (`@Permissions('marketing','exec')`). Tenant-scoped (RLS) — reads
`customer_profiles` (the marketing-intel `mi_*` scores) + `pos_members` in **separate** queries (no
cross-domain SQL join, arch rule 3) and reuses `MarketingIntelService.getSummary` for the pushed MMM
channel-ROI. A pure read model — no migration, no GL, no contact, no new RCM control (it reuses the
existing tenant-isolation controls); the `marketing_opt_in` fact is surfaced so every tool that layers on
top can honour consent. Built first; the tools layer on top. ToE: `cutover/ext.ts` (+5 checks).

---

## The five tools

### ① AI Campaign Studio — fact-grounded generative campaigns
**Goal.** *"Generate a campaign that will actually sell — for the right people, on the right channel, at the
right time, in the right words."*
**Combines.** A **fact sheet** for a chosen micro-segment (size, avg CLV, dominant `mi_nba`, top *un-bought*
products from Tool ③, best channel by MMM ROI, best send-hour from `preferred_hour`, sentiment tone from
TOWS) → fed to the in-app AI (`modules/ai`) as **retrieval-grounded context** (facts in the prompt, not
hallucinated).
**What it does.** Drafts the full campaign — audience, channel, send-time, offer, and **th/en copy** — plus a
predicted reach/response and an **auto-suggested holdout**. Output is a **draft** campaign (consent-gated,
maker-checker); the fact sheet + prompt + model version are **logged** (MKT-20-style model card).
**Drives sales.** Right message × right people × right channel × right time — from facts, measurably.
**Reuses.** `modules/ai` copilot, consent-gated campaigns, MKT-19 holdout, MKT-20 governance.
**Control.** **MKT-21** — AI output is advisory/draft-only; contact stays consent-gated; the generation is
governed + logged (prompt, facts, model, approver ≠ requester on send).

### ② Next-Best-Action Orchestrator — per-customer journeys
**Goal.** Turn the *advisory* `mi_nba` into **sequenced, prioritised action** per customer.
**Combines.** `mi_nba` + `mi_churn_risk` + `mi_clv` + `preferred_channel` + consent + loyalty state.
**What it does.** For each customer, pick the single highest **expected-value** action now (CLV × action
uplift), assemble a short journey, apply **fatigue caps + consent suppression + recent-purchase suppression**,
and route each step as a consent-gated scheduled draft. Every step is tagged to a holdout for lift.
**Drives sales.** Proactive, personalised, prioritised by money — not blast-everyone.
**Reuses.** Fact Layer, consent-gated delivery, MKT-19 holdout.
**Control.** **MKT-22** — a journey is **staged** and requires maker-checker activation; suppression + consent
are enforced server-side; nothing auto-sends.

### ③ Propensity & Cross-Sell Targeting — market-basket × CLV — **DELIVERED** (Phase 1, MKT-23)
**Goal.** *"Who should we sell what to next?"* — fact-ranked, not guessed.
**Shipped.** `modules/marketing-activation/propensity.service.ts` + the pure `propensity-scoring.ts` (unit-tested `test/propensity-scoring.test.ts`, 11): `GET /api/marketing-activation/propensity/customer/:code` (next product to offer, excluding owned, confidence × lift × margin) + `GET /propensity/item/:itemId` (best audiences by reach × CLV). Advisory read-only; contact stays the consent-gated draft. ToE `cutover/ext.ts` +6 (367); RCM 307→308.
**Combines.** Association rules (support / confidence / **lift** — extend the existing menu-affinity engine)
over real co-purchase (`dine_in_orders`/items via the owning read API) + per-customer `favorite_item_ids`
+ CLV + margin.
**What it does.** Per customer → a ranked **"next product to offer"** (items they are most likely to buy next,
*excluding* what they already buy, weighted by CLV × margin). Per product → **"best audiences to push it to."**
Feeds ① and ② the concrete offer.
**Drives sales.** Evidence-based cross-sell / upsell (lift-ranked) instead of guessing.
**Reuses.** Analytics menu-affinity, Fact Layer.
**Control.** **MKT-23** — advisory scoring only; any resulting contact goes through the consent-gated draft.

### ④ Churn-Save Autopilot — proactive retention, provable
**Goal.** Protect the base — the cheapest growth — and **prove** the saved revenue.
**Combines.** rising `mi_churn_risk` / `churn_risk` + CLV + recency + `preferred_channel` + margin.
**What it does.** Sweep customers crossing a churn threshold **whose CLV justifies a save**; draft a **tiered
win-back** offer (size scaled to CLV × margin, **capped**), consent-gated, **always against a randomised
holdout**; produce a **"retention P&L"** — saved revenue vs offer cost.
**Drives sales.** Retains revenue that would otherwise churn, with a measured ROI.
**Reuses.** Fact Layer, MKT-19 holdout/lift, consent-gated delivery.
**Control.** **MKT-24** — an **offer cap** + maker-checker on the save-offer policy; holdout integrity
(reuses MKT-19); no auto-send.

### ⑤ Segment×Channel ROI Command — fact-based budget → who/where — **DELIVERED** (Phase 2, MKT-25)
**DELIVERED** (Phase 2, MKT-25). `modules/marketing-activation/segment-channel-roi.service.ts` + the pure `segment-channel-scoring.ts` (`test/segment-channel-scoring.test.ts`, 9): `GET /api/marketing-activation/segment-channel-roi?budget=` ranks cells by incremental ROI (channel ROI × MKT-19 measured-lift multiplier) × value (reach × CLV) + splits the budget; `POST /segment-channel-roi/stage` stages a Pending `mi_budget_plans` row reusing the MKT-17 maker-checker. Advisory read (never posts spend); tenant-scoped. ToE `cutover/ext.ts` +6 (373); RCM 308→309. *(offer-level cells + `message_log` outcomes are a later refinement; the segment×channel spine is live.)*
**Goal.** Extend the Budget Optimizer (MKT-17) from *channel* to **segment × channel × offer**.
**Combines.** MMM response curves (MKT-17) + per-segment CLV/size + campaign outcomes (`message_log`) +
**measured lift** (MKT-19) + margin.
**What it does.** Rank **segment × channel × offer** cells by incremental ROI (real Phase-3 lift where it
exists, MMM curves where it does not) → *"spend the next ฿X here."* Stages a **maker-checker budget plan**
(reuse `mi_budget_plans`).
**Drives sales.** Puts money where the facts say returns are highest — closing the MMM ↔ CRM loop.
**Reuses.** MKT-17 optimiser + budget plans, MKT-19 lift, Fact Layer.
**Control.** **MKT-25** — advisory + maker-checker budget plan (reuses the MKT-17 SoD path).

---

## How they connect — one closed loop
**⑤ decides *where* the budget goes → ③ decides *what* to offer *whom* → ② orchestrates the per-customer
*sequence/when* → ① writes the *creative* with AI → ④ specialises it for *retention* → MKT-19 holdouts
measure every one → the realised lift feeds back into ⑤.**
Descriptive → prescriptive → **generative** → measured → re-allocated.

---

## Sequencing & sizing
| Phase | Delivers | Depends on | Rough size |
|---|---|---|---|
| **0 — Fact Layer** | shared read-only CRM×MI fact aggregator (`facts/customer`, `facts/segment`) | docs/60 | 1 PR |
| **1 — ③ Propensity/Cross-Sell (MKT-23)** | next-product-to-offer + best-audience (the *offer* every tool needs) | Fact Layer | 1 PR |
| **2 — ⑤ Segment×Channel ROI (MKT-25)** | fact-ranked budget→cell + staged plan | Fact Layer, MKT-17/19 | 1 PR |
| **3 — ② NBA Orchestrator (MKT-22)** | prioritised per-customer journeys, holdout-tagged | Fact Layer, ③ | 1 PR |
| **4 — ① AI Campaign Studio (MKT-21)** | AI-drafted, fact-grounded, consent-gated campaigns | Fact Layer, ③, `modules/ai` | 1 PR |
| **5 — ④ Churn-Save Autopilot (MKT-24)** | proactive retention + retention P&L, holdout-measured | Fact Layer, MKT-19 | 1 PR |

Each phase is independently shippable and doc-synced. Order puts the *offer* (③) and the *money* (⑤) first,
then the *orchestration* (②), *creative* (①), and the *retention specialisation* (④).

## Non-goals (explicit)
- No new customer-contact channel or send path — always the existing consent-gated delivery.
- No auto-spend / auto-blast — every money- or contact-driving action is draft/staged + maker-checker.
- No cross-domain DB joins — POS/sales/basket reads go through the owning module's read API/event.
- No moving heavy models into the ERP — the platform models; the ERP owns the data it displays + acts on.
- AI never sends — it only drafts what a human reviews, edits, and sends.

## Controls / ToE summary
New controls **MKT-21..25** (one per tool). ToE via the `ext`/`analytics` cutover harnesses: fact-layer
tenant isolation; propensity lift math on a seeded basket; ROI ranking respects constraints; NBA suppression
+ consent enforced; churn-save offer cap + holdout integrity; AI output is draft-only + governed. Doc-sync:
PN-19 (+ PN-29 if a public surface is added) + user manual + UAT + RCM per tool.

## Revision history
| Version | Date | Change |
|---|---|---|
| v0.4 | 2026-07-23 | **Phase 2 — ⑤ Segment × Channel ROI DELIVERED (new control MKT-25, no migration).** `modules/marketing-activation`: `segment-channel-roi.service.ts` (rank composing the pushed MMM channel ROI + a `customer_profiles` segment aggregation + MKT-19 measured lift via owning-module reads — no cross-domain join) + the pure deterministic `segment-channel-scoring.ts` (`test/segment-channel-scoring.test.ts`, 9). `GET /api/marketing-activation/segment-channel-roi?budget=` ranks segment × channel cells by incremental ROI × value + splits the budget; `POST /segment-channel-roi/stage` stages a Pending `mi_budget_plans` row reusing the MKT-17 maker-checker (approver ≠ requester → SOD_SELF_APPROVAL) — no new spend path, no new SoD code. Advisory read (never posts spend); tenant-scoped (403). PN-19 §7 item 47 + §9 row 47 + rev 1.66; UAT-RPT-066 + traceability v8.16; RCM 308/305 → 309/306. ToE `cutover/ext.ts` **+6** (all 373 pass). |
| v0.3 | 2026-07-23 | **Phase 1 — ③ Propensity & Cross-Sell DELIVERED (new control MKT-23, no migration).** `modules/marketing-activation`: `propensity.service.ts` (nextBestOffers/bestAudiences composing the analytics menu-affinity engine + the Fact Layer + the menu food-cost margin via their public reads — no cross-domain join) + the pure deterministic `propensity-scoring.ts` (`test/propensity-scoring.test.ts`, 11). `GET /api/marketing-activation/propensity/customer/:code` ranks the next product to offer (excluding what the customer already buys, scored confidence × lift × margin) + `GET /propensity/item/:itemId` ranks the best audiences (reach × CLV). Advisory read-only — never contacts/spends; the sole contact path stays the consent-gated draft. Tenant-scoped (404) + permission-gated (403). PN-19 §7 item 46 + §9 row 46 + rev 1.65; UAT-RPT-065 + traceability v8.15; RCM 307/304 → 308/305. ToE `cutover/ext.ts` **+6** (all 367 pass). |
| v0.2 | 2026-07-22 | **Phase 0 — Marketing Fact Layer DELIVERED.** New `modules/marketing-activation` (`fact-layer.service.ts` + controller + module, wired into `sales-crm-domain.module.ts`): read-only `GET /api/marketing-activation/facts/customer/:code` + `GET /api/marketing-activation/facts/segment/:segment` (`marketing`/`exec`), composing `customer_profiles` (`mi_*` CLV/churn/NBA) + `pos_members` (identity, tier, `marketing_opt_in`) in separate queries (no cross-domain join) and the pushed MMM channel-ROI via `MarketingIntelService.getSummary`. No migration, no GL, no new RCM control (reuses tenant isolation). ToE: `cutover/ext.ts` **+5** (customer fact sheet, 404 CUSTOMER_NOT_FOUND, segment roll-up with dominant NBA + best channel, tenant-scoped 404, 403 for a non-marketing principal) — all 361 pass. |
| v0.1 | 2026-07-22 | Initial 5-tool activation roadmap + shared Fact Layer (③ propensity · ⑤ segment-ROI · ② NBA orchestrator · ① AI campaign studio · ④ churn-save), controls MKT-21..25. |
