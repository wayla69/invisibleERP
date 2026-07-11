# UAT — Cycle 13: HR Org Structure & Positions (HR-1)

**Status: DRAFT v0.1 · 2026-07-11** · *v0.1: HR-1 org structure, positions & headcount governance (control HR-01, migration `0320`) — UAT-HR-001..012 cover the department hierarchy, positions with a budgeted headcount, effective-dated assignments, the HR-01 headcount block + exec override (audit-logged), the org chart, permission gating and RLS tenant isolation.* · Cross-ref: process narrative `25-hcm-time-labor.md` §7bis (HR-01), harness `tools/cutover/src/hcm-org.ts` (21 checks), permissions `hr`/`hr_admin`.

Result legend: Pass / Fail / Blocked / N/A / Not Run. Reads gate `hr`/`hr_admin`/`exec`; writes gate `hr_admin`/`exec`; the HR-01 over-establishment override is reserved to `exec`. Error codes are exact (`json.error.code`).

| Test ID | Scenario/Title | Role | Preconditions | Test steps | Test data | Expected result | Priority | Type | Traceability | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| UAT-HR-001 | Create a top-level department | hr_admin | — | 1. `POST /api/hcm/org/departments`. | `{dept_code:CORP, name:Corporate, cost_center:CC-100}` | 201; `dept_code`=CORP; tenant-scoped. | High | Positive | HR-01 | Not Run | hcm-org.ts |
| UAT-HR-002 | Create a child department (hierarchy) | hr_admin | CORP exists | 1. `POST …/departments` with `parent_dept_code`. | `{dept_code:ENG, name:Engineering, parent_dept_code:CORP}` | 201; `parent_dept_code`=CORP in the list. | High | Positive | HR-01 | Not Run | hcm-org.ts |
| UAT-HR-003 | Duplicate dept_code rejected | hr_admin | CORP exists | 1. `POST …/departments {dept_code:CORP}`. | — | 400 `DEPT_EXISTS`. | Med | Control | HR-01 | Not Run | hcm-org.ts |
| UAT-HR-004 | Create a position with a budgeted headcount | hr_admin | ENG exists | 1. `POST /api/hcm/org/positions`. | `{position_code:ENG-LEAD, title:Engineering Lead, dept_code:ENG, budgeted_headcount:1}` | 201; `budgeted_headcount`=1. | High | Positive | HR-01 | Not Run | hcm-org.ts |
| UAT-HR-005 | Assign an employee within budget | hr_admin | ENG-LEAD budget 1, empty | 1. `POST /api/hcm/org/assignments {emp_code, position_code:ENG-LEAD}`. | emp #1 | 201; `headcount_overridden`=false. | High | Positive | HR-01 | Not Run | hcm-org.ts |
| UAT-HR-006 | **HR-01 — 2nd assignment beyond budget BLOCKED (non-exec)** | hr_admin | ENG-LEAD at 1/1 | 1. `POST …/assignments {emp_code:#2, position_code:ENG-LEAD}`. | emp #2 | **403 `HEADCOUNT_EXCEEDED`** (nothing inserted). | High | Control | HR-01 | Not Run | hcm-org.ts |
| UAT-HR-007 | **HR-01 — exec override succeeds & is audit-logged** | exec/Admin | ENG-LEAD at 1/1 | 1. `POST …/assignments {emp_code:#2, position_code:ENG-LEAD, override_reason}` as exec. 2. Inspect `doc_status_log`. | emp #2 | 201; `headcount_overridden`=true; a `doc_status_log` `HRASSIGN` row carries `HEADCOUNT_OVERRIDE (HR-01)` + the reason. | High | Control | HR-01 | Not Run | hcm-org.ts |
| UAT-HR-008 | Unbudgeted position (headcount=0) has no cap | hr_admin | position budget 0 | 1. Assign two employees to a `budgeted_headcount:0` position. | emps #1,#2 | Both 201; `headcount_overridden`=false (no cap). | Med | Positive | HR-01 | Not Run | hcm-org.ts |
| UAT-HR-009 | Positions list shows current vs budgeted headcount | hr_admin | ENG-LEAD at 2/1 | 1. `GET /api/hcm/org/positions`. | — | `current_headcount`=2, `budgeted_headcount`=1 (over budget). | Med | Positive | HR-01 | Not Run | hcm-org.ts |
| UAT-HR-010 | Org chart returns the tree with assignees + vacancies | hr/exec | data seeded | 1. `GET /api/hcm/org/chart`. | — | CORP → ENG child; ENG-LEAD nested with 2 assignees, `vacancies`=0; totals: 2 depts, filled HC. | High | Positive | HR-01 | Not Run | hcm-org.ts |
| UAT-HR-011 | Permission — read-only `hr` user cannot create | hr (read) | — | 1. `GET …/departments` (200). 2. `POST …/departments` (403). | bearer hr | List allowed; create **403 Forbidden**. | High | Control | HR-01, ITGC-AC-07 | Not Run | hcm-org.ts |
| UAT-HR-012 | RLS — org structure scoped to own tenant | Admin (T1/T2) | T2 creates a dept | 1. `GET …/departments` as T1 and T2. | bearers T1/T2 | T1 does NOT see T2's dept; T2 sees only its own (no CORP/ENG leakage). | High | Control | HR-01, ITGC-AC (RLS) | Not Run | hcm-org.ts |

## Traceability

| Control | Narrative | Endpoints | Harness | UAT |
|---|---|---|---|---|
| **HR-01** (headcount governance) | PN-25-HCM §7bis (steps 8–11) | `GET/POST /api/hcm/org/{departments,positions,assignments}`, `GET /api/hcm/org/chart` | `tools/cutover/src/hcm-org.ts` (21) | UAT-HR-001..012 |
