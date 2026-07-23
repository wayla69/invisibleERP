// Segment × Channel ROI — the PURE, deterministic ranking core (docs/61 Phase 2, control MKT-25).
// No DB, no IO — same inputs always yield the same cells + allocation, so it is unit-tested
// (segment-channel-scoring.test.ts), like the MKT-17 optimiser and the MKT-23 propensity scorer.
//
// It extends the Budget Optimizer's CHANNEL view (MKT-17) to SEGMENT × CHANNEL cells: rank each cell by
// incremental ROI (real Phase-3 measured lift where an experiment exists, the MMM channel ROI where it does
// not) × the segment's value (reach × CLV), then split a budget toward the highest-return channels.

export interface SegmentValue { segment: string; count: number; avg_clv: number | null }
export interface ChannelRoi { channel: string; roi: number | null }

const r4 = (x: number): number => Math.round(x * 10000) / 10000;
const r2 = (x: number): number => Math.round(x * 100) / 100;

// A measured segment lift% (MKT-19) scales the channel's expected return: +900% lift → 10× the MMM ROI, a
// flat 0% → 1×, and a negative lift is floored at 0 (a proven-negative cell earns no incremental spend).
// A segment with NO experiment falls back to the MMM channel ROI alone (multiplier 1).
export function liftMultiplier(liftPct: number | null | undefined): number {
  if (liftPct == null || !Number.isFinite(liftPct)) return 1;
  return Math.max(0, 1 + liftPct / 100);
}

export interface RoiCell {
  segment: string;
  channel: string;
  channel_roi: number;
  lift_pct: number | null;      // measured Phase-3 lift for this segment (null = no experiment, MMM only)
  lift_multiplier: number;
  incremental_roi: number;      // channel_roi × lift_multiplier
  reach: number;                // segment size
  avg_clv: number | null;
  value_weight: number;         // reach × avg_clv
  score: number;                // incremental_roi × value_weight — where the next ฿ most plausibly returns
}

export interface SegmentChannelPlan {
  cells: RoiCell[];
  channel_allocation: Record<string, number>; // budget split by channel (sums to ~budget) — feeds MKT-17 staging
  total_score: number;
  basis: 'measured+mmm' | 'mmm' | 'none';
}

// Rank every segment × channel cell and split `budget` across channels proportional to the channel's summed
// cell score (where the facts say returns are highest). When there is no signal at all (no ROI, no value)
// the budget splits evenly so the plan is still well-formed. Deterministic ordering throughout.
export function rankSegmentChannel(
  segments: SegmentValue[],
  channels: ChannelRoi[],
  liftBySegment: Map<string, number | null>,
  budget: number,
  opts?: { top?: number },
): SegmentChannelPlan {
  const top = Math.min(Math.max(Number(opts?.top ?? 50) || 50, 1), 500);
  const chans = channels.filter((c) => c.channel).map((c) => ({ channel: String(c.channel), roi: Number(c.roi) || 0 }));
  const cells: RoiCell[] = [];
  let anyLift = false;

  for (const s of segments) {
    const seg = String(s.segment ?? '—');
    const reach = Number(s.count) || 0;
    const clv = s.avg_clv == null ? null : Number(s.avg_clv);
    const value = reach * (clv ?? 0);
    const liftPct = liftBySegment.has(seg) ? liftBySegment.get(seg)! : null;
    if (liftPct != null) anyLift = true;
    const mult = liftMultiplier(liftPct);
    for (const c of chans) {
      const incRoi = c.roi * mult;
      cells.push({
        segment: seg, channel: c.channel, channel_roi: r4(c.roi), lift_pct: liftPct == null ? null : r2(liftPct),
        lift_multiplier: r4(mult), incremental_roi: r4(incRoi), reach, avg_clv: clv == null ? null : r2(clv),
        value_weight: r2(value), score: r4(incRoi * value),
      });
    }
  }

  cells.sort((a, b) => b.score - a.score || b.incremental_roi - a.incremental_roi || a.segment.localeCompare(b.segment) || a.channel.localeCompare(b.channel));

  // Channel allocation = budget × (channel's summed cell score ÷ total score). Even split when no signal.
  const scoreByChannel = new Map<string, number>();
  let totalScore = 0;
  for (const cell of cells) { scoreByChannel.set(cell.channel, (scoreByChannel.get(cell.channel) ?? 0) + cell.score); totalScore += cell.score; }
  const channel_allocation: Record<string, number> = {};
  const chanNames = chans.map((c) => c.channel);
  const b = Math.max(0, Number(budget) || 0);
  if (totalScore > 0) {
    for (const ch of chanNames) channel_allocation[ch] = r2(b * ((scoreByChannel.get(ch) ?? 0) / totalScore));
  } else if (chanNames.length) {
    const each = r2(b / chanNames.length);
    for (const ch of chanNames) channel_allocation[ch] = each;
  }

  return {
    cells: cells.slice(0, top),
    channel_allocation,
    total_score: r4(totalScore),
    basis: cells.length === 0 ? 'none' : anyLift ? 'measured+mmm' : 'mmm',
  };
}
