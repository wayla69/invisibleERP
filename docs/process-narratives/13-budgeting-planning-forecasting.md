# Budgeting, Planning & Forecasting — Process Narrative

> **DRAFT v0.1** — contains `<<placeholders>>` pending owner confirmation.

## 1. Document control

| Field | Value |
| --- | --- |
| Process ID | PN-13-EPM |
| Process owner | `<<FP&A / Controller>>` |
| Approver | `<<approver>>` |
| Version | **0.1 DRAFT** |
| Effective date | `<<effective-date>>` |
| Review cadence | Annual + on significant change |
| Related RCM controls | EPM-01, EPM-02, EPM-03, EPM-04, GL-05 |
| Related policy | `compliance/policies/budgeting-and-planning-policy.md` |

## 2. Purpose

To define the controlled process for preparing, approving, and baselining budgets and forecasts, and for monitoring actual performance against plan. The process produces no general-ledger postings — budget and plan data are reference data only — but the budget-vs-actual variance reporting is a key detective monitoring control over the posted ledger, and the maker-checker approval of budget versions enforces governance over financial targets.

## 3. Scope

**In scope:** Budget upsert and budget-vs-actual reporting; enterprise performance management (EPM) plan versions, scenarios, manual forecast lines, driver-based forecasting, and three-way (Budget / Forecast / Actual) variance analysis; the version-status finite-state-machine approval workflow.

**Out of scope:** Actual journal postings and period close (see `04-general-ledger-close.md`); revenue recognition schedules (see `12-revenue-recognition-billing.md`); project budgets (see `16-project-accounting.md`).

## 4. References

- ISO 9001:2015 clause 4.4 (QMS and its processes); clause 8.1 (Operational planning and control); clause 9.1 (Monitoring, measurement, analysis and evaluation).
- `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx` — EPM-*, GL-05 (maker-checker) families.
- `compliance/policies/budgeting-and-planning-policy.md`; `compliance/policies/delegation-of-authority-policy.md`.
- Code: `apps/api/src/modules/ledger/ledger.controller.ts` (budgets), `apps/api/src/modules/planning/planning.controller.ts`, `apps/api/src/modules/planning/planning.service.ts`, `apps/api/src/modules/workflow/` (WorkflowService).

## 5. Definitions & abbreviations

| Term | Definition |
| --- | --- |
| EPM | Enterprise Performance Management — versioned plans, scenarios, drivers. |
| Budget version | Plan container, document prefix `BV-{fiscal_year}-{nnnn}`. |
| Scenario | A set of forecast lines under a version (manual or driver-derived). |
| Driver | A rule (percent / rate / absolute) that computes forecast values from GL actuals. |
| Actual | Net signed GL movement from posted journal entries. |
| Variance | actual − budget; variance% = variance / \|budget\| × 100. |
| IPE | Information Produced by the Entity — here, actuals derived from the posted ledger. |
| Maker-checker | The preparer of a version may not approve it (R07 / GL-05). |
| FSM | Finite-state machine governing version status transitions. |

## 6. Roles & responsibilities (RACI)

Segregation of duties is enforced per **R07** — the user who creates/submits a budget version (permission `exec`/`planner`) must not approve it; approval requires the `approvals` permission (maker-checker, **GL-05**), gated by the workflow `assertCanTransition`.

| Activity | Planner (`exec`/`planner`) | Approver (`approvals`) | Controller / FP&A | System |
| --- | --- | --- | --- | --- |
| Create / upsert budget | R | I | A | I |
| Create plan version & scenarios | R | I | C | I |
| Submit version for approval | R | I | I | R |
| Approve version | I | R | A | I |
| Baseline approved version | I | R | A | I |
| Monitor budget-vs-actual variance | C | I | R | R |

## 7. Process narrative

1. **Upsert budget.** Planner calls `POST /api/ledger/budgets`. Records are upserted by `fiscal_year + account_code + period + cost_center`. In `annual` mode the amount is split into 12 monthly lines with the rounding remainder applied to December; in `monthly` mode a single line is written. Cost center is optional (`null` = corporate). No GL impact. Control: **EPM-01**.
2. **Query / maintain budget.** `GET /api/ledger/budgets` filters by `fiscal_year`, `account_code`, `cost_center`; `DELETE /api/ledger/budgets` removes lines. Control: Operational.
3. **Budget-vs-actual reporting.** `GET /api/ledger/budget-vs-actual` reads budget from the budgets table and actual as the net signed GL movement from posted JEs. Variance = actual − budget; variance% = variance / \|budget\| × 100. Favorability: revenue/liability/equity favorable if actual ≥ budget; expense/asset favorable if actual ≤ budget. Status is `On Budget` / `Favorable` / `Unfavorable`. Actuals are IPE derived from the posted ledger. Control: **EPM-03** (detective), **EPM-04** (IPE accuracy).
4. **Create plan version.** Planner calls `POST /api/planning/versions` (prefix `BV-{fiscal_year}-{nnnn}`, status `Working`). `GET /api/planning/versions` and `GET /api/planning/versions/:id` list/read versions; missing id raises **VERSION_NOT_FOUND (404)**. Control: **EPM-02**.
5. **Build scenarios & forecast lines.** `POST /api/planning/versions/:id/scenarios` creates scenarios; `POST /api/planning/scenarios/:id/clone` copies one; `GET /api/planning/scenarios/:id/lines` reads lines. `PUT /api/planning/scenarios/:id/lines` upserts manual forecast lines (unique `scenario_id + account_code + period`, source `Manual`). Missing scenario raises **SCENARIO_NOT_FOUND (404)**. Control: Operational.
6. **Driver-based forecasting.** `POST /api/planning/scenarios/:id/drivers` defines drivers of type `percent`/`rate`/`absolute`; an unknown type raises **INVALID_DRIVER_TYPE (400)**. `POST /api/planning/scenarios/:id/run-drivers` computes forecast from GL actuals: `percent` = actual × (1 + rate/100); `rate` = fixed; `absolute` = value; source `Driver`. No periods raises **NO_PERIODS (400)**. Control: Operational.
7. **Submit for approval.** `POST /api/planning/versions/:id/submit` sets status `Submitted` and triggers `WorkflowService.start` (auto-approved if no workflow definition exists). Control: **EPM-02**, **GL-05**.
8. **Approve (maker-checker).** `POST /api/planning/versions/:id/approve` requires the `approvals` permission and is gated by the workflow `assertCanTransition`; an invalid transition raises **INVALID_STATUS (400)**. The approver must differ from the submitter (R07). Control: **GL-05**, **EPM-02**.
9. **Baseline.** `POST /api/planning/versions/:id/baseline` locks the version; the version must be `Approved` first, else **INVALID_STATUS (400)**. Control: **EPM-02**.
10. **Three-way variance.** `GET /api/planning/versions/:id/variance?scenario_id=&period=` reports Budget vs Forecast vs Actual, where actual is the net GL movement. Control: **EPM-03** (detective).

## 8. Process flow

```mermaid
flowchart TD
    A[Planner upsert budget] --> B[Budgets table no GL impact]
    A2[Create version BV fiscal year nnnn status Working] --> C[Build scenarios and forecast lines]
    C --> D{Driver based}
    D -- Yes --> E[run-drivers from GL actuals]
    D -- No --> F[Manual forecast lines]
    E --> G[Submit version status Submitted]
    F --> G
    G --> H{Workflow assertCanTransition}
    H -- maker-checker by approvals --> I[Approve status Approved]
    I --> J[Baseline locked]
    B --> K[GET budget-vs-actual detective]
    J --> L[Three-way variance Budget Forecast Actual]
    K --> L
```

The Planner lane creates budgets, versions, scenarios, and forecast lines and submits for approval; the system/workflow lane enforces the status FSM and derives actuals from the posted ledger; the Approver lane (segregated from the preparer per R07) approves and baselines; and the Controller/FP&A lane runs budget-vs-actual and three-way variance as detective monitoring over the GL.

## 9. Control matrix

| Step | Risk | Control | Type | RCM ID | Evidence / Record |
| --- | --- | --- | --- | --- | --- |
| 1 | Budget data inconsistent / duplicated | Upsert keyed on fiscal_year+account+period+cost_center; deterministic 12-way split | Preventive | EPM-01 | Budget table rows |
| 4,7 | Unauthorized or out-of-sequence version change | Version status FSM gate (`assertCanTransition`) | Preventive | EPM-02 | Version status history |
| 8 | Preparer self-approves budget | Maker-checker; `approvals` permission distinct from submitter (R07) | Preventive | GL-05 | Approval record; workflow log |
| 3,10 | Performance against plan not monitored | Budget-vs-actual and three-way variance reporting | Detective | EPM-03 | Variance report output |
| 3 | Actuals (IPE) inaccurate / not from ledger | Actuals computed as net signed movement from posted JEs only | Detective | EPM-04 | Report-to-GL reconciliation |

## 10. Inputs & outputs

**Inputs:** Fiscal year and periods; account codes and cost centers; budget amounts; driver definitions and rates; posted GL actuals.

**Outputs:** Budget table rows (no GL impact); plan versions/scenarios/forecast lines; baselined version; budget-vs-actual and three-way variance reports. No journal entries are produced by this process.

## 11. Records & retention

| Record | System of record | Retention |
| --- | --- | --- |
| Budget rows | `budgets` table (Postgres) | `<<7 years / per Thai law>>` |
| Plan versions / scenarios / lines | Planning module | `<<7 years / per Thai law>>` |
| Approval & workflow transitions | Workflow / audit log | `<<7 years / per Thai law>>` |
| Variance reports | Reporting / evidence store | `<<7 years / per Thai law>>` |

## 12. KPIs / metrics

- Budget approval cycle time (submit → approve).
- Percentage of cost centers / accounts with an approved baselined budget.
- Forecast accuracy: forecast vs actual variance%.
- Count of INVALID_STATUS rejections (out-of-sequence transitions).
- Number of unfavorable variances exceeding threshold per period.

## 13. Exception & error handling

| Error code | Trigger | Handling |
| --- | --- | --- |
| VERSION_NOT_FOUND (404) | Reference to a non-existent version id | Verify version id; re-query. |
| SCENARIO_NOT_FOUND (404) | Reference to a non-existent scenario id | Verify scenario id; re-query. |
| INVALID_STATUS (400) | Approve/baseline attempted out of FSM sequence | Resolve prior state (submit/approve) before retrying. |
| INVALID_DRIVER_TYPE (400) | Driver type not percent/rate/absolute | Correct driver type and re-create. |
| NO_PERIODS (400) | `run-drivers` invoked with no periods | Define forecast periods before running drivers. |

## 14. Revision history

| Version | Date | Author | Notes |
| --- | --- | --- | --- |
| 0.1 DRAFT | 2026-06-22 | `<<author>>` | Initial draft. |
