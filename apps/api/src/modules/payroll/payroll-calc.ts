// Thai payroll math — Social Security (ประกันสังคม) + PIT withholding for ภ.ง.ด.1.
// Pure, deterministic functions (no DB, no side effects) so they're unit-testable in isolation.

export const SSO_RATE = 0.05;          // 5% employee + 5% employer
export const SSO_BASE_MIN = 1650;      // contribution base floor
export const SSO_BASE_MAX = 15000;     // base ceiling → max 750/month each side

// Personal income tax brackets on ANNUAL net taxable income (Revenue Code, 2017+ rates).
const PIT_BRACKETS: { upTo: number; rate: number }[] = [
  { upTo: 150000, rate: 0 },
  { upTo: 300000, rate: 0.05 },
  { upTo: 500000, rate: 0.10 },
  { upTo: 750000, rate: 0.15 },
  { upTo: 1000000, rate: 0.20 },
  { upTo: 2000000, rate: 0.25 },
  { upTo: 5000000, rate: 0.30 },
  { upTo: Infinity, rate: 0.35 },
];

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Social security: 5% of salary, base clamped to [1650, 15000] → contribution ≤ 750 each side.
export function socialSecurity(monthlySalary: number, eligible = true): { employee: number; employer: number } {
  if (!eligible || monthlySalary <= 0) return { employee: 0, employer: 0 };
  const base = Math.min(Math.max(monthlySalary, SSO_BASE_MIN), SSO_BASE_MAX);
  const c = r2(base * SSO_RATE);
  return { employee: c, employer: c };
}

// Progressive annual PIT on net taxable income.
export function annualPit(netTaxable: number): number {
  let tax = 0, lower = 0;
  for (const b of PIT_BRACKETS) {
    if (netTaxable <= lower) break;
    tax += (Math.min(netTaxable, b.upTo) - lower) * b.rate;
    lower = b.upTo;
  }
  return r2(tax);
}

// Monthly ภ.ง.ด.1 withholding via the annualization method: estimate annual tax on annualized salary
// (after the 50%-capped-100k expense deduction, 60k personal allowance, and SSO), then divide by 12.
export function monthlyWht(monthlySalary: number, ssoEmployeeMonthly: number, allowances = 0): number {
  if (monthlySalary <= 0) return 0;
  const annual = monthlySalary * 12;
  const expenseDed = Math.min(annual * 0.5, 100000);
  const personal = 60000;
  const ssoAnnual = Math.min(ssoEmployeeMonthly * 12, 9000);
  const taxable = Math.max(0, annual - expenseDed - personal - ssoAnnual - allowances);
  return r2(annualPit(taxable) / 12);
}

export interface PayslipCalc {
  gross: number;
  sso_employee: number;
  sso_employer: number;
  wht: number;
  net: number;
}

// Full monthly payslip for one employee.
export function computePayslip(monthlySalary: number, ssoEligible = true, allowances = 0): PayslipCalc {
  const gross = r2(monthlySalary);
  const sso = socialSecurity(gross, ssoEligible);
  const wht = monthlyWht(gross, sso.employee, allowances);
  const net = r2(gross - sso.employee - wht);
  return { gross, sso_employee: sso.employee, sso_employer: sso.employer, wht, net };
}
