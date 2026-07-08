/**
 * Wave 2 · 1.6 — plan-change proration ToE (pure).
 * Verifies computeProration: upgrade charges the net, downgrade credits it, an expired/absent period
 * prorates nothing, a full period = full delta, and same-price = 0.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover proration
 */
import { computeProration } from '../../../apps/api/dist/modules/billing/proration';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
const DAY = 86_400_000;

async function main() {
  const now = 1_800_000_000_000; // fixed reference
  const end15 = new Date(now + 15 * DAY); // 15 of 30 days remaining → fraction 0.5

  // Standard: ฿1,900 → ฿9,900 mid-cycle (half the period left).
  const up = computeProration({ oldPriceMonthly: 1900, newPriceMonthly: 9900, periodEnd: end15, now });
  ok('upgrade: unused credit 950 (1900×0.5)', near(up.unused_credit, 950), JSON.stringify(up));
  ok('upgrade: new charge 4950 (9900×0.5)', near(up.new_charge, 4950));
  ok('upgrade: net +4000 (charge the customer)', near(up.net, 4000));
  ok('upgrade: fraction 0.5, days_remaining 15', near(up.fraction, 0.5) && near(up.days_remaining, 15));

  // Downgrade ฿9,900 → ฿1,900: net negative = credit.
  const down = computeProration({ oldPriceMonthly: 9900, newPriceMonthly: 1900, periodEnd: end15, now });
  ok('downgrade: net −4000 (credit the customer)', near(down.net, -4000), JSON.stringify(down));

  // Expired period (end in the past) → nothing to prorate.
  const expired = computeProration({ oldPriceMonthly: 1900, newPriceMonthly: 9900, periodEnd: new Date(now - 5 * DAY), now });
  ok('expired period → fraction 0, net 0', near(expired.fraction, 0) && near(expired.net, 0));

  // No period info → net 0.
  const noEnd = computeProration({ oldPriceMonthly: 1900, newPriceMonthly: 9900, periodEnd: null, now });
  ok('null period → net 0', near(noEnd.net, 0));

  // Full period remaining (30 days) → full delta.
  const full = computeProration({ oldPriceMonthly: 1900, newPriceMonthly: 9900, periodEnd: new Date(now + 30 * DAY), now });
  ok('full period → net = full delta (9900−1900 = 8000)', near(full.net, 8000) && near(full.fraction, 1));

  // Same price → net 0 even mid-cycle.
  const same = computeProration({ oldPriceMonthly: 2900, newPriceMonthly: 2900, periodEnd: end15, now });
  ok('same price → net 0', near(same.net, 0));

  // Beyond-period clamp: end far in the future clamps days_remaining to period_days.
  const clamp = computeProration({ oldPriceMonthly: 1900, newPriceMonthly: 9900, periodEnd: new Date(now + 90 * DAY), now });
  ok('far-future end clamps to period (fraction ≤ 1)', clamp.fraction <= 1 && near(clamp.days_remaining, 30));

  // 1.7 — ANNUAL interval: an annual subscription prorates on a 365-day period. 100 of 365 days left,
  // Standard ฿19,000/yr → Professional ฿99,000/yr.
  const ann = computeProration({ oldPriceMonthly: 19000, newPriceMonthly: 99000, periodEnd: new Date(now + 100 * DAY), now, periodDays: 365 });
  ok('annual basis: periodDays 365 honoured (days_remaining 100, fraction 100/365)', ann.period_days === 365 && near(ann.days_remaining, 100) && Math.abs(ann.fraction - 100 / 365) < 1e-4, JSON.stringify(ann));
  ok('annual: net = 99000×(100/365) − 19000×(100/365) ≈ 21,917.81', near(ann.net, 27123.29 - 5205.48), `net=${ann.net}`);

  console.log('\n── Wave 2 · 1.6 — plan-change proration (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} proration checks failed` : `\n✅ All ${checks.length} proration checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
