// Churn-Save Autopilot — the PURE, deterministic offer + retention-P&L core (docs/61 Phase 5, MKT-24). No
// DB, no IO — same inputs always yield the same offers, holdout arms, and P&L, so it is unit-tested
// (save-offer.test.ts). The OFFER CAP is enforced HERE (an offer can never exceed the policy cap), and the
// holdout uses the same deterministic hash as MKT-19. It NEVER contacts anyone.

export interface SavePolicy {
  churn_threshold: number; // [0,1] — sweep customers at/above this churn risk
  min_clv: number;         // only save customers whose CLV justifies it
  offer_rate: number;      // offer = clv × rate, then capped
  offer_cap: number;       // HARD per-offer cap (the control)
}

export interface SaveCustomer { member_id: number; clv: number | null; churn_risk: number | null; opt_in: boolean }

// How much of an at-risk customer's value a save plausibly recovers — deliberately conservative, used only
// to estimate the retention P&L (NOT a promise). Interpretable + deterministic.
export const SAVE_EFFECTIVENESS = 0.35;

const r2 = (x: number): number => Math.round(x * 100) / 100;

// The capped win-back offer for one customer: clv × rate, never above the cap, never below 0. The cap is the
// control — no computed offer can exceed it.
export function cappedOffer(clv: number | null, policy: SavePolicy): number {
  const base = Math.max(0, (Number(clv) || 0) * Math.max(0, policy.offer_rate));
  return r2(Math.min(base, Math.max(0, policy.offer_cap)));
}

// Deterministic holdout — the SAME hash MKT-19 uses.
export function inHoldout(memberId: number, controlPct: number): boolean {
  return ((Math.imul(memberId >>> 0, 2654435761) >>> 0) % 10000) < Math.round(controlPct * 10000);
}

export interface SaveTarget {
  member_id: number; clv: number; churn_risk: number; offer: number; arm: 'treatment' | 'control'; expected_saved: number;
}
export interface SavePnl {
  targets: SaveTarget[];       // treatment + control (the acted-on at-risk set); only treatment is contacted
  eligible: number;            // at-risk + justifies-a-save + consented
  treatment_count: number;
  control_count: number;
  offer_cost: number;          // Σ capped offers over the TREATMENT arm (the control arm gets no offer)
  expected_saved_revenue: number; // Σ expected saved over the treatment arm
  net_benefit: number;         // saved − cost
  roi: number | null;          // net ÷ cost
}

// Sweep the customers against the policy: keep those at/above the churn threshold whose CLV ≥ min_clv and who
// consented; compute the capped offer + expected saved revenue; split a holdout arm; roll up the P&L over the
// TREATMENT arm (the control arm receives no offer and no cost — it is the counterfactual). Deterministic.
export function computeSavePnl(customers: SaveCustomer[], policy: SavePolicy, opts?: { controlPct?: number }): SavePnl {
  const controlPct = Math.max(0, Math.min(0.9, Number(opts?.controlPct ?? 0.2) || 0));
  const threshold = Math.max(0, Math.min(1, Number(policy.churn_threshold) || 0));
  const minClv = Math.max(0, Number(policy.min_clv) || 0);

  const targets: SaveTarget[] = [];
  let eligible = 0;
  for (const c of customers) {
    const churn = c.churn_risk == null ? null : Math.max(0, Math.min(1, Number(c.churn_risk)));
    const clv = Number(c.clv) || 0;
    if (c.opt_in !== true) continue;              // consent gate
    if (churn == null || churn < threshold) continue; // not at risk enough
    if (clv < minClv) continue;                    // not worth saving
    eligible++;
    const offer = cappedOffer(clv, policy);
    const arm: 'treatment' | 'control' = inHoldout(c.member_id, controlPct) ? 'control' : 'treatment';
    const expected_saved = r2(clv * churn * SAVE_EFFECTIVENESS);
    targets.push({ member_id: c.member_id, clv: r2(clv), churn_risk: churn, offer, arm, expected_saved });
  }
  targets.sort((a, b) => b.expected_saved - a.expected_saved || a.member_id - b.member_id);

  const treatment = targets.filter((t) => t.arm === 'treatment');
  const offer_cost = r2(treatment.reduce((s, t) => s + t.offer, 0));
  const expected_saved_revenue = r2(treatment.reduce((s, t) => s + t.expected_saved, 0));
  const net_benefit = r2(expected_saved_revenue - offer_cost);
  return {
    targets,
    eligible,
    treatment_count: treatment.length,
    control_count: targets.length - treatment.length,
    offer_cost,
    expected_saved_revenue,
    net_benefit,
    roi: offer_cost > 0 ? r2(net_benefit / offer_cost) : null,
  };
}
