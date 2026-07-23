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
