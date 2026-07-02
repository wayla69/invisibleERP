# Predictive scoring — churn risk & predicted LTV (formula reference)

**Status: v1.0 · 2026-07-02** · Growth Engine G3 (`docs/25`) · Code: `apps/api/src/modules/crm/crm.service.ts`
(`SCORE_VERSION`, `SCORE_COEFFS`, `churnScore`) · Columns: `customer_profiles.churn_risk / predicted_ltv /
score_version` (migration `0214`)

## Design stance

The scores are an **explainable, versioned, weighted formula — deliberately not a trained model**. SOX
posture: the coefficients live in one code-reviewed constant, every stored score carries the
`score_version` that produced it, and this document is the audit reference. The scores are **estimates for
marketing prioritisation only** — they are never posted to the GL and drive no financial figure.

## Where and when it runs

Computed inside `CrmService.refreshProfile` **alongside RFM** (the single reviewed profiling path), so the
same surfaces keep them fresh: the nightly `crm_profile_refresh` BI job (F2), the on-demand
`POST /api/crm/profiles/refresh`, and the per-member refresh. A member with **no paid orders scores `null`**
(a new member is not "churned"; a null never matches a segment rule).

## Formula — version `v1`

Coefficients (`SCORE_COEFFS`): `assumedCadenceDays=30`, `ratioSoftness=3`, `trendAdj=10`, `ltvHorizonDays=365`.

1. **Personal cadence** (days between orders): `days(first_order → last_order) / (total_orders − 1)`,
   floor 1; a single-order member assumes `30` (monthly).
2. **Churn base** — how far past *their own* rhythm the member is:
   `ratio = rfm_recency / cadence` → `base = 100 · ratio / (ratio + 3)`
   (0 right after a purchase; → 100 as the quiet stretch grows; a weekly customer 3 weeks quiet scores far
   higher than a quarterly customer 3 weeks quiet).
3. **Frequency trend nudge**: orders in the last 45 days vs the prior 45 —
   shrinking → `+10`, growing → `−10`, flat → `0`.
4. **`churn_risk` = clamp(round(base + nudge), 0, 100)**.
5. **`predicted_ltv`** (฿, 12-month estimate):
   `avg_order_value × (365 / cadence) × (1 − churn_risk/100)` — crude, honest, monotonic; every UI surface
   labels it *ค่าประมาณ*.

## Where the scores surface

- **Segment builder** (`/loyalty/segments`): whitelisted fields `churn_risk`, `predicted_ltv` — e.g.
  *churn_risk ≥ 70 AND predicted_ltv ≥ 2000* → wire straight into a G1 win-back journey.
- **Analytics** (`/loyalty/analytics`): *value at churn risk* = Σ `predicted_ltv` of members with
  `churn_risk ≥ 70` (threshold rendered with the figure).
- **Member 360**: churn badge (≥70 red / ≥40 amber / else green) + LTV estimate + formula version.

## Limitations (stated, not hidden)

- Cadence needs ≥2 orders to be personal; single-order members use the monthly assumption.
- The LTV horizon ignores seasonality, tier effects, and margin (it is revenue, not profit).
- Engagement signals (redemptions, mission claims) are **not** in `v1` — listed for `v2`.
- Changing any coefficient REQUIRES bumping `SCORE_VERSION` and a revision row here.

## Revision history

| Ver | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-07-02 | Platform | Initial `v1` formula (cadence-relative churn + trend nudge; 12-month LTV), per docs/25 G3. |
