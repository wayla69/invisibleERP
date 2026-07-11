# Doc 42 — HR / HCM Depth Uplift Plan

> Answers the module-depth audit (2026-07-11): payroll (PAY-01..06) and time-and-attendance are mature,
> but the surrounding **HR core is a stub** — `modules/hcm` is timesheet+leave request/approve only, leave
> balances are static (no accrual), and there is no org structure, performance, recruiting, onboarding,
> benefits or compensation model. This plan deepens `modules/hcm` into a real HCM suite on the existing
> `payroll.employees` master, in doc-synced PR-per-feature waves (same cadence as docs/41). Each feature:
> API + Drizzle schema/migration (journaled, next-free number, RLS loop for tenant tables) + RCM control
> (`build_rcm.py`) + `cutover/hcm` (or a new harness) ToE + web page + narrative/UAT/manual sync.

## Guiding principles
- Build on `payroll.employees` (empCode master) and the existing `hcm.leaveBalances`/`leave_requests`/
  `timesheets` — extend, do not fork the employee identity.
- Every approval path is maker-checker (approver ≠ subject), mirroring PAY-03.
- Thai-localized UI; PDPA-aware (employee PII already masked under PAY-06 — reuse that scoping).

## Wave 1 — HR foundation (independent tables, low collision)
- **HR-1 — Org structure & positions.** `hr_departments` (hierarchy + cost-center link), `hr_positions`
  (title, job grade, department, reports-to, budgeted headcount), effective-dated `hr_assignments`
  (employee→position). `GET/POST /api/hcm/org/departments|positions|assignments`; org-chart read. New
  control **HR-01** (position/headcount governance — a hire beyond budgeted headcount needs exec override).
  Web `/hcm/org`.
- **HR-2 — Leave accrual engine + policies.** `leave_types` (accrual method: monthly/anniversary/none,
  carryover cap, max balance), `leave_policies` (rate by grade/tenure), an idempotent **accrual run**
  (rides the BI scheduler like the GL jobs), extend `leave_balances` with accrued/carryover/expired.
  Negative-balance gate on request. New control **HR-02** (leave accrual + entitlement gate). Extends the
  existing leave request→approve.
- **HR-3 — Performance management.** `perf_cycles`, `perf_goals` (weighted OKRs), `perf_reviews`
  (self + manager rating, calibration, sign-off). Maker-checker: manager ≠ employee. New control **HR-03**
  (review sign-off SoD). Web `/hcm/performance`.

## Wave 2 — Talent lifecycle
- **HR-4 — Recruiting / ATS.** Requisitions (approve), candidates, application pipeline stages, offer →
  convert-to-employee. Control **HR-04** (requisition approval + offer authorization).
- **HR-5 — Onboarding / offboarding.** Checklist templates → per-employee task instances, provisioning
  hooks, exit clearance. Control **HR-05** (offboarding access-revocation completeness).
- **HR-6 — Compensation bands + benefits.** Pay grades/salary ranges, comp-change maker-checker (range
  compliance), benefit plans + enrollment. Control **HR-06** (comp-change within band, maker-checker).

## Wave 3 — Enablement & analytics
- **HR-7 — Training & certifications.** Courses, enrollments, completion, cert expiry alerts (scheduler).
- **HR-8 — ESS depth.** Org-chart/directory, goal self-service, benefits enrollment self-service on `/ess`.
- **HR-9 — Workforce analytics.** BI report types: headcount/turnover, leave-liability, span-of-control,
  performance distribution. (Read-only aggregators; no new control.)

## Sequencing
Wave 1 features are mutually independent (distinct tables) → build in parallel, merge one at a time.
Wave 2/3 build on Wave 1 (positions, employee master) → sequence after Wave 1 lands.
