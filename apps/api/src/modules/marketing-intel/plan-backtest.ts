// Plan-vs-actual budget reconciliation — the PURE, deterministic backtest core (docs/62 Phase 2, control
// MKT-26). No DB, no IO — an approved plan's channel allocation in, the actual per-channel spend in, the
// variance table out; unit-tested (plan-backtest.test.ts) like every other marketing scoring core.
//
// Semantics: a channel present on EITHER side appears in the table (planned-but-unspent and
// spent-but-unplanned are both findings, not noise). variance = actual − planned; a row is FLAGGED when
// |variance| exceeds flagPct% of the planned amount (an unplanned channel — planned 0, actual > 0 — is
// always flagged: spend appeared that no approved plan authorized). adherence = 100 − Σ|variance| as a
// share of the planned total, floored at 0 — "how closely did the money follow the approved plan".

export interface BacktestRow {
  channel: string;
  planned: number;
  actual: number;
  variance: number;       // actual − planned
  variance_pct: number | null; // vs planned (null when planned = 0)
  roi: number | null;     // the channel's realized ROI from the actuals source (advisory context)
  flag: boolean;          // |variance| > flagPct% of planned, or unplanned spend
}

export interface PlanBacktest {
  rows: BacktestRow[];
  planned_total: number;
  actual_total: number;
  adherence_pct: number;  // 100 − (Σ|variance| / planned_total × 100), floored 0 (null-safe: 0 when no plan)
  flagged_count: number;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

export function computePlanBacktest(
  allocation: Record<string, unknown>,
  actualByChannel: Record<string, { spend: number; roi?: number | null }>,
  opts?: { flagPct?: number },
): PlanBacktest {
  const flagPct = Math.max(0, Number(opts?.flagPct ?? 20) || 20);
  const channels = [...new Set([...Object.keys(allocation ?? {}), ...Object.keys(actualByChannel ?? {})])].sort();

  const rows: BacktestRow[] = [];
  let plannedTotal = 0;
  let actualTotal = 0;
  let absVarianceTotal = 0;
  for (const ch of channels) {
    const planned = Math.max(0, Number(allocation?.[ch]) || 0);
    const actual = Math.max(0, Number(actualByChannel?.[ch]?.spend) || 0);
    if (planned === 0 && actual === 0) continue; // nothing to reconcile on this channel
    const variance = actual - planned;
    const flag = planned > 0 ? Math.abs(variance) > (flagPct / 100) * planned : actual > 0; // unplanned spend always flags
    rows.push({
      channel: ch,
      planned: r2(planned),
      actual: r2(actual),
      variance: r2(variance),
      variance_pct: planned > 0 ? r2((variance / planned) * 100) : null,
      roi: actualByChannel?.[ch]?.roi == null ? null : Number(actualByChannel[ch]!.roi),
      flag,
    });
    plannedTotal += planned;
    actualTotal += actual;
    absVarianceTotal += Math.abs(variance);
  }

  return {
    rows,
    planned_total: r2(plannedTotal),
    actual_total: r2(actualTotal),
    adherence_pct: plannedTotal > 0 ? r2(Math.max(0, 100 - (absVarianceTotal / plannedTotal) * 100)) : 0,
    flagged_count: rows.filter((r) => r.flag).length,
  };
}
