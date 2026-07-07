// Wave 2 · 1.6 — plan-change proration (pure, unit-testable).
// changePlan previously just flipped the plan column with no mid-cycle adjustment. This computes the
// unused credit on the OLD plan and the prorated charge on the NEW plan for the days remaining in the
// billing period, so an upgrade/downgrade is fair. Informational for now (returned by changePlan for the
// UI to confirm); the Stripe proration-invoice-item is a follow-up.
//
// No explicit period-start is stored, so a fixed `periodDays` (default 30) window back from
// current_period_end is assumed — the standard monthly-subscription convention.

export interface Proration {
  days_remaining: number;   // clamped to [0, period_days]
  period_days: number;
  fraction: number;         // days_remaining / period_days
  unused_credit: number;    // old plan value not yet consumed (credit back)
  new_charge: number;       // new plan cost for the remaining days
  net: number;              // new_charge − unused_credit; >0 = charge the customer now, <0 = credit
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function computeProration(opts: {
  oldPriceMonthly: number;
  newPriceMonthly: number;
  periodEnd: Date | string | null | undefined;
  now: number;
  periodDays?: number;
}): Proration {
  const periodDays = opts.periodDays && opts.periodDays > 0 ? opts.periodDays : 30;
  const end = opts.periodEnd ? new Date(opts.periodEnd).getTime() : NaN;
  const daysRemaining = Number.isFinite(end)
    ? Math.max(0, Math.min(periodDays, (end - opts.now) / 86_400_000))
    : 0; // no/expired period info → nothing to prorate
  const fraction = daysRemaining / periodDays;
  const unused_credit = r2((Number(opts.oldPriceMonthly) || 0) * fraction);
  const new_charge = r2((Number(opts.newPriceMonthly) || 0) * fraction);
  return {
    days_remaining: r2(daysRemaining),
    period_days: periodDays,
    fraction: Math.round(fraction * 1e6) / 1e6,
    unused_credit,
    new_charge,
    net: r2(new_charge - unused_credit),
  };
}
