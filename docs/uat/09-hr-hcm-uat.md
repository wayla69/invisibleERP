# UAT — HR / HCM (Performance management, HR-3)

> Note for merge: this file may be co-authored by several HR/HCM-depth agents. The HR-3 test block below is
> self-contained — keep BOTH this block and any sibling HR blocks on merge.

Related: narrative `docs/process-narratives/29-human-resources.md`; control **HR-03**; harness
`tools/cutover/src/hcm-perf.ts`.

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
