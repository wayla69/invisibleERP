import { describe, it, expect } from 'vitest';
import { computePlanBacktest } from '../src/modules/marketing-intel/plan-backtest';

// Plan-vs-actual budget reconciliation (docs/62 Phase 2, control MKT-26). Pure, deterministic.

describe('computePlanBacktest', () => {
  it('computes per-channel variance, totals and adherence (the MKT-26 math)', () => {
    const b = computePlanBacktest(
      { facebook: 30000, google: 20000 },
      { facebook: { spend: 33000, roi: 3.1 }, google: { spend: 18000, roi: 2.0 } },
    );
    const fb = b.rows.find((r) => r.channel === 'facebook')!;
    expect(fb.variance).toBe(3000);
    expect(fb.variance_pct).toBe(10);
    expect(fb.roi).toBe(3.1);
    expect(fb.flag).toBe(false); // 10% ≤ default 20%
    expect(b.planned_total).toBe(50000);
    expect(b.actual_total).toBe(51000);
    // Σ|variance| = 5000 → adherence = 100 − 10 = 90
    expect(b.adherence_pct).toBe(90);
    expect(b.flagged_count).toBe(0);
  });

  it('flags a channel whose |variance| exceeds flagPct% of planned', () => {
    const b = computePlanBacktest({ facebook: 10000 }, { facebook: { spend: 13001 } }, { flagPct: 30 });
    expect(b.rows[0]!.flag).toBe(true);   // 30.01% > 30%
    const ok = computePlanBacktest({ facebook: 10000 }, { facebook: { spend: 13000 } }, { flagPct: 30 });
    expect(ok.rows[0]!.flag).toBe(false); // exactly 30% is within tolerance
  });

  it('ALWAYS flags unplanned spend (planned 0, actual > 0) with a null variance_pct', () => {
    const b = computePlanBacktest({ facebook: 10000 }, { facebook: { spend: 10000 }, tiktok: { spend: 500 } });
    const tk = b.rows.find((r) => r.channel === 'tiktok')!;
    expect(tk.flag).toBe(true);
    expect(tk.variance_pct).toBeNull();
    expect(tk.variance).toBe(500);
  });

  it('shows planned-but-unspent channels (actual missing → 0) as a finding', () => {
    const b = computePlanBacktest({ facebook: 10000, line: 5000 }, { facebook: { spend: 10000 } });
    const ln = b.rows.find((r) => r.channel === 'line')!;
    expect(ln.actual).toBe(0);
    expect(ln.variance).toBe(-5000);
    expect(ln.flag).toBe(true); // 100% under plan > 20%
  });

  it('drops channels with neither plan nor spend and survives an empty plan (adherence 0)', () => {
    const b = computePlanBacktest({ facebook: 0 }, { facebook: { spend: 0 } });
    expect(b.rows).toHaveLength(0);
    expect(b.adherence_pct).toBe(0);
    expect(b.flagged_count).toBe(0);
  });

  it('floors adherence at 0 when actuals wildly diverge', () => {
    const b = computePlanBacktest({ facebook: 1000 }, { facebook: { spend: 5000 } });
    expect(b.adherence_pct).toBe(0); // |4000|/1000 = 400% overshoot
    expect(b.rows[0]!.flag).toBe(true);
  });

  it('ignores negative/garbage inputs (clamped to 0) and rounds to 2dp', () => {
    const b = computePlanBacktest({ facebook: 100.005, bad: -50 }, { facebook: { spend: 99.994 } });
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]!.planned).toBeCloseTo(100.01, 2);
    expect(b.rows[0]!.actual).toBeCloseTo(99.99, 2);
  });

  it('is deterministic — same inputs, same output (rows sorted by channel)', () => {
    const alloc = { z: 10, a: 20 };
    const actual = { a: { spend: 20 }, z: { spend: 5 } };
    expect(computePlanBacktest(alloc, actual)).toEqual(computePlanBacktest(alloc, actual));
    expect(computePlanBacktest(alloc, actual).rows.map((r) => r.channel)).toEqual(['a', 'z']);
  });
});
