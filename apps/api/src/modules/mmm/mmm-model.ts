// docs/48 — the MMM attribution math, kept as a PURE, deterministic, dependency-free function so it can be
// unit-tested in isolation (bounded-context rule 4: core analytical logic must be tested). This is an
// explicit v1 HEURISTIC — a transparent lift-share attribution, NOT an econometric marketing-mix regression
// (adstock/saturation/Bayesian priors). It credits each channel with its directly-attributed revenue,
// nudged up by a bounded uplift for positive social buzz, then derives ROI, each channel's share of total
// contribution, and a ROI-proportional "optimal" budget split. Swapping in a real regression later means
// replacing THIS function only — the ingest/persistence/BI layers are model-agnostic.

// Strongest-buzz channel earns at most this fractional uplift on its attributed revenue.
export const MAX_SENTIMENT_BOOST = 0.25;

export interface MmmChannelInput {
  channel: string;
  /** THB spent on this channel over the modelling window. */
  spend: number;
  /** Revenue tagged to this channel (Σ mmm_sales_daily.revenue where utm_source = channel). */
  attributedRevenue: number;
  /** Positive-buzz proxy: Σ mention_count × max(0, sentiment_score) over the window. Unitless, ≥ 0. */
  sentimentSignal: number;
}

export interface MmmChannelResult {
  channel: string;
  spend: number;
  attributedRevenue: number;
  contribution: number;
  /** contribution ÷ spend; null when spend is 0 (ROI undefined, not "infinite"). */
  roi: number | null;
  /** % of total contribution across all channels, 0–100 (2 dp). */
  salesLiftContribution: number;
  /** THB; the set sums to exactly totalBudget (2 dp). */
  optimalBudgetAllocation: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Compute the per-channel MMM result set from the window's channel inputs and the total budget to allocate.
 * Deterministic and side-effect-free. Returns results in input order.
 */
export function computeMmm(inputs: MmmChannelInput[], totalBudget: number): MmmChannelResult[] {
  if (inputs.length === 0) return [];

  const maxSignal = Math.max(0, ...inputs.map((i) => Math.max(0, i.sentimentSignal)));

  // 1. Contribution = attributed revenue × (1 + bounded buzz uplift), where the uplift scales with the
  //    channel's positive-buzz signal relative to the strongest channel.
  const withContribution = inputs.map((i) => {
    const boost = maxSignal > 0 ? MAX_SENTIMENT_BOOST * (Math.max(0, i.sentimentSignal) / maxSignal) : 0;
    const contribution = Math.max(0, i.attributedRevenue) * (1 + boost);
    const roi = i.spend > 0 ? contribution / i.spend : null;
    return { input: i, contribution, roi };
  });

  const totalContribution = withContribution.reduce((s, c) => s + c.contribution, 0);

  // 2. Budget allocation: proportional to ROI among channels with a positive ROI (water-filling by
  //    efficiency). If no channel has a positive ROI, fall back to an equal split so the budget is still
  //    fully allocated rather than dropped.
  const positiveRoiSum = withContribution.reduce((s, c) => s + (c.roi != null && c.roi > 0 ? c.roi : 0), 0);
  const rawAllocation = withContribution.map((c) => {
    if (totalBudget <= 0) return 0;
    if (positiveRoiSum > 0) return c.roi != null && c.roi > 0 ? (totalBudget * c.roi) / positiveRoiSum : 0;
    return totalBudget / inputs.length; // equal fallback
  });

  const results: MmmChannelResult[] = withContribution.map((c, idx) => ({
    channel: c.input.channel,
    spend: round2(c.input.spend),
    attributedRevenue: round2(c.input.attributedRevenue),
    contribution: round2(c.contribution),
    roi: c.roi == null ? null : round2(c.roi),
    salesLiftContribution: totalContribution > 0 ? round2((100 * c.contribution) / totalContribution) : 0,
    optimalBudgetAllocation: round2(rawAllocation[idx]!),
  }));

  // 3. Correct 2-dp rounding drift so the allocations sum to EXACTLY totalBudget — push the residual onto
  //    the channel with the largest allocation (a cent, at most).
  if (totalBudget > 0) {
    const allocated = results.reduce((s, r) => s + r.optimalBudgetAllocation, 0);
    const residual = round2(totalBudget - allocated);
    if (residual !== 0) {
      let maxIdx = 0;
      for (let i = 1; i < results.length; i++) {
        if (results[i]!.optimalBudgetAllocation > results[maxIdx]!.optimalBudgetAllocation) maxIdx = i;
      }
      results[maxIdx]!.optimalBudgetAllocation = round2(results[maxIdx]!.optimalBudgetAllocation + residual);
    }
  }

  return results;
}
