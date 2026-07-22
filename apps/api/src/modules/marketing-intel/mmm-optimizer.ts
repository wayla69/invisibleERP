// Marketing Intelligence — Budget Optimizer math (docs/60 Phase 1). PURE functions, NO DI, so they are
// unit-testable and deterministic. The heavy MMM FIT lives in the external Python platform; what it pushes
// per channel is a SATURATION (response) curve — spend → incremental sales — which these helpers evaluate
// and optimise ERP-side with no external call (the ERP owns the data it displays; DB-isolation rule).
//
// Model: the standard MMM Hill saturation  response(x) = beta · x^slope / (kappa^slope + x^slope)
//   · beta  = the channel's incremental-sales ASYMPTOTE (max reachable contribution)
//   · kappa = the HALF-SATURATION spend (response = beta/2 at x = kappa)
//   · slope = steepness (> 0)
// If the platform has not (yet) pushed saturation params, we DERIVE a serviceable fallback from the
// channel's current spend + ROI so the planner works immediately (flagged `derived`); the platform can
// later push precise params and the same code evaluates them.

export interface ResponseCurve {
  channel: string;
  beta: number; // incremental-sales asymptote
  kappa: number; // half-saturation spend (> 0)
  slope: number; // steepness (> 0)
  currentSpend: number;
  roi: number | null;
  derived: boolean; // true = fallback synthesised from spend/roi (no pushed saturation params)
}

const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : d;
};

/** Incremental sales contributed by `spend` on a channel (Hill saturation). */
export function hillResponse(spend: number, c: ResponseCurve): number {
  const x = Math.max(0, spend);
  if (c.beta <= 0 || c.kappa <= 0 || c.slope <= 0) return 0;
  const xs = Math.pow(x, c.slope);
  const ks = Math.pow(c.kappa, c.slope);
  return (c.beta * xs) / (ks + xs);
}

/** Marginal incremental sales per extra baht at `spend` — the response-curve derivative. Drives the greedy
 *  allocator (put the next baht where it returns the most). */
export function hillMarginal(spend: number, c: ResponseCurve): number {
  const x = Math.max(0, spend);
  if (c.beta <= 0 || c.kappa <= 0 || c.slope <= 0) return 0;
  const ks = Math.pow(c.kappa, c.slope);
  const xs = Math.pow(x, c.slope);
  const denom = ks + xs;
  // d/dx [ beta·x^s / (k^s + x^s) ] = beta·s·k^s·x^(s-1) / (k^s + x^s)^2
  return (c.beta * c.slope * ks * Math.pow(x, c.slope - 1)) / (denom * denom);
}

/** Build per-channel response curves from an MMM snapshot payload. Uses each channel's pushed `saturation`
 *  params when present, else derives a fallback: current spend is treated as the half-saturation point
 *  (kappa = spend), asymptote beta = 2 × current response (≈ 2 × contribution), slope = 1. */
export function curvesFromMmm(mmmPayload: unknown): { curves: ResponseCurve[]; anyDerived: boolean } {
  const p: any = mmmPayload ?? {};
  const channels: any[] = Array.isArray(p.channels) ? p.channels : [];
  const totalSpend = channels.reduce((s, c) => s + num(c?.spend), 0);
  const curves: ResponseCurve[] = [];
  let anyDerived = false;
  for (const ch of channels) {
    const channel = String(ch?.channel ?? '').trim();
    if (!channel) continue;
    const spend = Math.max(0, num(ch?.spend));
    const roi = ch?.roi == null ? null : num(ch.roi);
    const sat = ch?.saturation;
    if (sat && num(sat.beta) > 0 && num(sat.kappa) > 0 && num(sat.slope) > 0) {
      curves.push({ channel, beta: num(sat.beta), kappa: num(sat.kappa), slope: num(sat.slope), currentSpend: spend, roi, derived: false });
      continue;
    }
    // Fallback: current response ≈ contribution_pct of total sales, or spend×roi if contribution absent.
    const currentResponse = ch?.contribution_pct != null
      ? (num(ch.contribution_pct) / 100) * (totalSpend * (roi ?? 1))
      : spend * (roi ?? 1);
    const kappa = Math.max(spend, 1);
    const beta = Math.max(2 * currentResponse, 1); // asymptote = 2× current (current spend sits at half-saturation)
    curves.push({ channel, beta, kappa, slope: 1, currentSpend: spend, roi, derived: true });
    anyDerived = true;
  }
  return { curves, anyDerived };
}

/** Total predicted incremental sales for a spend allocation, plus the per-channel breakdown. */
export function predictSales(allocation: Record<string, number>, curves: ResponseCurve[]): {
  total: number;
  perChannel: { channel: string; spend: number; predicted: number }[];
} {
  const perChannel = curves.map((c) => {
    const spend = Math.max(0, num(allocation[c.channel]));
    return { channel: c.channel, spend, predicted: hillResponse(spend, c) };
  });
  return { total: perChannel.reduce((s, r) => s + r.predicted, 0), perChannel };
}

export interface OptimizeResult {
  budget: number;
  allocation: Record<string, number>;
  predictedSales: number;
  perChannel: { channel: string; spend: number; predicted: number; sharePct: number }[];
}

/** Greedy marginal-return ("water-filling") allocator: hand out the budget in `steps` increments, each to
 *  whichever channel currently has the highest marginal response. Deterministic; respects an optional
 *  per-channel cap (default: 3× the channel's current spend, min ฿10k, so no single channel absorbs it all).
 *  Concave Hill curves make the greedy split near-optimal. */
export function optimizeAllocation(
  budget: number,
  curves: ResponseCurve[],
  opts: { steps?: number; caps?: Record<string, number> } = {},
): OptimizeResult {
  const b = Math.max(0, num(budget));
  const steps = Math.min(Math.max(opts.steps ?? 200, 10), 2000);
  const spend: Record<string, number> = {};
  const cap: Record<string, number> = {};
  for (const c of curves) {
    spend[c.channel] = 0;
    cap[c.channel] = opts.caps?.[c.channel] != null ? Math.max(0, num(opts.caps[c.channel])) : Math.max(3 * c.currentSpend, 10_000);
  }
  const inc = b / steps;
  for (let i = 0; i < steps; i++) {
    let best: ResponseCurve | null = null;
    let bestGain = 0;
    for (const c of curves) {
      const cur = spend[c.channel] ?? 0;
      if (cur + inc > (cap[c.channel] ?? 0)) continue;
      const gain = hillResponse(cur + inc, c) - hillResponse(cur, c);
      if (gain > bestGain) { bestGain = gain; best = c; }
    }
    if (!best) break; // every channel capped
    spend[best.channel] = (spend[best.channel] ?? 0) + inc;
  }
  const pred = predictSales(spend, curves);
  return {
    budget: b,
    allocation: spend,
    predictedSales: pred.total,
    perChannel: pred.perChannel.map((r) => ({
      channel: r.channel,
      spend: r.spend,
      predicted: r.predicted,
      sharePct: b > 0 ? (r.spend / b) * 100 : 0,
    })),
  };
}
