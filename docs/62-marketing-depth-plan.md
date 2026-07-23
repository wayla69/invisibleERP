# docs/62 — Marketing Depth: make the loop run itself, get smarter per cell, and be statistically honest

**Status: Phase 1 DELIVERED** · Owner: Platform · Builds on docs/47 (reputation), docs/48 (MMM), docs/60
(marketing-intel, MKT-17..20), docs/61 (activation, MKT-21..25 + realized measurement).

## Why

docs/61 closed the loop *decide → offer → orchestrate → write → retain → measure → re-allocate*: every lift
claim is backed by a holdout measured on real POS revenue. The remaining depth is operational and analytical:
the loop is hand-cranked (someone must remember to stage sweeps and measure elapsed windows), the budget
ranking stops at segment×channel (not the offer), an approved budget plan is never reconciled against what
was actually spent/returned, and a measured lift is a point estimate (n=2 reads like n=2,000). Three phases,
each independently shippable and doc-synced, none adding a new money/contact path.

## Phase 1 — Autopilot cadence + marketing action center — **DELIVERED**

**Goal.** The loop runs on a schedule; humans do only the human parts (activate, approve, review).

**Delivered.**
- **Three scheduled action jobs** riding the BI report scheduler (registry-first, `BiReportSource` provider
  `marketing-activation-bi-reports.ts`; discovered at boot — no bi-generate dispatcher/ctor change; failures
  alert via ITGC-OP-04 like every scheduled job):
  - `mkt_nba_autostage` — auto-STAGES an NBA journey (MKT-22). **One-in-flight idempotency**: while an
    auto-staged journey is Pending or Active-unmeasured, a re-run stages nothing and says why. `NO_TARGETS`
    is a graceful no-op. Filters: `segment`/`control_pct`/`channel`.
  - `mkt_save_autostage` — auto-STAGES a churn-save sweep (MKT-24) under the APPROVED policy; same
    one-in-flight rule over unmeasured auto runs; `NO_ACTIVE_POLICY`/`NO_AT_RISK_TARGETS` are reported as
    human nudges, never errors. Filters: `segment`/`control_pct`/`window_days`.
  - `mkt_measure_windows` — measures every journey/save run whose `measure_after` elapsed (control arm
    present), via the MKT-19-discipline measure paths; idempotent by construction (measured rows are
    filtered out). Realized lift keeps feeding ⑤ automatically.
  - **The jobs only ever act as the MAKER** — attribution `"<actor> (auto)"` (the B4 precedent) on
    `requested_by`/`measured_by`; activation (MKT-22) and approval (MKT-24/17) remain human maker-checker
    (`assertMakerChecker` compares exact usernames, so the scheduler can never satisfy its own approval).
- **GOV-01 queues** (auto-append to `GET /api/finance/approvals/pending`; no finance.service change):
  `marketing-activation-approval-queues.ts` — `mi_nba_journey` (MKT-22 awaiting activation), `mi_save_policy`
  (MKT-24 awaiting approval), `mkt_measure_due` (elapsed-unmeasured windows, the close_task_overdue shape);
  plus `mi_budget_plan` (MKT-17, Pending plans with their amount) added to the owning
  `marketing-intel-approval-queues.ts`.
- **Action center** — `GET /api/marketing-activation/action-center` (`marketing`/`exec`): the PMO-shaped
  "what needs me now" worklist (kind/severity/bilingual title/href) over measure-due (high), awaiting
  activation/approval incl. budget plans via the owning `MarketingIntelService.listBudgetPlans` read
  (medium), and a no-active-save-policy nudge (low). Surfaced as the **สิ่งที่รอคุณตอนนี้** card on the
  `/marketing-activation` overview (severity dots, deep-links to the owning tab; read-only — every act stays
  on its maker-checker route).
- **No new control, no migration, census unchanged.** ToE: `cutover/ext.ts` +13 (GOV-01 surface-then-clear,
  action-center content + 403, autostage attribution + one-in-flight idempotency ×2, human activation with
  no SOD trip, scheduled measurement + measure-exactly-once).

## Phase 2 — Money-loop depth (NEXT)

- **⑤ offer-level cells**: extend segment×channel to segment×channel×**offer** using ③'s ranked offers and
  `message_log` outcomes — budget lands on the right audience, channel AND offer. (The docs/61 §⑤ deferred
  refinement.)
- **Plan-vs-actual reconciliation**: compare each approved `mi_budget_plans` allocation against MMM-ingested
  actual spend, and its predicted ROI against measured outcomes — a per-plan backtest report (candidate NEW
  detective control MKT-26).

## Phase 3 — Statistical honesty + creative A/B

- Confidence intervals / minimum-sample flags on `common/lift-math.ts` (pure, deterministic) so weak-n lift
  claims are visibly weak; surfaced on every realized-lift chip.
- Studio generates **two** AI copy variants (campaigns already carry `variant_b_body`) and outcomes are
  measured per variant via the MKT-19 experiment machinery.

## Standing gap noted

docs/61 §① lists "sentiment tone from TOWS" on the Studio fact sheet — not yet wired (the sheet has no tone
field). Cheap to add from the reputation/TOWS reads in any phase.

## Non-goals (inherited from docs/61)

No new contact channel or send path; no auto-send/auto-spend (staging ≠ acting); no cross-domain DB joins;
AI drafts, humans send.

## Revision history

| Rev | Date | Notes |
|---|---|---|
| v0.1 | 2026-07-23 | Roadmap created; **Phase 1 (autopilot cadence + action center) DELIVERED** — 3 scheduled action jobs (`mkt_nba_autostage`/`mkt_save_autostage`/`mkt_measure_windows`, one-in-flight idempotency, "(auto)" maker attribution, human maker-checker unchanged), 4 GOV-01 queues (MKT-17/22/24 + measure-due), `GET /api/marketing-activation/action-center` + the สิ่งที่รอคุณตอนนี้ overview card. No new control/migration; census unchanged. ToE `ext.ts` +13 (423). PN-19 rev 1.73; manual 09 v0.17; UAT-MA-AUTO-01/02 + UAT 09 v3.9; traceability bumped. |
