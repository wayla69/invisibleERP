# 26 — CRM Growth Engine v2: Branching, True Baselines & Right-Time Sends — Design & Roadmap

> **Date:** 2026-07-02 · **Status:** v1.3 — **DELIVERED** (H1 #304, H2 #305, H3 shipped) · **Owner:** ERP / Product (CMO + SVP-IT review)
> **Scope:** The v2 refinements `docs/25` §5 explicitly deferred, now that the growth engine's spine is
> merged (journeys #300, A/B + holdout #301, predictive scoring #302): **H1 branching journeys**
> (conditional paths, not just linear + skip), **H2 organic-purchase holdout baseline** (true incremental
> lift, not just "holdout redeems 0 by construction"), and **H3 send-time optimization** (each member gets
> messaged at *their* hour — explainably, no ML). Build on, don't duplicate — every phase extends a G-phase
> table/runner/report that already exists.
> **Still out of scope:** multi-armed bandits, trained ML models (SOX posture), journey graph *editors*
> (H1 is rule-based jumps, not a canvas).

## 0. Why (what v1 deliberately punted)

| v1 (docs/25, DELIVERED) | Gap it stated honestly | v2 answer |
|---|---|---|
| Journeys are **linear** + per-step `skip_if` | A skip can only *not send* — it can't take a different path ("if they bought → thank-you branch; else → escalate") | **H1** rule-based forward jumps |
| Holdout lift = "redemptions attributable to being messaged" (holdout redeems 0 **by construction**) | Doesn't answer "would they have purchased anyway?" | **H2** organic purchase-rate baseline from actual orders |
| Sends fire when the runner runs | 2 AM drips; every member messaged at the same clock time | **H3** per-member preferred hour (explainable histogram mode) |

Three sequential doc-synced PRs (**H1 → H2 → H3**), same delivery discipline as docs/24/25 (one PR per
phase; narrative + user manual + UAT + harness in the same PR; merge on all-green CI).

## 1. Phase H1 — Branching journeys (rule-based forward jumps)

**Goal:** *"send coupon → wait 5 days → **if recency < 5** (they came back) jump to the thank-you step;
else escalate the offer"* — without a graph editor and without loops.

- **Schema (additive on `journey_steps`, one migration):** `branch_rule` jsonb (single `{field, op, value}`
  — the **same F1 whitelist** as `skip_rule`, evaluated via `SavedSegmentsService.memberMatchesRule`; no new
  SQL surface) + `branch_to_step` integer. Semantics at step completion: if `branch_rule` matches →
  next = `branch_to_step`, else next = `step_no + 1` (unchanged v1 path).
- **Termination is structural, not runtime:** `branch_to_step > step_no` is **enforced at create/update**
  (`BAD_BRANCH` otherwise) — forward-only jumps make every journey a DAG on a line; no loop detection or
  step-budget counters needed, the claim-first at-most-once runner (MKT-12) is untouched.
- **Runner change is one decision point:** after a step executes (sent/skipped — consent and frequency-cap
  behaviour identical), evaluate `branch_rule` and advance to the jump target or the next step; a jump past
  the last step completes the enrollment. Step outcomes audit the chosen path (`journey:<code>:<step>` in
  `message_log` already carries the step actually executed).
- **Web `/loyalty/journeys`:** step rows gain "ถ้าเงื่อนไขตรง → ข้ามไปขั้นที่ N" (rule picker reuses the F1
  catalog component grammar; target dropdown lists only later steps). Funnel display unchanged
  (per-step counts already show where members actually went).
- **Controls:** **MKT-12 unchanged** (consent-gated, frequency-capped, at-most-once per step — branching
  changes *which* step, never *whether once*). No new control ID; RCM untouched.
- **Verify:** harness `crm` +3: a member matching the branch rule jumps (step 2 skipped, step 3 executed);
  a non-matching member walks linearly; `branch_to_step <= step_no` rejected `BAD_BRANCH` at create.
- **Docs:** narrative 19 (step 28 + rev), user-manual 13 (§ journeys branch row), UAT 11 (+1).

## 2. Phase H2 — Organic-purchase holdout baseline (true lift)

**Goal:** the campaign report answers *"vs doing nothing, how much MORE did messaged members actually buy?"*
— not just coupon redemptions.

- **Ride what exists:** G2's `campaign_sends` already records every group's members (`variant` A/B/holdout)
  with `sent_at`; `dine_in_orders` (paid ⇒ `sale_no` set) already carries `member_id` + `opened_at` +
  `total`. H2 is a **read-only report extension** — join each group's members to their paid orders in the
  attribution window after the send.
- **`automation_campaigns.window_days`** (one additive column, default 30) — the attribution window an
  analyst can set per campaign.
- **Report additions per group (A / B / holdout):** `purchasers`, `purchase_rate_pct`, `order_revenue`
  (actual paid orders in-window — the holdout's numbers are the **organic baseline**), and
  **`organic_lift`**: messaged purchase-rate − holdout purchase-rate (pp) and incremental revenue
  (`messaged revenue − holdout revenue scaled by group size`). The v1 redemption-lift block stays; the
  honest caveat is **upgraded**, not removed (small holdouts ⇒ noisy baseline — the report renders the
  group sizes next to the rates so the reader can judge significance; no p-values pretence in v1... this IS
  the v2 of that caveat).
- **Controls:** read-only monitoring on existing data; no schema beyond the window column; no new control.
- **Verify:** harness `line-automation` +3: seed paid orders for one holdout member + one messaged member
  in-window and one out-of-window → per-group purchase rates count only in-window orders; organic lift =
  messaged − holdout rates; window respected (out-of-window order excluded).
- **Docs:** narrative 19 (step 12 + rev), user-manual 13 (§ campaign report — reading true lift), UAT 11 (+1).

## 3. Phase H3 — Send-time optimization (each member's hour, explainably)

**Goal:** drips and campaign sends land when the member actually shops — a histogram mode, not a model.

- **Score:** `customer_profiles.preferred_hour` (0–23, **Asia/Bangkok**) = the mode of the member's paid-
  order hours (ties → earliest; `null` under 3 orders — falls back to the journey/campaign default hour).
  Computed **inside `refreshProfile`** next to RFM/churn (one reviewed path, F2 sweep keeps it fresh);
  documented in `docs/ops/predictive-scoring.md` (bump to formula doc rev, same explainability posture —
  `SCORE_VERSION` bumps to `v2` since the profile-score surface changes).
- **Journeys use it:** when scheduling a wait step, `next_run_at` = wait target **snapped forward to the
  member's `preferred_hour`** (or the journey's `default_send_hour`, one additive column, default 10:00) —
  never snapped backward (a wait can only get ≤23h longer, so cadence contracts hold and the runner's
  claim-first semantics are untouched).
- **Campaigns (scheduled `loyalty_campaigns`) keep a single fire time** (they are one broadcast, claimed
  once — per-member timing would break MKT-10's claim-first shape); noted explicitly as out of scope.
- **Controls:** MKT-12 unchanged; scoring documented + versioned; no new control.
- **Verify:** harness `crm` +3: a member with 3 same-hour paid orders gets that `preferred_hour`; <3 orders
  → null; a journey wait step's `next_run_at` lands on the member's hour (and only ever later than the raw
  wait target).
- **Docs:** narrative 19 (steps 10/28 + rev), user-manual 13 (§ right-time sends), UAT 11 (+1),
  `docs/ops/predictive-scoring.md` rev (v2 fields).

## 4. Delivery discipline

- Three PRs, **H1 → H2 → H3**; merge only on all-green CI (92 checks); branch restarts from `main` after
  each merge. Migrations take the next free 4-digit id at PR time (expected: H1 + H2 + H3 each one small
  additive migration), journaled sequentially.
- **No new control IDs anticipated** (H1 rides MKT-12; H2/H3 are monitoring/scheduling refinements) —
  RCM xlsx expected untouched; if review disagrees, `build_rcm.py` regen per policy.
- Sequencing: H1 first (unlocks real win-back flows the other two feed), H2 second (proves them), H3 last
  (polish that touches the scoring doc H2 doesn't).

## 5. Explicitly out of scope (beyond v2)

Multi-armed bandit auto-optimization, trained ML models / feature stores, a visual journey canvas,
per-member campaign fire times, statistical significance testing on lift (group sizes are rendered so a
human judges; a proper test is a future refinement).

## Revision history

| Ver | Date | Author | Change |
|---|---|---|---|
| 1.3 | 2026-07-02 | Platform | **H3 SHIPPED — plan DELIVERED.** preferred_hour (histogram mode, SCORE_VERSION v2) + journeys.default_send_hour (migration 0217); wait steps snap forward, wait-0 unsnapped; scoring doc rev 1.1. §5 (bandits, ML, canvas, per-member campaign times, significance tests) remains beyond v2. |
| 1.2 | 2026-07-02 | Platform | **H2 SHIPPED** — window_days (migration 0216) + `organic` report block (per-group real-purchase rates/revenue, holdout as baseline, size-scaled incremental lift, noise note). H3 pending. |
| 1.1 | 2026-07-02 | Platform | **H1 SHIPPED** — branch_rule/branch_to_step on journey_steps (migration 0215), forward-only enforced (BAD_BRANCH), runner one decision point, web ทางแยก row. H2/H3 pending. |
| 1.0 | 2026-07-02 | Platform | Initial v2 plan: H1 rule-based forward-jump branching (termination by construction), H2 organic-purchase holdout baseline (true incremental lift on the G2 closed loop), H3 explainable per-member send-hour (histogram mode; journeys snap forward). Bandits/ML/canvas stay out. |
