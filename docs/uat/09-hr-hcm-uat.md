# UAT — Cycle 09: Human Resources (HCM)

**Status: DRAFT v0.1 · 2026-07-11** · *v0.1: HR-2 leave accrual (control HR-02, migration 0321) — UAT-HR-01..09; HR-3 performance management (control HR-03, migration 0322) — UAT-HR-300..312; HR-4 recruiting/ATS (control HR-04, migration 0323) — UAT-HR-400..413; HR-5 onboarding/offboarding lifecycle (control HR-05, migration 0324) — UAT-HR-500..515; HR-6 compensation bands + benefits (control HR-06, migration 0325) — UAT-HR-600..615.* · Cross-ref: `docs/process-narratives/29-human-resources.md`; harnesses `tools/cutover/src/hcm-leave.ts` (17), `tools/cutover/src/hcm-perf.ts` (17), `tools/cutover/src/hcm-recruiting.ts` (20), `tools/cutover/src/hcm-onboarding.ts` (27), `tools/cutover/src/hcm-comp.ts` (23).

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

## Test cases — Onboarding / offboarding lifecycle (HR-5, control HR-05)

| ID | Type | Precondition | Steps | Expected result |
|---|---|---|---|---|
| UAT-HR-500 | Positive | HR user (`hr`/`hr_admin`) | `POST /api/hcm/lifecycle/templates` `{code:ONB-STD,name,kind:onboarding}` | 201, `kind` onboarding |
| UAT-HR-501 | Positive | Template exists | `POST …/templates/:id/tasks` ×3 (docs, it_access, equipment) | Tasks appended with ascending `seq` |
| UAT-HR-502 | Positive | Offboarding template | Add task `{category:it_access, is_access_revocation:true}` | Task flagged `is_access_revocation` |
| UAT-HR-503 | Negative (SoD) | `exec`-only user | `POST …/templates` | 403 (writes gate `hr`/`hr_admin`; exec is read-only) |
| UAT-HR-504 | Negative | Template `ONB-STD` exists | `POST …/templates {code:ONB-STD}` | 400 `TEMPLATE_EXISTS` |
| UAT-HR-505 | Positive | Employee EMP1; ONB template | `POST …/lifecycle/start {emp_code:EMP1,template_id}` | 201, `tasks_created` = template task count, status `in_progress` |
| UAT-HR-506 | Negative | ONB template | `POST …/start {emp_code:EMP-NONE,…}` | 404 `EMP_NOT_FOUND` |
| UAT-HR-507 | Positive | Onboarding started | `PATCH …/tasks/:id {status:done}` for each task, then `POST …/:id/complete` | All done; lifecycle `complete` |
| UAT-HR-508 | Positive | Offboarding template (2 access-revocation tasks) | `POST …/start {emp_code:EMP1,template_id}` | 201; `access_revocation_pending` = 2 |
| UAT-HR-509 | **Negative (control HR-05)** | Offboarding with an access-revocation task pending | `POST …/lifecycle/:id/complete` | **400 `ACCESS_REVOCATION_INCOMPLETE`** |
| UAT-HR-510 | Negative (control) | `hr`-only user | `PATCH …/tasks/:id {status:skipped,reason}` on an access-revocation task | 403 `SKIP_REQUIRES_HR_ADMIN` |
| UAT-HR-511 | Negative (control) | `hr_admin` | `PATCH …/tasks/:id {status:skipped}` (no reason) on an access-revocation task | 400 `SKIP_REASON_REQUIRED` |
| UAT-HR-512 | Positive (control) | `hr_admin` | `PATCH …/tasks/:id {status:skipped,reason:"…"}` | 200, `skipped`; audit row `doc_status_log` `EMPLIFECYCLE` `ACCESS_REVOCATION_SKIP` |
| UAT-HR-513 | Positive | All access-revocation tasks done/skipped | `POST …/lifecycle/:id/complete` | 200, status `complete` |
| UAT-HR-514 | Detective | Open offboarding with unrevoked access | `GET …/offboarding-exceptions?days=0` then `?days=30` | days=0 lists the lifecycle (emp_code, `access_revocation_pending`); days=30 count 0 |
| UAT-HR-515 | Security (RLS) | Tenant T2 HR user | `POST …/templates` as T2; `GET …/templates` as T1 & T2 | T1 does not see T2's template; T2 sees only its own (tenant isolation) |

## Test cases — Recruiting / ATS (HR-4)

| Test ID | Type | Preconditions | Test steps | Expected result |
|---|---|---|---|---|
| UAT-HR-400 | Positive | HR admin | `POST /api/hcm/recruiting/requisitions` `{req_no:REQ1, headcount:1}` | 201, status `pending`, `requested_by` set |
| UAT-HR-401 | Negative (control) | REQ1 raised by hradmin | hradmin approves own requisition `.../requisitions/REQ1/approve` | 403 `SOD_SELF_APPROVAL` |
| UAT-HR-402 | Negative (perm) | REQ1 pending | `hr`-only maker approves REQ1 | 403 (permission gate) |
| UAT-HR-403 | Positive | REQ1 pending | A different approver (`exec`) approves REQ1 | 201/200, status `approved`, `approved_by` set |
| UAT-HR-404 | Positive | Approver ≠ requester | `POST …/candidates` `{cand_no:CAND1,name}` + `POST …/applications {req_no:REQ1,cand_no:CAND1}` | Candidate + application created (stage `applied`) |
| UAT-HR-405 | Positive | Application exists | `PATCH …/applications/:id/stage` `{stage:screen}` then `{stage:interview}` | 200, stage advances to `interview` |
| UAT-HR-406 | Negative (control) | REQ2 raised but NOT approved; application on REQ2 | `PATCH …/applications/:id/stage {stage:offer}` | 403 `REQUISITION_NOT_APPROVED` |
| UAT-HR-407 | Positive | REQ1 approved application | `POST …/offers {application_id, offered_salary}` | 201, offer status `pending`, `created_by` set |
| UAT-HR-408 | Negative (control) | Offer pending | `POST …/offers/:id/convert` | 403 `OFFER_NOT_APPROVED` |
| UAT-HR-409 | Negative (control) | Offer created by hradmin | hradmin approves own offer `.../offers/:id/approve` | 403 `SOD_SELF_APPROVAL` |
| UAT-HR-410 | Positive | Offer pending | A different approver authorizes the offer | 201/200, status `approved` |
| UAT-HR-411 | Positive | Offer approved | `POST …/offers/:id/convert` | 201, `emp_code` minted; a `payroll.employees` row created from the candidate; requisition → `filled` |
| UAT-HR-412 | Negative (control) | REQ1 headcount 1 already hired; 2nd approved offer on REQ1 | `POST …/offers/:id2/convert` | 403 `HEADCOUNT_EXCEEDED` |
| UAT-HR-413 | Security (RLS) | Tenant T2 HR user | T2 creates `T2REQ`; `GET …/requisitions` as T1 and T2 | T1 does not see `T2REQ`; T2 sees only its own (no `REQ1`) |

## Traceability

| Requirement | Control | Test cases | Harness |
|---|---|---|---|
| Review sign-off SoD (reviewer ≠ reviewee; manager rating required; goal weights ≤ 100%) | HR-03 | UAT-HR-300..312 | `tools/cutover/src/hcm-perf.ts` (17 checks) |
| Requisition approval + offer authorization maker-checker; headcount-bound hiring | HR-04 | UAT-HR-400..413 | `tools/cutover/src/hcm-recruiting.ts` (20 checks) |
| Offboarding access-revocation completeness (offboarding cannot complete while an access-revocation task is pending; privileged skip with reason; exception register) | HR-05 | UAT-HR-500..515 | `tools/cutover/src/hcm-onboarding.ts` (27 checks) |

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

## Test cases — Employee Self-Service depth (HR-8, control HR-08)

| Case | Type | Precondition | Action | Expected result |
|---|---|---|---|---|
| UAT-HR-800 | Positive (control) | `ess` login linked to EMP1 | `POST /api/hcm/ess/profile-requests` `{field:bank_account,new_value:1234567890}` | 201; status `pending`; `sensitive:true`; `employees.bank_account` **unchanged** |
| UAT-HR-801 | Positive | `ess` login linked to EMP1 | `POST …/profile-requests` `{field:phone,new_value:0812345678}` | 201; status `applied`; `auto_applied:true`; `employees.phone` updated immediately |
| UAT-HR-802 | Security (own-scope) | EMP1 has requests; `ess` linked to EMP2 | `GET …/profile-requests` as EMP2's login | EMP1's requests NOT returned (own-scope); sensitive values masked in the list |
| UAT-HR-803 | Negative (control) | `hr` user linked to an employee, own sensitive change pending | Same user `POST …/profile-requests/:id/approve` | 403 `SOD_SELF_APPROVAL`; master unchanged |
| UAT-HR-804 | Negative (perm) | Sensitive request pending | `ess` user `POST …/profile-requests/:id/approve` | 403 (approval reserved to `hr`/`hr_admin`) |
| UAT-HR-805 | Positive (control) | EMP1 bank_account change pending, requested by EMP1 | A distinct `hr_admin` `POST …/profile-requests/:id/approve` | 200 `approved`; `employees.bank_account` = **1234567890** (written only on approval); `doc_status_log` `ESSPROFILE` `Approved` row |
| UAT-HR-806 | Positive (control) | A pending sensitive change (national_id) | Distinct `hr_admin` `POST …/profile-requests/:id/reject` | 200 `rejected`; `employees.national_id` unchanged |
| UAT-HR-807 | Negative | `ess` user | `POST …/profile-requests` `{field:monthly_salary,new_value:99999}` | 400 (`BAD_FIELD` — not an ESS-editable field) |
| UAT-HR-808 | Positive + Negative | `ess` user | `POST …/documents {doc_type:certificate,title,file_ref:objstore:emp/e1/x.pdf}`; then `file_ref:objstore:../../etc/passwd` | 1st 201 (visibility `private`); 2nd 400 `BAD_OBJECT_KEY` |
| UAT-HR-809 | Security (own-scope) | EMP1 has a private doc + an HR-uploaded `hr`-visibility doc; `ess` linked to EMP2 | `GET …/documents` as EMP2, then as EMP1 | EMP2 does NOT see EMP1's doc; EMP1 does NOT see the `hr`-visibility doc |
| UAT-HR-810 | Positive | `ess` linked to EMP1 (dept Sales) vs `hr` user | `GET …/team` as each | ess: `scope:department` (own dept members); HR: `scope:company` |
| UAT-HR-811 | Security (RLS) | Tenant T2 admin creates a change on its own employee | `GET …/profile-requests` as T1 admin vs T2 admin | T1 does not see T2's request; T2 does not see T1's (tenant isolation) |

## Traceability — HR-8

| Requirement | Control | Test cases | Harness |
|---|---|---|---|
| ESS profile-change maker-checker (sensitive field pending → different hr/hr_admin approves; SOD_SELF_APPROVAL; employee master written only on approval; reject leaves it unchanged; own-scope + RLS; safe object keys) | HR-08 | UAT-HR-800..811 | `tools/cutover/src/hcm-ess.ts` (28 checks) |
