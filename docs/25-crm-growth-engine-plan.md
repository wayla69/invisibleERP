# 25 — CRM Growth Engine: Journeys, Proof of Lift & Prediction — Design & Roadmap

> **Date:** 2026-07-02 · **Status:** v1.3 — **DELIVERED** (G1 #300, G2 #301, G3 shipped) · **Owner:** ERP / Product (CMO + SVP-IT review)
> **Scope:** The three strategic capabilities deferred by `docs/24` §5 — the gap between "a marketer can
> operate it" (docs/24, DELIVERED) and "the platform *grows revenue by itself and proves it*":
> **G1 lifecycle journeys** (multi-step, wait/condition, frequency-capped), **G2 A/B + holdout** (prove a
> campaign lifted anything), and **G3 predictive scoring** (churn risk + LTV beyond rule-based RFM).
> Build on, don't duplicate — every phase rides a merged spine (campaigns MKT-10, closed-loop
> `campaign_sends` attribution, the F1 segment engine, the F2 profile sweep, the BI scheduler).

## 0. Why (where docs/24 left us)

docs/24 made the loyalty/CRM stack **operable**: segments are buildable + usable (F1), fresh (F2), and
delivery is visible (F3). What it still is *not* is a **growth engine**:

| Gap | Today | Competitor bar (BuzzeBees/Hato class) |
|---|---|---|
| **Lifecycle journeys** | Single-shot campaigns + single event→action automation rules | Welcome series, win-back drips: *enrol → wait 3 days → if no order, coupon → wait 7 → escalate* |
| **Proof of lift** | Redemption rate + attributed revenue per campaign (rev 1.19-era closed loop) — but no control group, so "did it work?" is unanswerable | A/B message variants + a **holdout** that proves incremental revenue |
| **Prediction** | Rule-based RFM buckets (thresholds) | Churn-risk score & predicted LTV driving segments before the customer is already Lost |

Three sequential doc-synced PRs (**G1 → G2 → G3**), same delivery discipline as docs/19/23/24
(one PR per phase; narrative + user manual + UAT + harness in the same PR; merge on all-green CI).

## 1. Phase G1 — Lifecycle journeys (multi-step, consent-safe, at-most-once per step)

**Goal:** a marketer designs "when X happens → wait → message → wait → if still inactive, escalate" once,
and the system runs it per member, forever, without cron babysitting.

- **Schema (one migration, next-free id, + RLS loop):**
  - `journeys` — tenant, name, status (`draft|active|paused`), **entry trigger** (`member_enrolled` /
    `loyalty.earned` / `segment_entered:<saved_segment_id>` — reuses F1 segments as entry gates),
    re-entry policy (`once` per member v1), frequency cap (`max_msgs_per_member_per_days`).
  - `journey_steps` — ordered linear steps v1 (no branching graph): `wait {days}` ·
    `send {channel, body|flex}` · `skip_if {rule}` (single whitelisted condition per step, e.g.
    `recency < 7` — evaluated through the **F1 rule engine**, same FIELDS whitelist, no new SQL surface).
  - `journey_enrollments` — member × journey: `current_step`, `next_run_at`, `status`
    (`active|completed|exited`), audit of each step outcome.
- **Runner:** a schedulable BI report type **`journey_runner`** (pattern of `crm_profile_refresh`): each run
  claims due enrollments (`next_run_at <= now`) with an **atomic guarded UPDATE per enrollment-step**
  (claim-first, exactly like MKT-10's campaign claim — a crash mid-send can never re-fire a step), executes
  the step through the existing consent-respecting `MessagingService.send` (opted-out ⇒ `skipped`, audited
  in `message_log` with `campaign = journey:<code>:<step>`), applies the frequency cap
  (count `message_log` rows in the window **before** sending), then schedules the next step. Entry
  enrolment: event-triggered via the automation engine's `runEvent` hook (new action `enroll_journey`)
  + a per-run sweep for `segment_entered` triggers.
- **Web `/loyalty/journeys`** (nav under Loyalty, `marketing`/`exec`): list + step-row builder (same
  interaction grammar as the F1 segment builder), per-journey funnel (enrolled / at step N / completed /
  exited / messages skipped by consent or cap), pause/resume.
- **Controls:** new detective/preventive control **MKT-12 — journey sends are consent-gated, frequency-
  capped, and at-most-once per step** (claim-first). RCM: add via `build_rcm.py` → regenerate xlsx (170
  controls); narrative 19 control matrix row; SoD unchanged (`marketing`/`exec` config, runner is the
  scheduler service account).
- **Verify:** new harness slice or `crm` +5: enrol on event → step 1 sends; wait step honoured
  (`next_run_at` future ⇒ runner no-op); re-run does not duplicate a claimed step; opted-out member skipped;
  frequency cap blocks a second message inside the window; T2 cannot see/run T1 journeys.
- **Docs:** narrative 19 (new step + control-matrix row + rev), user-manual 13 (§ journeys guide),
  UAT 11 (+2 cases), compliance RCM regen.

## 2. Phase G2 — A/B variants + holdout (prove the lift)

**Goal:** every send answers "vs doing nothing, what did this earn?"

- **Ride the closed loop that already exists:** `automationCampaigns`/`campaign_sends` already record
  per-member coupon → `redeemed_at` → `redeemed_value` (attributed revenue). G2 adds **assignment**:
  - `automation_campaigns` gains `variant_b_body` (nullable), `split_b_pct` (default 0),
    `holdout_pct` (default 0) — one additive migration.
  - Assignment is a **deterministic hash** of `(campaign_id, member_id)` → bucket (no RNG: reproducible,
    harness-testable, and a member can't flip groups on retry). Holdout members get a `campaign_sends`
    row `status='holdout'` (no message, no coupon issued — their later purchases are the baseline)…
    *v1 baseline = redemption-rate comparison; organic-purchase baseline noted as a v2 refinement.*
  - `GET …/campaigns/:id` report gains per-group tallies: sent / redeemed / redemption-rate / attributed
    revenue for **A, B, holdout**, plus **lift** (A∪B rate − holdout rate; holdout redemption is by
    construction 0 with coupons, so v1 lift is stated as *incremental redemptions attributable to being
    messaged*, with the honest caveat rendered in the report).
  - Loyalty `loyalty_campaigns` (MKT-10 broadcast path) gets the same `variant_b_body`/`split_b_pct`
    (body-only A/B; no holdout there v1 — no redemption loop to measure against).
- **Web:** campaign forms gain "ข้อความแบบ B (%)" + "กลุ่มควบคุม holdout (%)" fields; the campaign report
  page shows the A/B/holdout comparison bars.
- **Controls:** no new control ID — assignment is deterministic + audited (`campaign_sends.variant`
  column), consent/claim-first unchanged (MKT-04/10); the *report* is monitoring.
- **Verify:** harness `line-automation` +3: deterministic split (same member ⇒ same bucket across runs);
  holdout rows written with no gateway call; report tallies A/B/holdout + lift correctly on seeded
  redemptions.
- **Docs:** narrative 19 (step 12 + rev), user-manual 13 (§ campaign A/B), UAT 11 (+1).

## 3. Phase G3 — Predictive scoring (churn risk + LTV, explainable)

**Goal:** find the customer *before* they're Lost — with a score an auditor can read.

- **Model choice is deliberate: explainable weighted scoring, not a black box** (SOX posture: the formula
  is code-reviewed, versioned, and documented — no opaque training artifacts in the ICFR perimeter).
  - `churn_risk` (0–100): logistic-style blend of recency vs the member's own inter-purchase cadence
    (a weekly customer 3 weeks quiet ≫ risk than a quarterly one), frequency trend (last 45d vs prior 45d),
    and engagement signals already in-house (redemptions, mission claims). Coefficients in one exported
    constant with a `SCORE_VERSION`.
  - `predicted_ltv` (฿, 12-month horizon): `avg_order_value × personal cadence × 12 months × (1 − churn_risk)`
    — crude, honest, and monotonic; stated as an *estimate* in every surface.
- **Where it runs:** inside the **F2 sweep** (`refreshProfile` computes both alongside RFM — one reviewed
  path, no second scheduler); two new nullable numeric columns on `customer_profiles` (one migration).
- **Where it surfaces:** F1 segment catalog gains whitelisted fields `churn_risk` / `predicted_ltv`
  (a marketer builds "churn_risk ≥ 70 AND predicted_ltv ≥ 2000" → wires it straight into a G1 win-back
  journey — the three phases compose); `/loyalty/analytics` gains an at-risk-value panel
  (Σ predicted_ltv of high-risk members); member-360 shows both scores with the formula version.
- **Controls:** no new control ID — monitoring/analytics; scoring documented in the narrative +
  `docs/ops/` model note (version, coefficients, refresh cadence) for auditability.
- **Verify:** harness `crm` +3: a member with decaying cadence scores higher churn than an active one;
  scores refresh through the F2 sweep (stale → updated, version stamped); new fields resolvable in a
  saved segment (whitelist extended, still bound).
- **Docs:** narrative 19 (analytics step + rev), user-manual 13 (§ scores explained), UAT 11 (+1),
  `docs/ops/predictive-scoring.md` (new — formula, version, cadence, limitations).

## 4. Delivery discipline

- Three PRs, **G1 → G2 → G3**, each: code + harness + narrative/user-manual/UAT bumps in one commit series;
  merge only on all-green CI (92 checks); branch restarts from `main` after each merge.
- **G1 carries the only new control (MKT-12)** → `build_rcm.py` regen (169 → 170) in that PR. G2/G3 add none.
- Migrations: next free 4-digit id at PR time (expected: G1 three tables + RLS loop; G2 additive columns;
  G3 additive columns), each journaled sequentially.
- Sequencing rationale: G1 first (biggest competitive gap, and G3's scores are only *actionable* once a
  journey can consume them); G2 second (small, high-credibility); G3 last (composes with both).

## 5. Explicitly out of scope (beyond this plan)

- Branching journey graphs (v1 is linear + skip-conditions), multi-armed-bandit auto-optimization,
  organic-purchase holdout baselines (v2 note in G2), trained ML models / feature stores, send-time
  optimization per member.

## Revision history

| Ver | Date | Author | Change |
|---|---|---|---|
| 1.3 | 2026-07-02 | Platform | **G3 SHIPPED — plan DELIVERED.** Explainable churn-risk + predicted-LTV (migration 0214, SCORE_VERSION v1, docs/ops/predictive-scoring.md) inside refreshProfile; segment fields churn_risk/predicted_ltv; analytics value-at-churn-risk; member-360 scores. §5 (branching graphs, bandits, organic baselines, trained models, send-time optimization) remains the next horizon. |
| 1.2 | 2026-07-02 | Platform | **G2 SHIPPED** — A/B variants + holdout on the campaign_sends closed loop (migration 0213, deterministic bucketPct, per-group lift report with the honest 0-baseline caveat); loyalty_campaigns body-only A/B. G3 pending. |
| 1.1 | 2026-07-02 | Platform | **G1 SHIPPED** — lifecycle journeys (migration 0212, module `journeys`, `journey_runner` BI job, `enroll_journey` automation action, web `/loyalty/journeys`, control **MKT-12** + RCM regen → 170). G2/G3 pending. |
| 1.0 | 2026-07-02 | Platform | Initial plan: three-phase growth engine (G1 lifecycle journeys + MKT-12, G2 A/B + holdout lift on the campaign_sends closed loop, G3 explainable churn/LTV scoring composing into F1 segments + G1 journeys), continuing docs/24. |
