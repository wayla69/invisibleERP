import { describe, expect, it } from 'vitest';

import { computePayslipFull, monthlyWht, overtimePay } from '../src/modules/payroll/payroll-calc';

// Unit tests for the Phase-19 full payslip (2.4 slice 9 — the base functions socialSecurity/annualPit/
// monthlyWht/computePayslip are already pinned in test/unit.test.ts; this covers the OT + unpaid-leave +
// provident-fund extension and the OT pay rule, which had no tests).

describe('payroll — computePayslipFull (OT + unpaid leave + provident fund, Phase 19)', () => {
  it('PF on BASE salary (employer matches), SSO + PIT on GROSS — hand-computed case', () => {
    // base 30,000 + OT 2,000 − unpaid 1,000 → gross 31,000
    // SSO: base clamped at 15,000 → 750 each side
    // PF: 5% of BASE = 1,500 (not of gross — OT is not pensionable)
    // WHT (annualization): 372,000 − 100,000 expense cap − 60,000 personal − 9,000 SSO = 203,000 taxable
    //   → PIT 150k@0 + 53k@5% = 2,650 → 220.83/month
    const r = computePayslipFull({ monthlySalary: 30000, otPay: 2000, unpaidAmount: 1000, pfRate: 0.05 });
    expect(r).toEqual({
      base: 30000, gross: 31000, ot_pay: 2000, unpaid: 1000,
      sso_employee: 750, sso_employer: 750,
      pf_employee: 1500, pf_employer: 1500,
      wht: 220.83, net: 28529.17,
    });
    expect(r.wht).toBe(monthlyWht(31000, 750)); // WHT runs on gross, after-SSO — same engine as ภ.ง.ด.1
  });

  it('defaults: no OT/unpaid/PF collapses to the plain payslip; SSO-ineligible zeroes both sides', () => {
    const r = computePayslipFull({ monthlySalary: 12000, ssoEligible: false });
    expect(r).toMatchObject({ base: 12000, gross: 12000, ot_pay: 0, unpaid: 0, sso_employee: 0, sso_employer: 0, pf_employee: 0 });
    expect(r.net).toBe(12000 - r.wht);
  });
});

describe('payroll — overtimePay (Thai LPA ≥1.5×)', () => {
  it('hours × hourly rate × multiplier, defaulting to 1.5×; garbage degrades to 0', () => {
    expect(overtimePay(10, 100)).toBe(1500);
    expect(overtimePay(10, 100, 2)).toBe(2000);       // holiday OT etc.
    expect(overtimePay(0, 100)).toBe(0);
    expect(overtimePay(NaN as any, 100)).toBe(0);
    expect(overtimePay(3, 87.5)).toBe(393.75);        // r2 settlement rounding
  });
});
