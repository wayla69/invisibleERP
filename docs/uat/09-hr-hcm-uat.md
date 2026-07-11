# UAT — Cycle 09: Human Resources (HCM)

**Status: DRAFT v0.1 · 2026-07-11** · *v0.1: HR-2 leave accrual engine + policies + entitlement gate (control HR-02, migration 0321) — UAT-HR-01..08.* · Cross-ref: process narrative `docs/process-narratives/29-human-resources.md` (HR-02), harness `tools/cutover/src/hcm-leave.ts` (17 checks).

> This cycle is built up wave-by-wave; each HR feature owns a self-contained block so parallel PRs merge keep-both.

Result legend: Pass / Fail / Blocked / N/A / Not Run. Balance formula = `entitled + accrued + carryover − used − expired`. Error codes/amounts are exact.

## HR-2 — Leave accrual engine + policies (control HR-02)

| Test ID | Scenario/Title | Role | Preconditions | Test steps | Test data | Expected result | Priority | Type | Traceability | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| UAT-HR-01 | Create leave type with accrual policy | HR admin (`hr_admin`/`exec`) | — | 1. `POST /api/hcm/leave/types`. | `{code:ANNUAL, accrual_method:monthly, accrual_rate_days:1.25, carryover_cap_days:5, max_balance_days:30}` | Created; tenant-scoped; `accrual_method` monthly. | High | Positive | HR-02 | Not Run | hcm-leave.ts |
| UAT-HR-02 | Policy override by grade | HR admin | ANNUAL type exists | 1. `POST /api/hcm/leave/policies`. | `{leave_type_code:ANNUAL, job_grade:M2, accrual_rate_days:2.0}` | Created; M2 rate 2.0 overrides the type default 1.25. | High | Positive | HR-02 | Not Run | hcm-leave.ts |
| UAT-HR-03 | Accrual run credits `accrued` (policy vs default) | HR admin | type + policy; employees A(M2), B(M1) | 1. `POST /api/hcm/leave/accrual/run {period:2026-06}`. 2. `GET /api/hcm/leave/balances?emp_code=`. | period 2026-06 | Run OK; A accrued **2.0** (M2 policy); B accrued **1.25** (type default); `employees_count` counts active staff. | High | Positive | HR-02 | Not Run | hcm-leave.ts |
| UAT-HR-04 | Accrual run idempotent per period | HR admin | 2026-06 already run | 1. Re-run `POST .../accrual/run {period:2026-06}`. | — | `already: true`; balances unchanged (no double-accrual). | High | Control | HR-02 | Not Run | hcm-leave.ts |
| UAT-HR-05 | Carryover cap applied at year boundary | HR admin | prior-year (2025) balance 8 d; cap 5 | 1. Run the first 2026 accrual. 2. Inspect the 2026 + 2025 balance rows. | — | 2026 `carryover` = **5** (min of 8 vs cap 5); 2025 `expired` = **3** (excess lost). | High | Control | HR-02 | Not Run | hcm-leave.ts |
| UAT-HR-06 | Request within balance is accepted | HR / ESS | A available 2.0 | 1. `POST /api/hcm/leave {leave_type:ANNUAL, days:1.5, paid:true}`. | 1.5 d | Pending; no error. | High | Positive | HR-02 | Not Run | hcm-leave.ts |
| UAT-HR-07 | Request over balance is blocked (HR-02 gate) | HR / ESS | B available 1.25 | 1. `POST /api/hcm/leave {leave_type:ANNUAL, days:2, paid:true}`. | 2 d | **400 `INSUFFICIENT_LEAVE_BALANCE`**. Unpaid leave (`paid:false`) is not gated. | High | Control | HR-02 | Not Run | hcm-leave.ts |
| UAT-HR-08 | Leave approval stays maker-checker | HR + approver | pending paid request | 1. Requester approves own request. 2. A distinct approver approves. | — | (1) 403 `SOD_SELF_APPROVAL`; (2) Approved → `used` += days, `available` falls. | High | Control | HR-02 | Not Run | hcm-leave.ts |
| UAT-HR-09 | RLS — leave config/balances scoped to own tenant | HR (T2) | T1 has ANNUAL type + 3 employees | 1. `GET /api/hcm/leave/types` as T2. 2. `POST .../accrual/run` as T2. | bearer T2 | T2 sees only its own leave types (no T1 leakage); the T2 run counts only T2 employees. | High | Control | HR-02, ITGC-AC (RLS) | Not Run | hcm-leave.ts |
