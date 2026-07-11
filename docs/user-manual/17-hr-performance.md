# 17 · HR — Performance management

**Status: DRAFT v0.1**

This chapter is for **HR / People Ops**. It covers appraisal cycles, employee
goals, and the review workflow (self-assessment → manager rating → sign-off).

**Screen:** `/hcm/performance` · **Required permission:** `hr` or `hr_admin`
(managers/exec may view; sign-off requires `hr_admin` or `exec`).

Tabs: **Cycles** · **Goals** · **Reviews**.

---

## 1. Create an appraisal cycle

1. Go to **Performance** (`/hcm/performance`) → **Cycles** tab.
2. Enter a cycle name (e.g. `H1-2026`) and the period start/end, then click
   **New cycle**. The cycle opens in status **open**.
3. When appraisals are complete, click **Close** on the cycle row.

## 2. Set goals

1. Open the **Goals** tab and pick the cycle and employee.
2. Add each goal with a title and a **weight (%)**. The weights for one employee
   in a cycle must total **100% or less** — a goal that would push the total over
   100% is rejected with **WEIGHT_EXCEEDED**.
3. Update progress on a goal with the **+25%** action.

## 3. Run a review

1. Open the **Reviews** tab and pick the cycle.
2. **Start self-review** for an employee (optionally with a self rating).
3. A **manager** enters their rating. The manager code **must differ from the
   employee under review** — a self-rating is blocked with **SOD_SELF_REVIEW**.
4. **Sign off** the review. Sign-off requires a manager rating first
   (**NO_MANAGER_RATING** otherwise) and must be done by **someone other than the
   reviewee** (**SOD_SELF_REVIEW** otherwise). This is control **HR-03**.

## 4. Control callout — HR-03 (review sign-off SoD)

A performance review may only be finalised by someone other than the person being
reviewed, after an independent manager rating. This protects the ratings that
drive pay rises, bonuses and promotions.

## 5. Troubleshooting

| Message | Meaning | Fix |
|---|---|---|
| `WEIGHT_EXCEEDED` | Goal weights for the employee/cycle exceed 100% | Lower a weight so the total is ≤ 100% |
| `SOD_SELF_REVIEW` | The reviewee tried to rate or sign their own review | A different manager/HR user must rate and sign off |
| `NO_MANAGER_RATING` | Sign-off attempted before a manager rating exists | Enter the manager rating first, then sign off |
| `CYCLE_CLOSED` | Adding goals/reviews to a closed cycle | Reopen work in a new/open cycle |
