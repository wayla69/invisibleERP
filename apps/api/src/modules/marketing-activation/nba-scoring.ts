// NBA Orchestrator — the PURE, deterministic scoring core (docs/61 Phase 3, control MKT-22). No DB, no IO —
// same inputs always yield the same journey (targets + suppression + holdout arms), so it is unit-tested
// (nba-scoring.test.ts), like the MKT-17 optimiser and the MKT-23/MKT-25 scorers.

// Expected fraction of a customer's CLV an action plausibly unlocks — the "action uplift". Deliberately
// conservative and interpretable; the orchestrator ranks by CLV × this, so the RELATIVE ordering is what
// matters. Unknown/absent action → a small nurture-grade uplift.
export const ACTION_UPLIFT: Record<string, number> = {
  UPSELL: 0.20, CROSS_SELL: 0.18, WINBACK: 0.15, REACTIVATE: 0.12, VIP_CARE: 0.10, RETAIN: 0.10, NURTURE: 0.05,
};
const DEFAULT_UPLIFT = 0.05;
const RETENTION_ACTIONS = new Set(['WINBACK', 'REACTIVATE', 'RETAIN']);

export function actionUplift(nba: string | null | undefined): number {
  if (!nba) return DEFAULT_UPLIFT;
  return ACTION_UPLIFT[nba.toUpperCase()] ?? DEFAULT_UPLIFT;
}

// Expected value of acting NOW = CLV × action uplift, and for a retention action scaled by churn risk (a
// high-churn VIP is worth saving more than a safe one). Deterministic; never negative.
export function expectedValue(clv: number | null | undefined, nba: string | null | undefined, churnRisk: number | null | undefined): number {
  const base = Math.max(0, Number(clv) || 0) * actionUplift(nba);
  if (nba && RETENTION_ACTIONS.has(nba.toUpperCase())) {
    const risk = Math.max(0, Math.min(1, Number(churnRisk) || 0));
    return Math.round(base * (1 + risk) * 100) / 100;
  }
  return Math.round(base * 100) / 100;
}

// Deterministic, stable holdout assignment — the SAME hash MKT-19 uses, so arms are reproducible and a
// member's holdout status is independent of ordering.
export function inHoldout(memberId: number, controlPct: number): boolean {
  return ((Math.imul(memberId >>> 0, 2654435761) >>> 0) % 10000) < Math.round(controlPct * 10000);
}

export interface NbaCustomer {
  member_id: number;
  nba: string | null;
  clv: number | null;
  churn_risk: number | null;
  opt_in: boolean;
  last_order_at: number | null; // epoch ms, or null
  preferred_channel: string | null;
}

export interface JourneyTarget {
  member_id: number;
  action: string | null;
  expected_value: number;
  arm: 'treatment' | 'control';
  preferred_channel: string | null;
}
export interface SuppressedTarget { member_id: number; reason: 'CONSENT' | 'RECENT_PURCHASE' | 'NO_ACTION'; action: string | null }

// Decide whether a customer is suppressed and why. Consent is the hard gate (PDPA); a recent purchase avoids
// re-selling to someone who just bought; no action means nothing to sequence.
export function suppressionReason(c: NbaCustomer, nowMs: number, recentDays: number): SuppressedTarget['reason'] | null {
  if (c.opt_in !== true) return 'CONSENT';
  if (!c.nba) return 'NO_ACTION';
  if (c.last_order_at != null && (nowMs - c.last_order_at) < recentDays * 86400_000) return 'RECENT_PURCHASE';
  return null;
}

export interface Journey {
  targets: JourneyTarget[];       // treatment + control (the acted-on set); only treatment gets contacted
  suppressed: SuppressedTarget[]; // held back, with the reason (audit evidence)
  treatment_count: number;
  control_count: number;
  suppressed_count: number;
}

// Assemble a journey: suppress (consent / recent purchase / no action), rank the rest by expected value,
// cap to the top N (fatigue cap), then split a holdout arm off the capped set. Fully deterministic.
export function assembleJourney(
  customers: NbaCustomer[],
  opts: { nowMs: number; controlPct?: number; maxTargets?: number; recentPurchaseDays?: number },
): Journey {
  const controlPct = Math.max(0, Math.min(0.9, Number(opts.controlPct ?? 0.2) || 0));
  const maxTargets = Math.min(Math.max(Number(opts.maxTargets ?? 500) || 500, 1), 5000);
  const recentDays = Math.max(0, Number(opts.recentPurchaseDays ?? 14) || 0);

  const suppressed: SuppressedTarget[] = [];
  const eligible: { c: NbaCustomer; ev: number }[] = [];
  for (const c of customers) {
    const reason = suppressionReason(c, opts.nowMs, recentDays);
    if (reason) { suppressed.push({ member_id: c.member_id, reason, action: c.nba }); continue; }
    eligible.push({ c, ev: expectedValue(c.clv, c.nba, c.churn_risk) });
  }
  eligible.sort((a, b) => b.ev - a.ev || a.c.member_id - b.c.member_id);
  const capped = eligible.slice(0, maxTargets);

  const targets: JourneyTarget[] = capped.map(({ c, ev }) => ({
    member_id: c.member_id, action: c.nba, expected_value: ev,
    arm: inHoldout(c.member_id, controlPct) ? 'control' : 'treatment',
    preferred_channel: c.preferred_channel,
  }));
  const treatment_count = targets.filter((t) => t.arm === 'treatment').length;
  return {
    targets,
    suppressed,
    treatment_count,
    control_count: targets.length - treatment_count,
    suppressed_count: suppressed.length,
  };
}
