# UAT — Quality: Non-Conformance (NCR) register with maker-checker disposition (QMS-1, QC-01)

**Status: DRAFT v0.1 · 2026-07-11** · Cross-ref: process narrative `15-manufacturing-costing.md` §7 (13) / control
QC-01, harness `tools/cutover/src/quality-ncr.ts` (11 checks), user manual `docs/user-manual/20-quality-ncr.md`.

Covers the QMS-1 Non-Conformance register: raising an NCR (or promoting a failed `quality_inspection`), the
per-tenant defect-code lookup, and the **QC-01** disposition maker-checker — a financial disposition
(scrap / use-as-is / return) is parked `pending_disposition` and applied, with any scrap write-off posted
(Dr 5810 / Cr the source inventory account), **only when a DIFFERENT user approves** (`dispositioned_by ≠
raised_by` → `SOD_SELF_APPROVAL`). Duties: raising is `quality`, disposition-approval is `quality_approve`/`exec`
(segregated by SoD **R21**). All endpoints are under `/api/quality/*` and are RLS tenant-scoped. Result legend:
`Pass` / `Fail` / `Blocked` / `N/A` / `Not Run` (default).

| Test ID | Scenario | Role | Preconditions | Test steps | Test data | Expected result | Priority | Type | Traceability | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| UAT-QC-001 | Add a defect code | Quality (`quality`) | `quality` duty | 1. `POST /api/quality/defect-codes` | `{code:'DIM-01', name:'ขนาดเกินพิกัด', category:'dimensional'}` | 201; code `DIM-01` appears in `GET /api/quality/defect-codes` | Med | Positive | QC-01; 15 §7 (13) | Not Run | |
| UAT-QC-002 | Raise an NCR without a financial disposition → open | Quality (`quality`) | — | 1. `POST /api/quality/ncr` | `{source:'in_process', item_id:'CAKE', severity:'minor', qty:1}` | 201; `ncr_no` like `NCR-00001`; `status='open'` | High | Positive | QC-01; 15 §7 (13) | Not Run | |
| UAT-QC-003 | Promote a failed inspection into an NCR | Quality (`quality`) | A `quality_inspection` with `qty_failed>0` | 1. `POST /api/quality/inspections/:id/promote` with `{proposed_disposition:'scrap', qty:4, unit_cost:10}` | inspection ref_type `GR` | 201; `status='pending_disposition'`, `ref_type='GR'`, `qty=4` | High | Positive | QC-01 | Not Run | |
| UAT-QC-004 | Propose scrap → parks pending_disposition | Quality (`quality`) | — | 1. `POST /api/quality/ncr` with `proposed_disposition:'scrap'` | `{source:'incoming', ref_type:'GR', item_id:'STEEL', qty:5, unit_cost:10, proposed_disposition:'scrap'}` | 201; `status='pending_disposition'`; no GL posted yet | High | Positive | QC-01 | Not Run | |
| UAT-QC-005 | Self-disposition blocked (maker-checker) | Same user who raised | An NCR raised by this user in `pending_disposition` | 1. `POST /api/quality/ncr/:id/disposition` as the raiser | `{disposition:'scrap'}` | 403 `SOD_SELF_APPROVAL`; NCR stays `pending_disposition`; no GL | High | Control | QC-01; SoD R21 | Not Run | The core control |
| UAT-QC-006 | Distinct approver dispositions scrap → GL write-off posted | Approver (`quality_approve`) ≠ raiser | UAT-QC-004 NCR (qty 5 × cost 10) | 1. `POST /api/quality/ncr/:id/disposition` | `{disposition:'scrap', notes:'อนุมัติทิ้ง'}` | 200; `status='dispositioned'`, `dispositioned_by=approver`, `write_off_value=50`, `entry_no` like `JE-*`; JE **Dr 5810 50 / Cr 1200 50**, trial balance balanced | High | Positive | QC-01; GL-01 | Not Run | |
| UAT-QC-007 | Reject a proposed disposition → back to open | Approver (`quality_approve`) ≠ raiser | An NCR in `pending_disposition` | 1. `POST /api/quality/ncr/:id/reject` | `{notes:'ต้องตรวจซ้ำ'}` | 200; `status='open'`, `proposed_disposition=null`; no GL posted | High | Control | QC-01 | Not Run | |
| UAT-QC-008 | RLS tenant isolation of the NCR register | Quality of Tenant B | An NCR raised in Tenant B | 1. Tenant A `GET /api/quality/ncr` | — | Tenant B's NCR is **not** in Tenant A's register | High | Control | QC-01; ITGC-AC-03 | Not Run | |
| UAT-QC-009 | Permission guard: raiser cannot disposition | Quality (`quality`, no `quality_approve`) | An NCR in `pending_disposition` | 1. `POST /api/quality/ncr/:id/disposition` | `{disposition:'return'}` | 403 (forbidden — lacks `quality_approve`) | Med | Control | QC-01; SoD R21 | Not Run | |
