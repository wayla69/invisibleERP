# A/B + holdout significance — formula reference

**Status: v1.0 · 2026-07-02** · docs/29 Phase V3 · Code: `apps/api/src/modules/marketing/
marketing-automation.service.ts` (`AB_STATS_VERSION`, `AB_STATS`, `compareProportions`) · Surfaces:
`GET /api/marketing/automation/campaigns/:id` → `ab.ab_significance` (A vs B redemption rates) and
`organic.organic_lift.significance` (messaged vs holdout purchase rates).

## Design stance

**Explainable, versioned, closed-form — deliberately not a statistics library.** SOX posture identical to
`predictive-scoring.md`: the constants live in one code-reviewed place (`AB_STATS`), every payload carries
`stats_version`, and this document is the audit reference. The verdicts guide **marketing decisions only**
— nothing here posts to the GL or drives a financial figure.

## Formula — version `v1`

Constants (`AB_STATS`): `alpha = 0.05`, `z95 = 1.959964`, `minGroup = 30`.

Given two groups with successes/trials `(x₁, n₁)` and `(x₂, n₂)` (e.g. A-redeemers/A-sent vs
B-redeemers/B-sent), `compareProportions` returns:

1. **`delta_pp`** — the raw rate difference `p₁ − p₂` in percentage points.
2. **`p_value`** — two-sided, from the **pooled two-proportion z-test**:
   `z = (p₁ − p₂) / √(p̄(1−p̄)(1/n₁ + 1/n₂))`, `p̄ = (x₁+x₂)/(n₁+n₂)`; the normal tail is computed with the
   **Abramowitz–Stegun 7.1.26 erfc polynomial** (|error| ≤ 1.5×10⁻⁷ — far below any decision threshold).
3. **`ci95_pp`** — a 95% CI on the difference via **Newcombe's Wilson-score hybrid**: Wilson bounds
   `(l,u)` per group, then `[d − √((p₁−l₁)² + (u₂−p₂)²), d + √((u₁−p₁)² + (p₂−l₂)²)]`. Wilson-based so the
   interval stays sane at small counts and 0%/100% rates (a plain Wald CI does not).
4. **`significant`** — `true` only when **both** `p_value < alpha` **and** both groups ≥ `minGroup` (30).
   A tiny sample can never claim significance, however extreme its rates.
5. **`verdict`** — the honest one-liner the UI renders:
   `"underpowered — grow the groups"` (either group < 30) · `"real"` (significant) ·
   `"no detectable effect"` (adequately powered, p ≥ .05).

## How to read it

- **`real`** — the lift survives a proper test; act on it.
- **`underpowered`** — the report refuses to judge; run the campaign on a bigger audience (the old
  "group sizes rendered next to the rates" caveat from docs/26 §5, now enforced by the math).
- **`no detectable effect`** — with this sample the variants perform the same; don't ship the "winner".

## Limitations (stated, not hidden)

- One comparison per pair — no multiple-testing correction (run few, deliberate tests, not dashboards of
  hundreds). Sequential peeking inflates false positives; judge at a planned sample size.
- Redemption/purchase are binomial proportions; revenue amounts are NOT tested (a t-test on spend is a
  future refinement).
- Changing any constant REQUIRES bumping `AB_STATS_VERSION` and a revision row here.

## Revision history

| Ver | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-07-02 | Platform | Initial `v1`: pooled two-proportion z (A&S erfc) + Newcombe/Wilson 95% CI + min-group-30 power gate, per docs/29 V3. |
