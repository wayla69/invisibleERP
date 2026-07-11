# UAT — Cycle 09: Human Resources (HCM)

**Status: DRAFT v0.1 · 2026-07-11** · *v0.1: HR-2 leave accrual (control HR-02, migration 0321) — UAT-HR-01..09; HR-3 performance management (control HR-03, migration 0322) — UAT-HR-300..312; HR-6 compensation bands + benefits (control HR-06, migration 0325) — UAT-HR-600..615.* · Cross-ref: `docs/process-narratives/29-human-resources.md`; harnesses `tools/cutover/src/hcm-leave.ts` (17), `tools/cutover/src/hcm-perf.ts` (17), `tools/cutover/src/hcm-comp.ts` (23).

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

## Test cases — Performance management (HR-3)

| ID | Type | Precondition | Steps | Expected result |
|---|---|---|---|---|
| UAT-HR-300 | Positive | HR user (`hr`) | `POST /api/hcm/performance/cycles` `{name:"H1-2026",…}` | 201, status `open` |
| UAT-HR-301 | Positive | Cycle exists | Add two goals for EMP1 with weights 60 + 40 | Both created; weights total 100% |
| UAT-HR-302 | Negative (control) | Goals total 100% | Add a third goal weight 10 for EMP1 | 400 `WEIGHT_EXCEEDED` |
| UAT-HR-303 | Positive | Goal exists | `PATCH …/goals/:id` `{progress_pct:50}` | 200, progress 50% |
| UAT-HR-304 | Positive | Cycle open | `POST …/reviews` `{cycle_id,emp_code:EMP1,self_rating:4}` | 201, status `self` |
| UAT-HR-305 | Negative (control) | Review in `self` | `POST …/reviews/:id/sign` (no manager rating) | 400 `NO_MANAGER_RATING` |
| UAT-HR-306 | Negative (control) | Review in `self` | `POST …/reviews/:id/manager` `{manager_emp_code:EMP1,…}` (== reviewee) | 403 `SOD_SELF_REVIEW` |
| UAT-HR-307 | Positive | Review in `self` | `POST …/reviews/:id/manager` `{manager_emp_code:EMP2,manager_rating:4.5}` | 200, status `manager` |
| UAT-HR-308 | Negative (control) | Reviewee's own login (linked to EMP1) | `POST …/reviews/:id/sign` on own review | 403 `SOD_SELF_REVIEW` (or perm gate 403) |
| UAT-HR-309 | Positive | Review has manager rating; signer ≠ reviewee | `POST …/reviews/:id/sign` `{calibrated_rating:4.25}` | 200, status `signed`, `signed_by` set |
| UAT-HR-310 | Positive | Cycle open | `POST …/cycles/:id/close` | 200, status `closed` |
| UAT-HR-311 | Negative | Cycle closed | Add a goal to the closed cycle | 400 `CYCLE_CLOSED` |
| UAT-HR-312 | Security (RLS) | Tenant T2 HR user | `GET …/cycles` and `…/reviews?cycle_id=<T1>` | No T1 rows returned (tenant isolation) |

## Traceability

| Requirement | Control | Test cases | Harness |
|---|---|---|---|
| Review sign-off SoD (reviewer ≠ reviewee; manager rating required; goal weights ≤ 100%) | HR-03 | UAT-HR-300..312 | `tools/cutover/src/hcm-perf.ts` (17 checks) |

## Test cases — Compensation bands + benefits (HR-6, control HR-06)

Grade fixture: **G5** band `[25000, 40000]`. Employees: EMP1 (30000), EMP2 (28000, linked to an `ess` login).

| ID | Type | Precondition | Steps | Expected result |
|---|---|---|---|---|
| UAT-HR-600 | Positive | — | `POST /api/hcm/comp/grades` `{grade_code:G5,name,min_salary:25000,mid_salary:32500,max_salary:40000}` | 201; grade created; tenant-scoped |
| UAT-HR-601 | Negative | G5 exists | Re-`POST` grade `G5` | 400 `GRADE_EXISTS` |
| UAT-HR-602 | Positive | G5 exists | `POST /api/hcm/comp/changes` `{emp_code:EMP1,change_type:merit,new_salary:35000,new_grade:G5}` | 201; status `pending`; `out_of_band_overridden:false`; employee salary NOT yet changed |
| UAT-HR-603 | Negative (control) | G5 exists | `POST …/changes` `{emp_code:EMP1,new_salary:50000,new_grade:G5}` as `hr` maker | 400 `OUT_OF_BAND` |
| UAT-HR-604 | Negative (control) | G5 exists | Same out-of-band request as `hr_admin` **without** the override flag | 400 `OUT_OF_BAND` |
| UAT-HR-605 | Positive (control) | G5 exists | Same out-of-band request as `exec` with `override:true` | 201; `out_of_band_overridden:true`; a `doc_status_log` `COMPCHG` `OUT_OF_BAND_OVERRIDE` row written |
| UAT-HR-606 | Negative (control) | A change requested by user X | X (requester) `POST …/changes/:id/approve` | 403 `SOD_SELF_APPROVAL`; salary unchanged |
| UAT-HR-607 | Positive (control) | Pending change on EMP1 to 35000 requested by another user | Distinct `hr_admin`/`exec` `POST …/changes/:id/approve` | 200 `approved`; `employees.monthly_salary` = **35000** (written only on approval) |
| UAT-HR-608 | Positive (control) | Pending change on EMP2 | Distinct user `POST …/changes/:id/reject` | 200 `rejected`; `employees.monthly_salary` unchanged (still 28000) |
| UAT-HR-609 | Negative | Pending change | `hr`-only maker `POST …/changes/:id/approve` | 403 (approval reserved to `hr_admin`/`exec`) |
| UAT-HR-610 | Positive | — | `POST /api/hcm/comp/benefit-plans` `{plan_code:HMO,category:health,employer_cost,employee_cost}` | 201; plan created |
| UAT-HR-611 | Positive | HMO exists | `POST /api/hcm/comp/enrollments` `{emp_code:EMP1,plan_code:HMO}` | 201; status `active` |
| UAT-HR-612 | Negative | EMP1 active on HMO | Re-`POST` the same enrolment | 400 `ALREADY_ENROLLED` |
| UAT-HR-613 | Positive | Active enrolment | `POST /api/hcm/comp/enrollments/:id/end` | 200; status `ended`; `end_date` set |
| UAT-HR-614 | Security (own-scope) | `ess` login linked to EMP2, enrolments exist for EMP1+EMP2 | `GET /api/hcm/comp/enrollments` as `ess` | Only EMP2's enrolments returned (own-scope) |
| UAT-HR-615 | Security (RLS) | Tenant T2 admin creates grade `T2G` | `GET /api/hcm/comp/grades` as T1 vs T2 | T1 sees G5 not T2G; T2 sees T2G not G5 (tenant isolation) |

## Traceability — HR-6

| Requirement | Control | Test cases | Harness |
|---|---|---|---|
| Comp-change within pay band + maker-checker (OUT_OF_BAND unless exec override; approver ≠ requester; employee master updated only on approval); benefit plan enrolment | HR-06 | UAT-HR-600..615 | `tools/cutover/src/hcm-comp.ts` (23 checks) |
