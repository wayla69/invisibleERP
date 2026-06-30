# 21 — Track D: adjacent-ERP depth (status reconciliation + residual gaps)

> **Status:** RECONCILED. The first draft of this roadmap (v0.1) was written on an **incomplete
> current-state survey** and wrongly framed MRP/QC/RFQ/three-way-hold as greenfield. A deeper code audit
> found **Track D is already substantially implemented, harness-tested, and RCM-controlled.** This version
> records that reality (with file paths) and narrows the plan to the handful of **genuine residual gaps**.
> **No duplicate modules will be built** — per CLAUDE.md, *duplication is a defect, not a deliverable.*

## Document control

| Field | Value |
|---|---|
| Owner | ERP / Product |
| Version | 0.2 RECONCILED |
| Date | 2026-06-30 |
| Supersedes | `docs/20` §Track D placeholder; **corrects** docs/21 v0.1 (over-scoped). |

## 1. What already exists (audit — build on, don't duplicate)

A second-pass audit of `apps/api/src/modules/` found the following **already shipped** (the v0.1 survey
missed the `mfg-depth`, `sourcing`, `match`, `budget`, `costing`, `wms`, and `demand-ml` modules):

| v0.1 "gap" | Reality — already delivered | Evidence |
|---|---|---|
| **MRP net-requirements (DC1)** | Multi-level BOM explosion, on-hand netting, EOQ/min/multiple lot-sizing, **rough-cut capacity (RCCP)** off routings/work-centres, and **plan-to-PR** (planned buys → real PR). | `modules/mfg-depth/mrp.service.ts`; `@Controller('api/mrp')` `run`/`plan-to-pr`/`capacity`; harness `tools/cutover/src/mrp.ts` |
| **QC hold / disposition (DC2)** | Inspection with Accept / Rework / **Quarantine** / **Scrap** disposition. | `modules/mfg-depth/quality.service.ts`; `@Controller('api/quality')` |
| **Scrap classification (DC3)** | Scrap disposition writes the failed value off to scrap loss. | same (`quality.service.ts`) |
| **Shop-floor / inter-stage WIP** | Routing generation onto a WO + per-operation reporting. | `mfg-depth` ShopFloor (`api/manufacturing/work-orders/:wo/operations`) + `routings`/`routing_operations` |
| **RFQ / competitive sourcing (DB1)** | Request-for-quote module. | `modules/sourcing/rfq.service.ts`; `@Controller('api/procurement/rfqs')` |
| **AP invoice 3-way hold (DB2)** | Three-way match with configurable tolerance that **gates the AP payment** (`over_invoiced` / `price_variance`). | `modules/match/three-way-match.service.ts`; `@Controller('api/procurement/match')`; harness `tools/cutover/src/match.ts` |
| **Budget-vs-actual (DD1 core)** | Full variance + favorability + ELC-06 materiality + BUD-01 maker-checker. | `modules/budget/budget.service.ts` `budgetVsActual`; harness `tools/cutover/src/budget.ts` |
| **Supplier scorecards (DB3 core)** | On-time/quality/price-variance scorecard compute + ranking. | `modules/procurement/procurement.service.ts` `recomputeScorecard`; harness `supplier.ts` |
| **Close automation (DA core)** | 7-step close checklist, maker-checker lock, reopen-with-reason. | `modules/ledger/close.service.ts`; controls GL-15/16/16b |
| **Adjacent supply-chain** | Available-to-promise, WMS replenishment, ML demand forecast already exist. | `costing/atp.service.ts`, `wms/replenishment.service.ts`, `demand-ml/demand-forecast.service.ts` |

**Conclusion:** the manufacturing/MRP, procurement-depth, and most analytics scope of Track D is **done**.
Existing controls already cover it (MFG-01/02/03, the procurement SoD/match controls, BUD-01, ELC-06,
GL-15/16). Building the v0.1 phases would duplicate working, tested code.

## 2. Genuine residual gaps (the only additive work)

These are the items the audit could **not** find anywhere — small, non-duplicative, and each independently
shippable as a CI-green, doc-synced PR:

> **RG-1/2/3 DELIVERED** — three additive BI `REPORT_TYPES` (`exec_scorecard`, `budget_variance`,
> `supplier_scorecard`) on the existing scheduler spine (`bi.service.ts`; BiModule now imports
> Budget/Procurement/Match). No new control, no migration. Harness `tools/cutover/src/bi.ts` (26/26).
> RG-4 remains optional/open.

### RG-1 — Executive cross-module scorecard (BI `exec_scorecard`)
A single read-only health board uniting signals that already exist but are **not composed** in one place:
finance (margin/cash via `finance_trend`/kpiBoard), CRM (win rate/pipeline via `crm_win_loss`/
`pipeline_trend`), projects (portfolio CPI/SPI + at-risk via `ProjectsService.portfolioEvm`), and supply
chain (open three-way holds, supplier underperformers, MRP buy pressure). New BI `REPORT_TYPE`
`exec_scorecard` (schedulable + a web surface). Read-only composition over existing services — **no new
control, no migration.** Harness: extend `tools/cutover/src/bi.ts`.

### RG-2 — Budget-variance as a schedulable BI report type (`budget_variance`)
`budgetVsActual` exists but isn't exposed to the BI scheduler/subscription spine. Add a thin `budget_variance`
`REPORT_TYPE` that calls it and summarises material/unfavourable variances (ties to **ELC-06**). No new
control, no migration. Harness: extend `bi.ts`.

### RG-3 — Supplier-performance as a BI report type (`supplier_scorecard`)
Surface the existing scorecard compute as a schedulable `supplier_scorecard` `REPORT_TYPE` (avg score +
underperformer count). No new control, no migration. Harness: extend `bi.ts`.

### RG-4 — Close pre-lock programmatic validation (control GL-19) — DELIVERED
> **DELIVERED** — read-only `GET /api/ledger/close/validate?period=YYYY-MM` asserts: no unposted Draft JEs in
> the period, the period's Posted entries balance in aggregate, every posted entry is individually balanced,
> and suspense/clearing (2380/2390/1999/9999) net ~zero (advisory) → `ready` + `blockers`/`warnings` + a
> per-check breakdown, surfaced before the GL-16 lock. New **detective** control **GL-19** (RCM → 143). No
> migration (read-only). Harness `tools/cutover/src/basics.ts` (clean period ready; a Draft JE blocks).

## 3. Recommendation & order
RG-1 → RG-2 → RG-3 are pure BI-spine additions (share `bi.service.ts`/`bi.ts`, so sequence them, don't
overlap). RG-4 is independent (ledger/close) and optional — it is the only one bearing a new control. Each is
one PR under the same discipline (local validate → push → CI 88-green → squash-merge), doc-synced
(narrative/RCM where applicable + UAT + harness). Everything else in Track D is **already delivered** and is
marked so here and in `docs/20`.

## 4. Out of scope (unchanged)
Any rebuild of already-shipped MRP/QC/RFQ/match/budget functionality. **Finite-capacity scheduling (APS)** and
**real-time streaming analytics** are now planned in `docs/22-aps-streaming-analytics-plan.md` (they extend
the mfg-depth routings/RCCP and the existing `@Sse` realtime bus respectively — not greenfield).

## 5. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-30 | ERP / Product | Initial Track-D gap-closure roadmap (MRP flagship). **Over-scoped — see v0.2.** |
| 0.2 RECONCILED | 2026-06-30 | ERP / Product | Corrected after a deeper audit: MRP/RCCP/plan-to-PR, QC disposition/scrap, shop-floor ops, RFQ, three-way AP hold, budget-vs-actual, and supplier scorecards are **already implemented + harness-tested**. Narrowed to genuine residual gaps RG-1..4 (exec scorecard, budget-variance + supplier-scorecard BI types, optional close pre-lock validation GL-19). No duplicate builds. |
