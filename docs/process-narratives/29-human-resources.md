# Human Resources (HCM) — Process Narrative

> HCM depth cycle (docs/42). This narrative is built up wave-by-wave; each HR feature owns a self-contained
> section so parallel PRs merge keep-both. HR-2 (leave accrual) is documented in §7.

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
