# 61 — Marketing Activation: 5 fact-driven, sales-driving tools on the CRM × Marketing-Intelligence spine

> **Date:** 2026-07-22 · **Status:** v0.6 — **DELIVERED** (Phases 0–5, all five tools shipped) · **Owner:** Marketing/Analytics
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

### ① AI Campaign Studio — fact-grounded generative campaigns — **DELIVERED** (Phase 4, MKT-21)
**Shipped.** `modules/marketing-activation/campaign-studio.service.ts` + the pure `campaign-studio.ts` (`test/campaign-studio.test.ts`, 8): `GET /studio/generate/:segment` returns a fact-grounded bilingual draft + a retrieval-grounded prompt (facts in, not hallucinated) + model card, `POST /studio/stage` creates a consent-gated campaign DRAFT + logs the model card to `mi_campaign_generations` (migration 0472), `GET /studio/generations`. Draft-only — the send stays the existing consent-gated maker-checker flow. Deterministic generator — and **Studio v2 (v0.9) delivered the live-LLM swap** behind the same fact sheet + prompt (DPA/PDPA-gated, copy-only zod validation, fail-closed to the template, real model id on the model card) plus the ③→① `top_offer` hook (`PropensityService.topSegmentOffer`). ToE `cutover/ext.ts` +7, then MKT-21 7→8 in v0.9 (397); RCM 310→311.
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

### ② Next-Best-Action Orchestrator — per-customer journeys — **DELIVERED** (Phase 3, MKT-22)
**Shipped.** `modules/marketing-activation/nba-orchestrator.service.ts` + the pure `nba-scoring.ts` (`test/nba-scoring.test.ts`, 13): `GET /nba/preview` ranks by expected value + applies consent/recent-purchase/no-action suppression, `POST /nba/stage` persists a Pending `mi_journeys`/`mi_journey_targets` (fixed MKT-19 holdout arm, migration 0471), `POST /nba/activate` maker-checker → a consent-gated draft for the treatment arm only. Nothing auto-sends. ToE `cutover/ext.ts` +8 (380); RCM 309→310. **v0.10 closed the loop:** activation stamps `measure_after`; `POST /nba/measure` computes the REALIZED treatment-vs-control lift on real POS revenue (shared `common/lift-math.ts`) and stores it on the journey — fail-closed without a control arm.
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

### ④ Churn-Save Autopilot — proactive retention, provable — **DELIVERED** (Phase 5, MKT-24)
**Shipped.** `modules/marketing-activation/save-autopilot.service.ts` + the pure `save-offer.ts` (`test/save-offer.test.ts`, 8): a maker-checker save-offer policy (`POST /save/policy` → `POST /save/policy/approve`, hard offer cap enforced in the core), a sweep (`GET /save/preview`, `POST /save/run`) of at-risk/consented customers → capped offers + MKT-19 holdout + a retention P&L (`mi_save_policies`/`mi_save_runs`, migration 0473). Consent-gated draft for the treatment arm only — nothing auto-sends. ToE `cutover/ext.ts` +9 (396); RCM 311→312. **v0.10 closed the loop:** `stageRun` persists BOTH holdout arms (`mi_save_targets`, migration 0476) and `POST /save/measure` turns the EXPECTED P&L into a REALIZED one (saved = treatment-vs-control incremental on real POS revenue; net = saved − offer cost).
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
measure every one → the realised lift feeds back into ⑤.** *(v0.10: literally true — journeys (②) and save runs (④) now measure realized treatment-vs-control lift on real POS revenue, and ⑤'s `liftBySegment` unions measured lift from experiments + journeys + save runs.)*
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
| v0.6 | 2026-07-23 | **Phase 4 — ① AI Campaign Studio DELIVERED (new control MKT-21, migration `0472`).** `modules/marketing-activation`: `campaign-studio.service.ts` (generate/stage/list; fact sheet from the Fact Layer + a `customer_profiles` modal-hour aggregation; consent-gated draft via CampaignsService; model card logged) + the pure deterministic `campaign-studio.ts` (`test/campaign-studio.test.ts`, 8). `GET /studio/generate/:segment` returns a fact-grounded bilingual draft + a retrieval-grounded prompt (facts in, not hallucinated) + the model card; `POST /studio/stage` creates a consent-gated campaign DRAFT (never auto-sent — the send stays the existing consent-gated maker-checker flow) + logs the model card to `mi_campaign_generations` (migration `0472`, canonical RLS + tenant index). PN-19 §7 item 49 + §9 row 49 + rev 1.68; UAT-RPT-068 + traceability v8.18; RCM 310/307 → 311/308. ToE `cutover/ext.ts` **+7** (all 387 pass); RLS-coverage + tenant-idx gates green. |
| v0.10 | 2026-07-23 | **Measurement loop CLOSED — realized outcomes for ② journeys + ④ save runs (MKT-22/24 strengthened, no new control, census unchanged; migration `0476`).** The MKT-19 discipline extended to every activation surface: `POST /nba/measure` + `POST /save/measure` (`marketing`/`exec`) compute treatment-vs-control REAL POS revenue via `CrmService.revenueByMembers` + the NEW shared pure `common/lift-math.ts` `measureLift` (extracted from MKT-19's inline math; `test/lift-math.test.ts` 6). Journeys: activation stamps `measure_after` (default 14d, `window_days` 1..90); realized lift + incremental revenue land on `mi_journeys`. Save runs: `stageRun` persists BOTH holdout arms to the new `mi_save_targets` (canonical RLS + tenant index) and measurement stores the realized retention P&L (`realized_net_benefit` = saved − offer cost) on `mi_save_runs`. Fail-closed: `ALREADY_MEASURED`/`WINDOW_NOT_ELAPSED`/`NO_CONTROL`/`NO_TARGETS_RECORDED`/`JOURNEY_NOT_ACTIVE`. ⑤'s `liftBySegment` unions measured lift from experiments + journeys + save runs (latest per segment) — the loop sentence is now literally true. Web: วัดผล actions + realized-lift / พิสูจน์แล้ว chips. ToE `ext.ts` +13 (410). PN-19 rev 1.72; manual 09 v0.16; UAT-MA-22b/24b + UAT 09 v3.8; traceability v8.25. |
| v0.9 | 2026-07-23 | **Studio v2 DELIVERED — the live-LLM swap + the ③→① `top_offer` hook (MKT-21 unchanged; no endpoint/permission/migration change, census unchanged).** `CampaignStudioService.llmCopy` puts a real model behind the SAME fact sheet + retrieval-grounded prompt via the shared `common/llm-client` seam (`modelFor('campaign_studio')`, reasoning tier, `ANTHROPIC_MODEL`-pinnable): platform-DPA-gated (`aiDpaBlocked`), tenant-PDPA-gated (`aiTenantOptedOut` / `ai_external_processing`), STRICT zod-validated (subject/body th+en ONLY — channel/send-hour/reach/holdout/audience stay deterministic from the facts), **fail-closed to the deterministic template** on no-key/opt-out/malformed/error; the `model` on the response + the `mi_campaign_generations` model card records the path that actually wrote the copy (real id vs `studio-template-v1`). The reserved `segmentFacts.top_offer` now carries the segment's top un-bought product — `PropensityService.topSegmentOffer` → pure `rankSegmentOffer` (majority-owned staples excluded, reach-weighted confidence×lift×margin) — woven into the prompt + offer copy. Web: เขียนโดย AI / แม่แบบมาตรฐาน badge on the draft + generations chips. ToE: `test/campaign-studio-llm.test.ts` (6, via `setLlmClientForTests`) + `test/propensity-scoring.test.ts` +6 (17); `cutover/ext.ts` MKT-21 7→8 (all **397** pass — the keyless CI run itself proves the fail-closed path). PN-19 rev 1.71; manual 09 v0.15; UAT-MA-21b + UAT 09 v3.7 + traceability v8.23. |
| v0.8 | 2026-07-23 | **Web workspace DELIVERED (web-only; no control/migration change).** `/marketing-activation` — one soft "Marketing Studio" page (theme-token pastels via `color-mix`, light+dark) with six tabs over the five tools: overview counters + tool cards + trust card; ③ cross-sell lookup; ⑤ segment×channel ranking staged via the MKT-17 maker-checker plan; ② NBA preview/stage/activate with recorded suppression + SoD toast; ① AI drafts with the collapsible prompt/model card; ④ churn-save policy (hard-cap field)/preview (**ชนเพดาน** chips + retention P&L)/runs. **No ฿ on the marketing family** — new `thb()`/`compactThb()` ("48,000 THB"), `/marketing-intel` converted in the same pass. Plain client page + directive-free tab islands (use-client 290→291, noted); i18n `ma.*` fragment th+en; nav entry under วางแผน & BI. ToE: e2e `marketing-activation.spec.ts` (endpoint fixtures, staged-POST capture, no-฿ assertion) + `.mobile.spec.ts` (per-tab no-overflow at iPhone-13). PN-19 rev 1.70; manual 09 §5g (v0.14); UAT-UI-MA-01 + traceability v8.21; RCM census unchanged. |
| v0.7 | 2026-07-23 | **Phase 5 — ④ Churn-Save Autopilot DELIVERED (new control MKT-24, migration `0473`) — docs/61 five-tool roadmap COMPLETE.** `modules/marketing-activation`: `save-autopilot.service.ts` (stagePolicy/approvePolicy maker-checker; preview/stageRun retention P&L composing `customer_profiles` + `pos_members` reads — no cross-domain join) + the pure deterministic `save-offer.ts` (`test/save-offer.test.ts`, 8; the offer cap enforced here). A maker-checker save-offer policy (hard offer cap; approver ≠ requester → SOD_SELF_APPROVAL; NO_ACTIVE_POLICY / INVALID_OFFER_CAP guards), a sweep of at-risk/consented customers → capped offers + an MKT-19 holdout (control gets no offer) + a retention P&L; consent-gated draft for the treatment arm only (nothing auto-sends). New tables `mi_save_policies` + `mi_save_runs` (migration `0473`, canonical RLS + tenant indexes). PN-19 §7 item 50 + §9 row 50 + rev 1.69; UAT-RPT-069 + traceability v8.19; RCM 311/308 → 312/309. ToE `cutover/ext.ts` **+9** (all 396 pass); RLS-coverage + tenant-idx gates green. **All five tools (①–⑤) + the shared Fact Layer now delivered — controls MKT-21..25.** |
| v0.5 | 2026-07-23 | **Phase 3 — ② NBA Orchestrator DELIVERED (new control MKT-22, migration `0471`).** `modules/marketing-activation`: `nba-orchestrator.service.ts` (preview/stage/activate composing `customer_profiles` + `pos_members` reads — no cross-domain join) + the pure deterministic `nba-scoring.ts` (`test/nba-scoring.test.ts`, 13). Picks the highest expected-value action per customer (CLV × action uplift, churn-weighted), applies fatigue cap + consent + recent-purchase suppression (server-side, recorded), tags a fixed MKT-19 holdout arm. Staged Pending `mi_journeys`/`mi_journey_targets` (migration `0471`, canonical RLS + tenant indexes); activation is maker-checker (approver ≠ requester → SOD_SELF_APPROVAL) and creates a consent-gated draft for the treatment arm only (control never contacted, nothing auto-sends). PN-19 §7 item 48 + §9 row 48 + rev 1.67; UAT-RPT-067 + traceability v8.17; RCM 309/306 → 310/307. ToE `cutover/ext.ts` **+8** (all 380 pass); RLS-coverage + tenant-idx gates green. |
| v0.4 | 2026-07-23 | **Phase 2 — ⑤ Segment × Channel ROI DELIVERED (new control MKT-25, no migration).** `modules/marketing-activation`: `segment-channel-roi.service.ts` (rank composing the pushed MMM channel ROI + a `customer_profiles` segment aggregation + MKT-19 measured lift via owning-module reads — no cross-domain join) + the pure deterministic `segment-channel-scoring.ts` (`test/segment-channel-scoring.test.ts`, 9). `GET /api/marketing-activation/segment-channel-roi?budget=` ranks segment × channel cells by incremental ROI × value + splits the budget; `POST /segment-channel-roi/stage` stages a Pending `mi_budget_plans` row reusing the MKT-17 maker-checker (approver ≠ requester → SOD_SELF_APPROVAL) — no new spend path, no new SoD code. Advisory read (never posts spend); tenant-scoped (403). PN-19 §7 item 47 + §9 row 47 + rev 1.66; UAT-RPT-066 + traceability v8.16; RCM 308/305 → 309/306. ToE `cutover/ext.ts` **+6** (all 373 pass). |
| v0.3 | 2026-07-23 | **Phase 1 — ③ Propensity & Cross-Sell DELIVERED (new control MKT-23, no migration).** `modules/marketing-activation`: `propensity.service.ts` (nextBestOffers/bestAudiences composing the analytics menu-affinity engine + the Fact Layer + the menu food-cost margin via their public reads — no cross-domain join) + the pure deterministic `propensity-scoring.ts` (`test/propensity-scoring.test.ts`, 11). `GET /api/marketing-activation/propensity/customer/:code` ranks the next product to offer (excluding what the customer already buys, scored confidence × lift × margin) + `GET /propensity/item/:itemId` ranks the best audiences (reach × CLV). Advisory read-only — never contacts/spends; the sole contact path stays the consent-gated draft. Tenant-scoped (404) + permission-gated (403). PN-19 §7 item 46 + §9 row 46 + rev 1.65; UAT-RPT-065 + traceability v8.15; RCM 307/304 → 308/305. ToE `cutover/ext.ts` **+6** (all 367 pass). |
| v0.2 | 2026-07-22 | **Phase 0 — Marketing Fact Layer DELIVERED.** New `modules/marketing-activation` (`fact-layer.service.ts` + controller + module, wired into `sales-crm-domain.module.ts`): read-only `GET /api/marketing-activation/facts/customer/:code` + `GET /api/marketing-activation/facts/segment/:segment` (`marketing`/`exec`), composing `customer_profiles` (`mi_*` CLV/churn/NBA) + `pos_members` (identity, tier, `marketing_opt_in`) in separate queries (no cross-domain join) and the pushed MMM channel-ROI via `MarketingIntelService.getSummary`. No migration, no GL, no new RCM control (reuses tenant isolation). ToE: `cutover/ext.ts` **+5** (customer fact sheet, 404 CUSTOMER_NOT_FOUND, segment roll-up with dominant NBA + best channel, tenant-scoped 404, 403 for a non-marketing principal) — all 361 pass. |
| v0.1 | 2026-07-22 | Initial 5-tool activation roadmap + shared Fact Layer (③ propensity · ⑤ segment-ROI · ② NBA orchestrator · ① AI campaign studio · ④ churn-save), controls MKT-21..25. |
