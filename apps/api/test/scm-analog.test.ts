import { describe, it, expect } from 'vitest';
import { analogDonors } from '../src/modules/scm-planning/scm-analog';
import type { DenseSeries } from '../src/modules/scm-planning/scm-planning.types';

// docs/56 A4 — donor selection for cold-start. A too-new series (short dense history) borrows the pooled
// shape of ESTABLISHED same-branch siblings; the engine rescales that shape by the new SKU's own seed.

const series = (itemId: string, days: number, branchId: number | null = 1): DenseSeries => ({
  branchId,
  itemId,
  startDate: '2026-01-01',
  values: Array.from({ length: days }, () => 1),
});

describe('A4 donor selection (analogDonors)', () => {
  it('a too-new series borrows established same-branch siblings', () => {
    const out = analogDonors([series('OLD-A', 120), series('OLD-B', 100), series('NEW', 10)]);
    expect(out.get('NEW')).toEqual(['OLD-A', 'OLD-B']);
    expect(out.has('OLD-A')).toBe(false); // established series do not borrow
  });

  it('never lists a series as its own donor', () => {
    const out = analogDonors([series('OLD-A', 120), series('NEW', 20)]);
    expect(out.get('NEW')).toEqual(['OLD-A']);
    expect(out.get('NEW')).not.toContain('NEW');
  });

  it('returns nothing when there are no established donors', () => {
    // all series are short → no donor pool → no borrowing (falls back to own-history forecasting)
    expect(analogDonors([series('N1', 10), series('N2', 20)]).size).toBe(0);
  });

  it('a series with enough history to fit is not treated as new', () => {
    const out = analogDonors([series('OLD-A', 120), series('MID', 56)]);
    expect(out.has('MID')).toBe(false); // 56 == the fit floor → not new
  });

  it('caps the donor list at five', () => {
    const many = Array.from({ length: 8 }, (_, i) => series(`OLD-${i}`, 120));
    const out = analogDonors([...many, series('NEW', 5)]);
    expect(out.get('NEW')).toHaveLength(5);
  });
});
