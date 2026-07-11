# UAT — After-Sales Warranty & Entitlement (SVC-2)

**Status: DRAFT v0.1 · 2026-07-11** · Cross-ref: process narrative `32-after-sales-warranty.md` (SVC-01),
harness `tools/cutover/src/warranty.ts` (20 checks), user manual `docs/user-manual/16-service.md`.

Covers the SVC-2 Warranty & Entitlement registry: the warranty-term catalogue, the installed-base
serialized-unit registry (computed `warranty_end`), warranty claims with the **SVC-01** coverage-authorization
maker-checker (in-coverage → auto-free; out-of-coverage → a **different** user must authorize →
`SOD_SELF_APPROVAL`), and the expiring / coverage-exceptions detective reads. All endpoints are under
`/api/service/warranty/*` and are RLS tenant-scoped. Result legend: `Pass` / `Fail` / `Blocked` / `N/A` /
`Not Run` (default).

| Test ID | Scenario | Role | Preconditions | Test steps | Test data | Expected result | Priority | Type | Traceability | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| UAT-SVC-001 | Create a warranty term | MasterData | `masterdata` duty | 1. `POST /api/service/warranty/terms` | `{term_code:'W12', name:'12-mo full', coverage_months:12, coverage_type:'full'}` | 201; `term_code='W12'`, `coverage_months=12`, `coverage_type='full'`, `active=true` | High | Positive | SVC-01; 32 §7 (1) | Not Run | |
| UAT-SVC-002 | Duplicate term code rejected | MasterData | Term `W12` exists | 1. `POST /api/service/warranty/terms` with `term_code:'W12'` | `term_code='W12'` | 409 `TERM_EXISTS` | Med | Control | SVC-01 | Not Run | Per-tenant unique |
| UAT-SVC-003 | Register a serialized unit — `warranty_end` computed | MasterData | Term `W12` (12 mo) | 1. `POST /api/service/warranty/units` | `{serial_no:'SN-0001', item_code:'PUMP-A', sold_date:<today>, warranty_term_id:<W12>}` | 201; `warranty_end = sold_date + 12 months`; `coverage_type='full'` snapshot | High | Positive | SVC-01; 32 §7 (2) | Not Run | |
| UAT-SVC-004 | Duplicate serial rejected | MasterData | `SN-0001` registered | 1. `POST /api/service/warranty/units` with `serial_no:'SN-0001'` | `serial_no='SN-0001'` | 409 `SERIAL_EXISTS` | Med | Control | SVC-01 | Not Run | Per-tenant unique |
| UAT-SVC-005 | In-coverage claim auto-authorizes FREE | Service Agent | Active unit within warranty | 1. `POST /api/service/warranty/claims` (kind `full`) | `{installed_base_id:<SN-0001>, fault:'Seal leak', coverage_kind:'full'}` | 201; `status='authorized'`, `is_in_coverage=true`, `charge=0`, `disposition='repair'` | High | Positive | SVC-01; 32 §7 (3) | Not Run | Contractually covered |
| UAT-SVC-006 | Out-of-coverage (expired) claim parks pending | Service Agent | Unit with expired warranty | 1. Register a unit sold 400 days ago (12 mo term); 2. `POST …/claims` | `{fault:'Motor burnt', coverage_kind:'full'}` | 201; `status='pending'`, `is_in_coverage=false`; no auto-authorization | High | Control | SVC-01; 32 §7 (3) | Not Run | |
| UAT-SVC-007 | Coverage-kind mismatch → out of coverage | Service Agent | Parts-only unit within window | 1. `POST …/claims` with `coverage_kind:'labor'` | `{coverage_kind:'labor'}` on a parts-only unit | 201; `is_in_coverage=false`, `status='pending'` | Med | Control | SVC-01; 32 §7 (3) | Not Run | `full` covers all; else kinds must match |
| UAT-SVC-008 | Self-authorize blocked (maker-checker) | Admin | Admin raised an out-of-coverage claim (holds exec+approvals) | 1. `POST …/claims/:id/authorize` as the SAME user who raised it | `{disposition:'repair', charge:0}` | 403 `SOD_SELF_APPROVAL` | High | Control | SVC-01 (SoD); 32 §7 (4) | Not Run | Binds even Admin |
| UAT-SVC-009 | Distinct authorizer approves with a charge | Approver | Pending out-of-coverage claim by another user | 1. `POST …/claims/:id/authorize` as a DIFFERENT user | `{disposition:'repair', charge:1500}` | 200; `status='authorized'`, `charge=1500`, `authorized_by=<approver>` | High | Positive | SVC-01; 32 §7 (4) | Not Run | Paid repair |
| UAT-SVC-010 | Distinct authorizer approves FREE (override) | Approver | Pending out-of-coverage claim | 1. `POST …/claims/:id/authorize` FREE | `{disposition:'replace', charge:0}` | 200; `status='authorized'`, `charge=0`, `is_in_coverage=false` (recorded as an override) | High | Control | SVC-01; 32 §7 (4,7) | Not Run | |
| UAT-SVC-011 | Re-decide a non-pending claim rejected | Approver | Claim already authorized | 1. `POST …/claims/:id/authorize` again | — | 400 `CLAIM_NOT_PENDING` | Med | Control | SVC-01 | Not Run | |
| UAT-SVC-012 | Reject requires a reason + distinct user | Approver | Pending claim by another user | 1. `POST …/claims/:id/reject` without a reason; 2. with a reason | `{reason:'Not a warranty fault'}` | 1) 400 (validation); 2) 200 `status='closed'`, `disposition='reject'` | Med | Control | SVC-01; 32 §7 (5) | Not Run | |
| UAT-SVC-013 | Coverage-exceptions override register | Service Manager | ≥1 free out-of-coverage authorization exists | 1. `GET /api/service/warranty/coverage-exceptions` | — | 200; lists the free out-of-coverage override only (in-coverage + paid claims excluded) | High | Detective | SVC-01; 32 §7 (7) | Not Run | Audit sample |
| UAT-SVC-014 | Expiring-warranty worklist | Service Manager | A unit expiring within 30 days | 1. `GET /api/service/warranty/expiring?days=30` | `days=30` | 200; lists the soon-expiring unit; a freshly-sold 12-mo unit is excluded | Med | Detective | SVC-01; 32 §7 (6) | Not Run | |
| UAT-SVC-015 | RBAC gate on writes | Warehouse | Warehouse lacks `masterdata` | 1. `POST /api/service/warranty/terms` as Warehouse | — | 403 `FORBIDDEN` | High | Control | SVC-01; ITGC-AC-02 | Not Run | |
| UAT-SVC-016 | RLS tenant isolation | Admin (T1) | HQ terms/units exist | 1. `GET …/terms` and `…/units` as a second-tenant admin | — | 200; `count=0` for both (no cross-tenant disclosure) | High | Control | SVC-01 | Not Run | |

## Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 0.1 DRAFT | 2026-07-11 | `<<author>>` | Initial UAT — SVC-2 Warranty & Entitlement registry, control SVC-01. 16 cases (positive + control/detective) mirroring the `warranty.ts` ToE and PN-32. |
