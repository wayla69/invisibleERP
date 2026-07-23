// Shared holdout-lift math (MKT-19 discipline) — the ONE treatment-vs-control computation used by every
// measured surface: segment experiments (MKT-19, mi-experiments.service.ts), NBA journeys (MKT-22) and
// churn-save runs (MKT-24). Pure and deterministic (unit-tested in test/lift-math.test.ts): per-head
// revenue for each arm, lift% against the control per-head (null when the control earned nothing — a
// ratio against zero is meaningless, not infinite), and the incremental revenue attributed to treatment.
// Rounding stays at the STORE site (the callers), so extracting this from the inline MKT-19 math is
// byte-identical in behavior.

export interface LiftInput {
  treatmentRevenue: number;
  treatmentN: number;
  controlRevenue: number;
  controlN: number;
}

export interface LiftResult {
  treatment_per_head: number;
  control_per_head: number;
  lift_pct: number | null;      // null when control per-head ≤ 0 (no meaningful baseline)
  incremental_revenue: number;  // (tPerHead − cPerHead) × treatmentN
}

export function measureLift(i: LiftInput): LiftResult {
  const tPerHead = i.treatmentN > 0 ? i.treatmentRevenue / i.treatmentN : 0;
  const cPerHead = i.controlN > 0 ? i.controlRevenue / i.controlN : 0;
  return {
    treatment_per_head: tPerHead,
    control_per_head: cPerHead,
    lift_pct: cPerHead > 0 ? ((tPerHead - cPerHead) / cPerHead) * 100 : null,
    incremental_revenue: (tPerHead - cPerHead) * i.treatmentN,
  };
}

// ── Statistical honesty (docs/62 Phase 3) ────────────────────────────────────────────────────────────
// The detailed variant takes the PER-MEMBER revenues (available at measure time from revenueByMembers)
// and adds the evidence around the point estimate: a 95% CI on the lift% (two-sample difference of
// per-head means; SE_diff = sqrt(s_t²/n_t + s_c²/n_c), CI scaled by the control per-head — the standard
// delta-method approximation with the control mean treated as the baseline), and a WEAK_EVIDENCE flag
// when either arm is small (< minN) or the CI cannot be computed or it spans 0. The flag never changes
// any math downstream — honesty is a display/report property, not a silent behavior switch: a +900% from
// n=2 must LOOK weaker than a +12% from n=2,000.

export interface DetailedLiftResult extends LiftResult {
  lift_se_pct: number | null;      // standard error of the lift% estimate (null when not computable)
  lift_ci_low_pct: number | null;  // 95% CI bounds on lift%
  lift_ci_high_pct: number | null;
  weak_evidence: boolean;          // small arm (< minN), CI not computable, or CI spans 0
  min_arm_n: number;               // min(treatmentN, controlN) — the binding sample size
}

const variance = (xs: number[], mean: number): number => {
  if (xs.length < 2) return 0;
  let s = 0;
  for (const x of xs) s += (x - mean) * (x - mean);
  return s / (xs.length - 1); // sample variance
};

export function measureLiftDetailed(
  treatmentRevs: number[],
  controlRevs: number[],
  opts?: { z?: number; minN?: number },
): DetailedLiftResult {
  const z = Number(opts?.z ?? 1.96) || 1.96;
  const minN = Math.max(1, Number(opts?.minN ?? 30) || 30);
  const nT = treatmentRevs.length;
  const nC = controlRevs.length;
  const base = measureLift({
    treatmentRevenue: treatmentRevs.reduce((s, x) => s + x, 0), treatmentN: nT,
    controlRevenue: controlRevs.reduce((s, x) => s + x, 0), controlN: nC,
  });

  let se: number | null = null;
  let ciLow: number | null = null;
  let ciHigh: number | null = null;
  if (nT >= 2 && nC >= 2 && base.control_per_head > 0) {
    const varT = variance(treatmentRevs, base.treatment_per_head);
    const varC = variance(controlRevs, base.control_per_head);
    const seDiff = Math.sqrt(varT / nT + varC / nC);
    se = (seDiff / base.control_per_head) * 100;
    const diff = base.treatment_per_head - base.control_per_head;
    ciLow = ((diff - z * seDiff) / base.control_per_head) * 100;
    ciHigh = ((diff + z * seDiff) / base.control_per_head) * 100;
  }
  const spansZero = ciLow != null && ciHigh != null && ciLow <= 0 && ciHigh >= 0;
  return {
    ...base,
    lift_se_pct: se,
    lift_ci_low_pct: ciLow,
    lift_ci_high_pct: ciHigh,
    weak_evidence: Math.min(nT, nC) < minN || ciLow == null || spansZero,
    min_arm_n: Math.min(nT, nC),
  };
}
