# Human Resources (HCM) — Process Narrative

> HCM depth cycle (docs/42). This narrative is built up wave-by-wave; each HR feature owns a self-contained
> section so parallel PRs merge keep-both. HR-2 (leave accrual) is documented in §7; the HR-3 performance-
> management section is appended self-contained below.

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-29-HR |
| Process owner | `<<HR Manager>>` |
| Approver | `<<CHRO / CFO>>` |
| Version | **0.1 DRAFT** |
| Effective date | `<<effective-date>>` |
| Review cadence | Annual + on policy change |
| Related RCM controls | HR-02 (leave accrual + entitlement gate); see also PAY-01..06 |
| Related policy | `compliance/policies/03-delegation-of-authority.md` |

## 2. Purpose

To control the human-capital lifecycle on the `payroll.employees` master so that leave entitlement,
org structure, performance and the rest of the HCM suite are administered **accurately, consistently and
with maker-checker segregation**, feeding payroll and the statutory record.

## 3. Scope

**In scope:** leave types/policies and the accrual engine (HR-2). Further HCM waves (org structure,
performance, recruiting, onboarding, compensation) attach their own sections as they land.

**Out of scope:** gross-to-net payroll computation and statutory filings (see `05-payroll.md`).

## 4. References

- `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx` — HR-02.
- Code: `apps/api/src/modules/hcm/` (`hcm-leave.service.ts`, `hcm.service.ts`), `apps/api/src/database/schema/hcm-leave.ts`.
- Migration `apps/api/drizzle/0321_hcm_leave_accrual.sql`.
- ToE harness: `tools/cutover/src/hcm-leave.ts` (17 checks).

## 5. Definitions & abbreviations

| Term | Meaning |
|---|---|
| Leave type | A category of leave (ANNUAL/SICK/PERSONAL/…) carrying an accrual method + caps |
| Accrual method | `monthly` (per period), `anniversary` (in the hire month), or `none` |
| Policy override | A higher accrual rate for a given job grade and/or minimum tenure |
| Carryover | Prior-year remaining balance rolled forward, capped at `carryover_cap_days` |
| Available balance | `entitled + accrued + carryover − used − expired` |

## 6. Roles & permissions

| Duty | Permission | Notes |
|---|---|---|
| View HR workspace / balances | `hr`, `hr_admin`, `exec`, `ess` (own) | reads only |
| Configure leave types / policies | `hr_admin`, `exec` | master-data maintenance |
| Run leave accrual | `hr_admin`, `exec` | privileged batch |
| Approve a leave request | `exec` / `users` / `creditors` (≠ requester) | maker-checker, SOD_SELF_APPROVAL |

## 7. HR-2 — Leave accrual engine + policies (control HR-02)

### 7.1 Narrative

Leave balances were previously static (`entitled`/`used` only, entitled defaulting to 0). HR-2 turns them
into a real accrual model:

1. **Leave-type master** (`leave_types`) — per tenant: `code`, `name`, `accrual_method`
   (`monthly`|`anniversary`|`none`), `accrual_rate_days` (days per period), `carryover_cap_days`,
   `max_balance_days` (0 = uncapped), `allow_negative`.
2. **Policy overrides** (`leave_policies`) — raise the base rate for a `job_grade` and/or a
   `min_tenure_months` threshold. The effective rate is the **highest matching** policy, else the type default.
3. **Accrual run** (`POST /api/hcm/leave/accrual/run {period}`, or the schedulable `hr_leave_accrual` BI
   action job) — for each **active** employee it credits `accrued` on the `(employee, type, year)` balance,
   clamped so the balance never exceeds `max_balance_days`. At the **year boundary** the prior year's
   remaining balance rolls into `carryover` (capped at `carryover_cap_days`); the excess is recorded as
   `expired` on the prior-year row. The run is **idempotent per `(tenant, period)`** — a re-run is a no-op
   guarded by `leave_accrual_runs`.
4. **Entitlement gate (HR-02)** — `requestLeave` blocks a **paid** request whose days exceed the available
   balance with `INSUFFICIENT_LEAVE_BALANCE`, unless the leave type is unconfigured (legacy back-compat) or
   allows a negative balance. Unpaid leave is not gated. Approval remains maker-checker (approver ≠ requester,
   `SOD_SELF_APPROVAL`).

### 7.2 Endpoints

| Method | Route | Permission |
|---|---|---|
| GET | `/api/hcm/leave/types` | hr / hr_admin / exec / ess |
| POST | `/api/hcm/leave/types` | hr_admin / exec |
| GET | `/api/hcm/leave/policies` | hr / hr_admin / exec |
| POST | `/api/hcm/leave/policies` | hr_admin / exec |
| GET | `/api/hcm/leave/balances?emp_code=` | hr / hr_admin / exec / ess |
| POST | `/api/hcm/leave/accrual/run` | hr_admin / exec |

### 7.3 Workflow

```mermaid
flowchart TD
  A[HR admin defines leave_types + policies] --> B[Scheduler / HR admin runs accrual for period]
  B --> C{Run already recorded for tenant+period?}
  C -- yes --> C1[No-op idempotent]
  C -- no --> D[For each active employee: resolve effective rate policy→default]
  D --> E[Credit accrued, clamp to max_balance; roll year-boundary carryover capped, expire excess]
  E --> F[Record leave_accrual_runs tenant+period]
  G[Employee requests paid leave] --> H{days > available balance?}
  H -- yes and not allow_negative --> H1[Reject INSUFFICIENT_LEAVE_BALANCE]
  H -- no --> I[Pending → approver ≠ requester approves → used += days]
```

### 7.4 Control matrix

| Control | Type | Assertion | Test |
|---|---|---|---|
| HR-02 | Preventive/Automated | Accrual is policy/grade/tenure-driven and idempotent per period; a paid request beyond available balance is blocked | `tools/cutover/src/hcm-leave.ts` (17 checks); UAT-HR-01..08 |

## 8. Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 DRAFT | 2026-07-11 | HR-2 | Initial HR narrative; HR-2 leave accrual engine + entitlement gate (control HR-02, migration 0321). |

---

# HR-3 — Performance management (control HR-03) — appended section

> Self-contained HR-3 performance-management narrative; kept on merge alongside the HR-2 leave section above.

## PM.1 Document control (HR-3)

| Field | Value |
|---|---|
| Process ID | PN-29-HR (HR-3 performance) |
| Process owner | `<<HR / People Ops Manager>>` |
| Approver | `<<CHRO / CFO>>` |
| Version | **0.1 DRAFT** |
| Effective date | `<<effective-date>>` |
| Review cadence | Each appraisal cycle + annual |
| Related RCM controls | HR-03; SoD (maker-checker on review sign-off) |
| Related plan | `docs/42-hcm-depth-plan.md` |

## 2. Purpose

To control the performance-appraisal cycle so that employee goals are set coherently, ratings are made
independently of the person being rated, and the final appraisal is signed off by someone **other than the
reviewee** — protecting the integrity of the ratings that drive pay rises, bonuses and promotions.

## 3. Scope

**In scope:** appraisal cycles (`perf_cycles`), OKR-style goals with weightings (`perf_goals`), and the
self → manager → calibration → sign-off review workflow (`perf_reviews`). Employee master is
`payroll.employees` (by `emp_code`).

**Out of scope:** payroll computation/posting (see `05-payroll.md`), time & attendance and leave (see
`25-hcm-time-labor.md`).

## 4. Roles & permissions

| Duty | Permission | Notes |
|---|---|---|
| View cycles / goals / reviews | `hr`, `hr_admin`, `exec` (or `ess` self-scoped to own rows) | Reads |
| Create cycle, goals, self/manager review | `hr`, `hr_admin` | Writes |
| Close cycle, sign off appraisal | `hr_admin`, `exec` | Elevated HR duty |

## 5. Workflow

```mermaid
flowchart TD
  A[HR creates cycle H1-2026 · open] --> B[Add goals per employee<br/>weights validated ≤ 100%]
  B --> C[Employee self-assessment<br/>review status = self]
  C --> D[Manager rating<br/>manager_emp_code ≠ reviewee<br/>status = manager]
  D --> E{Sign-off}
  E -->|signer ≠ reviewee AND manager_rating present| F[Calibrated + signed<br/>status = signed]
  E -->|signer == reviewee| X1[403 SOD_SELF_REVIEW]
  E -->|no manager rating| X2[400 NO_MANAGER_RATING]
  F --> G[HR closes cycle · status = closed]
```

## 6. Control matrix

| Control | Assertion | What it prevents | Enforcement |
|---|---|---|---|
| **HR-03** | Authorization / Segregation of Duties | A self-rated / self-signed appraisal inflating ratings that drive pay; incoherent goal weightings | `managerRate` rejects `manager_emp_code == emp_code` (`SOD_SELF_REVIEW`); `signReview` rejects a signer whose linked employee `== emp_code` (`SOD_SELF_REVIEW`) or a review with no manager rating (`NO_MANAGER_RATING`); `createGoal` rejects weights summing `> 100%` (`WEIGHT_EXCEEDED`) |

## 7. Endpoints (application)

| Endpoint | Permission | Purpose |
|---|---|---|
| `GET /api/hcm/performance/cycles` | read | List appraisal cycles |
| `POST /api/hcm/performance/cycles` | `hr`/`hr_admin` | Create a cycle (`open`) |
| `POST /api/hcm/performance/cycles/:id/close` | `hr_admin`/`exec` | Close a cycle |
| `GET/POST /api/hcm/performance/goals` | read / `hr`,`hr_admin` | List / add goals (weights ≤ 100%) |
| `PATCH /api/hcm/performance/goals/:id` | `hr`/`hr_admin` | Update progress / status |
| `POST /api/hcm/performance/reviews` | `hr`/`hr_admin` | Self-assessment (status `self`) |
| `POST /api/hcm/performance/reviews/:id/manager` | `hr`/`hr_admin` | Manager rating (HR-03 SoD) |
| `POST /api/hcm/performance/reviews/:id/sign` | `hr_admin`/`exec` | Calibrate + sign off (HR-03 SoD) |

## 8. Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `SOD_SELF_REVIEW` | 403 | Manager rating / sign-off attempted by the reviewee |
| `NO_MANAGER_RATING` | 400 | Sign-off attempted before a manager rating exists |
| `WEIGHT_EXCEEDED` | 400 | Goal weights for an employee/cycle would exceed 100% |
| `CYCLE_CLOSED` | 400 | Goal/review create attempted on a closed cycle |

## 9. System references

- Service/controller: `apps/api/src/modules/hcm/hcm-perf.service.ts`, `hcm-perf.controller.ts`
- Schema: `apps/api/src/database/schema/hcm-perf.ts`; migration `apps/api/drizzle/0322_hcm_performance.sql`
- Web: `apps/web/src/app/(internal)/hcm/performance/page.tsx` (`/hcm/performance`)
- ToE harness: `tools/cutover/src/hcm-perf.ts` (17 checks)

## 10. Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 DRAFT | 2026-07-11 | HR-3 | Initial performance-management narrative + HR-03 control matrix |

---

## HR-6 — Compensation bands + benefits (control HR-06)

> Self-contained HCM Wave 2 section (docs/42). Compensation control on the `payroll.employees` identity
> (emp_code). Merges keep-both with the other HR waves.

### HR6.1 Document control (HR-6)

| Field | Value |
|---|---|
| Process ID | PN-29-HR / HR-6 |
| Process owner | `<<HR Manager / Head of Reward>>` |
| Approver | `<<CHRO / CFO>>` |
| Version | **0.1 DRAFT** |
| Related RCM control | HR-06 (comp-change maker-checker within band) |
| Related policy | `compliance/policies/03-delegation-of-authority.md` |

### HR6.2 Narrative

Compensation is administered on a per-tenant **pay-grade band register** (`pay_grades`) — each grade carries a
`[min, mid, max]` salary band and a currency (default THB). A salary or grade change to an employee is a
**comp change** (`comp_changes`) with a `change_type` of `hire` / `merit` / `promotion` / `adjustment`,
subject to the **HR-06 control**:

1. **Within-band validation at request time.** When the change names a target grade (`new_grade`), the proposed
   `new_salary` must fall inside that grade's `[min, max]` band. A salary outside the band is **blocked**
   (`OUT_OF_BAND`, 400) unless an `hr_admin`/`exec` sets an explicit **override flag** — the override is
   **audit-logged** (a `doc_status_log` `COMPCHG` row carrying `OUT_OF_BAND_OVERRIDE`) in addition to the
   append-only `audit_log`.
2. **Maker-checker on approval.** A comp change is created `pending` and writes **nothing** to the employee
   record. Approval requires a **different** user (`approved_by` ≠ `requested_by` → `SOD_SELF_APPROVAL`, 403)
   holding `hr_admin`/`exec`. The employee master (`payroll.employees.monthly_salary` + `job_grade`) is written
   **only on approval**; a **reject** leaves the salary unchanged.

**Benefits.** `benefit_plans` catalogues offerings (category `health`/`dental`/`life`/`provident_fund`/
`allowance`, with employer/employee monthly cost). `benefit_enrollments` link an employee to a plan
(effective-dated, end-datable; a duplicate active enrolment on the same plan is rejected `ALREADY_ENROLLED`).
Enrolment reads are `ess` **own-scoped** (an employee sees only their own). All four tables are tenant-scoped
(RLS) so bands, comp history and benefits never leak across companies.

### HR6.3 Workflow

```mermaid
flowchart TD
  A[HR maintainer requests comp change] --> B{new_salary within target grade band?}
  B -- yes --> P[status: pending]
  B -- no --> O{hr_admin/exec + override flag?}
  O -- no --> X[Block OUT_OF_BAND]
  O -- yes --> P2[status: pending + OUT_OF_BAND_OVERRIDE audit]
  P --> C{approver ≠ requester and hr_admin/exec?}
  P2 --> C
  C -- no --> Y[Block SOD_SELF_APPROVAL]
  C -- approve --> D[status: approved → write employees.monthly_salary + job_grade]
  C -- reject --> E[status: rejected → salary unchanged]
```

### HR6.4 Endpoints (application)

| Endpoint | Permission | Purpose |
|---|---|---|
| `GET/POST /api/hcm/comp/grades` | read `hr`/`hr_admin`/`exec`; write `hr`/`hr_admin` | List / create pay-grade bands |
| `GET/POST /api/hcm/comp/changes` | read `hr`/`hr_admin`/`exec`; write `hr`/`hr_admin` | List / request comp changes (HR-06 band check) |
| `POST /api/hcm/comp/changes/:id/approve` | `hr_admin`/`exec` | Approve (≠ requester) → write employee master |
| `POST /api/hcm/comp/changes/:id/reject` | `hr_admin`/`exec` | Reject (salary unchanged) |
| `GET/POST /api/hcm/comp/benefit-plans` | read `hr`/`hr_admin`/`exec`; write `hr`/`hr_admin` | List / create benefit plans |
| `GET/POST /api/hcm/comp/enrollments` | read `hr`/`hr_admin`/`exec`/`ess` (own); write `hr`/`hr_admin` | List / create enrolments |
| `POST /api/hcm/comp/enrollments/:id/end` | `hr`/`hr_admin` | End an enrolment |

### HR6.5 Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `OUT_OF_BAND` | 400 | `new_salary` outside the target grade band (no valid override) |
| `SOD_SELF_APPROVAL` | 403 | The requester attempted to approve their own comp change |
| `GRADE_EXISTS` / `PLAN_EXISTS` | 400 | Duplicate `grade_code` / `plan_code` for the tenant |
| `ALREADY_ENROLLED` | 400 | Duplicate active enrolment on the same plan |
| `GRADE_NOT_FOUND` / `PLAN_NOT_FOUND` / `EMP_NOT_FOUND` | 404 | Referenced grade / plan / employee not found |

### HR6.6 Control matrix

| Control | Assertion | What it prevents | Enforcement |
|---|---|---|---|
| **HR-06** | Authorization / Segregation of Duties | A salary set outside the sanctioned pay band or a self-approved raise, growing the payroll base without independent authorisation | `createChange` blocks `new_salary` outside `[min,max]` (`OUT_OF_BAND`) unless `hr_admin`/`exec` + override (audit-logged `OUT_OF_BAND_OVERRIDE`); `approveChange` rejects `approved_by == requested_by` (`SOD_SELF_APPROVAL`) and writes the employee master only on approval |

### HR6.7 System references

- Service/controller: `apps/api/src/modules/hcm/hcm-comp.service.ts`, `hcm-comp.controller.ts`
- Schema: `apps/api/src/database/schema/hcm-comp.ts`; migration `apps/api/drizzle/0325_hcm_comp.sql`
- Web: `apps/web/src/app/(internal)/hcm/comp/page.tsx` (`/hcm/comp`)
- ToE harness: `tools/cutover/src/hcm-comp.ts` (23 checks)

### HR6.8 Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 DRAFT | 2026-07-11 | HR-6 | Initial compensation-bands & benefits narrative + HR-06 control matrix |
