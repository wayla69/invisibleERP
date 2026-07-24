import type { DenseSeries } from './scm-planning.types';

// docs/56 A4 — donor selection for zero/low-history cold-start. A brand-new SKU cannot be fit, but the
// weekly/payday/holiday SHAPE of demand is largely driven by the branch (outlet + clientele), so a new
// series borrows the pooled shape of ESTABLISHED siblings in the SAME branch; the engine rescales that
// shape by the new SKU's own baseline seed (A4, forecasting.py `_analog_paths`). Same-branch siblings are
// a sound first-cut donor pool; category/attribute-nearest refinement is a future enhancement.

const ANALOG_MAX_HISTORY = 56; // a series shorter than this (the Prophet floor) is "too new" to fit
const ANALOG_DONOR_MIN = 90; // a donor needs a solid history for its shape to be worth borrowing
const MAX_DONORS = 5;

/** For each too-new series in a branch, the donor series_ids (established same-branch siblings). */
export function analogDonors(branchSeries: DenseSeries[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const established = branchSeries
    .filter((s) => s.values.length >= ANALOG_DONOR_MIN)
    .map((s) => s.itemId);
  if (!established.length) return out;
  for (const s of branchSeries) {
    if (s.values.length >= ANALOG_MAX_HISTORY) continue; // has enough history to fit its own model
    const donors = established.filter((d) => d !== s.itemId).slice(0, MAX_DONORS);
    if (donors.length) out.set(s.itemId, donors);
  }
  return out;
}
