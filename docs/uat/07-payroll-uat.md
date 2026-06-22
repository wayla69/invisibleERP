# UAT — Cycle 07: Payroll

**Status: DRAFT v0.1 · 2026-06-22** · Cross-ref: process narrative `05-payroll.md` (PAY-01..02, GL-01), harness `tools/cutover/src/payroll.ts`.

Result legend: Pass / Fail / Blocked / N/A / Not Run. Social security (SSO) = 5%, monthly cap 750. Error codes/amounts are exact.

| Test ID | Scenario/Title | Role | Preconditions | Test steps | Test data | Expected result | Priority | Type | Traceability | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| UAT-PAY-001 | Create employees (auto emp_code) | Admin/HCM | — | 1. `POST /api/payroll/employees` ×2. | Somchai 30,000; Malee 12,000 | Created; `emp_code` `EMP*`, tenant-scoped. | High | Positive | PAY-01 | Not Run | payroll.ts |
| UAT-PAY-002 | List active employees | Admin | 2 employees | 1. `GET /api/payroll/employees`. | — | `count`=2. | Med | Positive | PAY-01 | Not Run | payroll.ts |
| UAT-PAY-003 | Run monthly payroll posts GL | Admin | 2 employees | 1. `POST /api/payroll/runs?period=2026-06`. | period 2026-06 | `entry_no` JE-; `headcount`=2. | High | Positive | PAY-01, GL-01 | Not Run | payroll.ts |
| UAT-PAY-004 | SSO cap + WHT + net totals correct | Admin | Payroll run done | 1. Inspect run totals. | gross 42,000 | gross 42,000; SSO ee 1,350; SSO er 1,350; WHT 170.83; net 40,479.17. | High | Positive | PAY-01 | Not Run | payroll.ts |
| UAT-PAY-005 | SSO 5% capped at 750 (high earner) | Admin | Somchai 30,000 | 1. `GET /api/payroll/runs/2026-06/slips`; inspect Somchai. | — | Somchai net 29,079.17 (30,000 − 750 SSO cap − 170.83 WHT). | High | Control | PAY-01 | Not Run | payroll.ts |
| UAT-PAY-006 | SSO uncapped below cap (low earner) | Admin | Malee 12,000 | 1. Inspect Malee slip / totals. | — | Malee SSO = 600 (5% of 12,000, below cap); no WHT. | Med | Positive | PAY-01 | Not Run | payroll.ts |
| UAT-PAY-007 | GL expense + payables correct | GlAccountant | Payroll run | 1. `GET /api/ledger/trial-balance`. | — | 5600 Salaries dr 42,000; 5610 Employer-SSO dr 1,350; 2350 SSO payable cr 2,700 (ee+er); 2360 WHT payable cr 170.83; balanced. | High | Control | PAY-01, GL-01 | Not Run | payroll.ts |
| UAT-PAY-008 | Payroll run idempotent per period | Admin | 2026-06 already run | 1. Re-run `POST /api/payroll/runs?period=2026-06`. | — | `already: true` (no duplicate JE). | Med | Control | PAY-01 | Not Run | payroll.ts |
| UAT-PAY-009 | ภ.ง.ด.1 monthly WHT summary | Admin | Payroll run | 1. `GET /api/payroll/pnd1?period=2026-06`. | — | `headcount`=2; total_income 42,000; total_wht 170.83. | High | Positive | PAY-02 | Not Run | payroll.ts |
| UAT-PAY-010 | Payslips retrievable per employee | Admin | Payroll run | 1. `GET /api/payroll/runs/2026-06/slips`. | — | `count`=2; per-employee net present and correct. | Med | Positive | PAY-01 | Not Run | payroll.ts |
| UAT-PAY-011 | PIT/WHT withholding computed | Admin | Payroll run | 1. Inspect WHT line for Somchai. | — | PIT/WHT 170.83 withheld from gross. | Med | Positive | PAY-02 | Not Run | payroll.ts |
| UAT-PAY-012 | RLS — payroll scoped to own tenant | HCM (T2) | T1 employees exist | 1. `GET /api/payroll/employees` as T2 user. | bearer T2 | Only T2 employees visible; no T1 leakage. | High | Control | ITGC-AC (RLS) | Not Run | — |
| UAT-PAY-013 | Permission — non-HCM cannot run payroll | Cashier | — | 1. `POST /api/payroll/runs?period=2026-06` as Cashier. | bearer cashier | 403 Forbidden. | Med | Control | ITGC-AC-07 | Not Run | — |
