# 21 — Track D: adjacent-ERP depth (gap-closure roadmap)

> **Status:** PLANNING (no code in this phase — this document is the deliverable).
> **Supersedes the "Track D" placeholder** in `docs/20-project-management-next-level-plan.md` §Track D.

## Document control

| Field | Value |
|---|---|
| Owner | ERP / Product |
| Version | 0.1 DRAFT |
| Date | 2026-06-30 |
| Scope | The four "adjacent ERP" areas parked in `docs/20`: finance **close automation**, **procurement** depth, **manufacturing / MRP**, **cross-module analytics**. |
| Premise | **Build on, don't duplicate.** A current-state survey (below) shows three of the four areas are already substantially built. This roadmap therefore targets the *genuine gaps*, not greenfield rebuilds. |

## 1. Current-state inventory (the honest reframe)

`docs/20` parked Track D as if these were unbuilt. They are not — the codebase already carries most of it. What follows is what exists today (with file paths) and the **gaps** each phase will close.

### 1A. Finance close automation — **already automated**
- `apps/api/src/modules/ledger/close.service.ts` + `close.controller.ts`: `close_runs` + `close_run_steps`
  (7-step checklist: subledger_tieout, bank_rec, depreciation, recurring, fx_reval, deferred_tax,
  trial_balance_review), `startClose`/`completeStep`/`lockPeriod`/`reopenPeriod`. Controls **GL-15**
  (checklist gating), **GL-16** (lock maker-checker), **GL-16b** (reopen reason + segregation), **GL-02**
  (`PERIOD_LOCKED` posting block via `fiscal_periods`). Web `/finance/period-close`. Harness
  `tools/cutover/src/close.ts`.
- Scheduler action-jobs (idempotent) ride the BI scheduler (`modules/bi/bi.service.ts`):
  `gl_recurring_journals`, `gl_prepaid_amortize`, `lease_periodic_run`, `ar_collections_dunning`,
  `eam_pm_generate`, `rev_rec_recognize`.
- **Gaps:** (a) no **pre-lock automated validation** — `ReadyToLock` is checklist-driven, but nothing
  *programmatically asserts* the books are actually clean (e.g. unbalanced-subledger, suspense/clearing
  non-zero, unposted-draft-JE, control-account tie); (b) no **close-task ↔ scheduler binding** so a
  checklist step (e.g. "recurring") auto-completes when its job runs; (c) no **multi-entity close
  cockpit** rollup across tenants.

### 1B. Procurement — **complete P2P spine**
- `apps/api/src/modules/procurement/procurement.service.ts`: PR (`createPr`/`approvePr`) → PO
  (`createPo`/`approvePo`/`cancelPo`) → GR (`createGr`, three-way match, capital routing, lot ledger,
  FIFO/AVG costing). Supplier master + screening (fail-closed `assertSupplierAllowed`), scorecards
  (`recomputeScorecard`), versioned price lists (`upsertSupplierPrice`, migration 0174). Approval workflow
  (migration 0030). Nav group **Procurement** (Requisitions, Suppliers, POs, RFQs, PO Match, Scorecards,
  Prices, Supplier Portal).
- **Gaps:** (a) **RFQ / competitive sourcing** — a nav item exists but no sourcing *service* (request →
  quotes from N suppliers → award → PO seeded from the winning quote); (b) **invoice 3-way hold** — GR/PO/
  invoice data exists but no explicit AP-invoice *block* on a price/qty mismatch beyond tolerance; (c) **PR
  auto-source from MRP** (see 1C) and a **supplier-performance analytics** surface (scorecard data exists,
  no dashboard/report type).

### 1C. Manufacturing — **partial (WO lifecycle yes; MRP no)**
- `apps/api/src/modules/bom/bom.service.ts`: `bom_master` (+ lines, costing roll-up), push to tenant,
  submissions/approval. `apps/api/src/modules/manufacturing/manufacturing.service.ts`: `work_orders` (+
  components), `createWorkOrder` (scales BOM), `issue` (Dr 1250 WIP / Cr 1200 / Cr 2380), `complete`
  (Dr 1210 FG / Cr 1250 WIP + 5810 yield/material variance). Controls **MFG-01/02/03**. Harness
  `tools/cutover/src/manufacturing.ts`. (EAM maintenance work orders are a *separate* thing — `modules/eam/`.)
- **Gaps (the real greenfield):** (a) **MRP / net-requirements run** — no demand explosion (BOM ×
  demand − on-hand − on-order → planned orders) producing **planned purchase requisitions** (→ 1B) and
  **planned work orders**; (b) **shortage/availability signal** beyond the one-off `bom-availability`
  harness; (c) production **scheduling/sequencing** and **QC hold/release** gating completion; (d) **scrap**
  classification distinct from yield variance.

### 1D. Cross-module analytics — **comprehensive BI spine**
- `apps/api/src/modules/bi/bi.service.ts`: 13 `REPORT_TYPES` (`kpi_board`, `sales_cube`, `finance_trend`,
  `pipeline_trend`, `project_evm`, `crm_win_loss`, the action-jobs, `data_retention_purge`),
  `generateReport`/`executeSubscription`, `report_subscriptions`/`report_runs`, `bi_daily_snapshots`,
  read-through cache. Web `/bi`, `/dashboard`, `/profitability`, `/nl-analytics`. Budget module +
  `budget_reviews` (ELC-06).
- **Gaps:** (a) **budget-vs-actual variance** as a first-class report type (budgets + actuals exist but no
  `budget_variance` BI type bridging them); (b) **drill-down roll-ups** (by branch/channel/product) on the
  otherwise-flat KPI board; (c) an **executive cross-module scorecard** uniting finance + CRM + projects +
  ops + supply-chain health (the analytics "workspace" docs/20 imagined).

## 2. Design principle — extend the proven spines

Every phase plugs into an existing module/service/table set and reuses: the GL `postEntry` path (no new
accounts unless a cycle genuinely needs one), the approval-workflow + maker-checker engine, the BI
`REPORT_TYPES` + scheduler, the RLS-per-tenant convention, the cutover-harness pattern, and the
documentation-sync policy (narrative + RCM + user-manual + UAT + harness alongside code).

## 3. Phased delivery roadmap

Each phase = one independently-shippable, CI-green, doc-synced PR (a track may be several PRs). New controls
are **candidates flagged for sign-off**. Migration numbers use the next free 4-digit id at build time
(currently **0193**). RCM is currently **142 controls**.

### Track D-A — Close automation depth
- **DA1 — Pre-lock validation gate (control candidate GL-17).** A programmatic "close readiness" check the
  `lockPeriod` path consults: asserts (i) no unposted draft JEs in the period, (ii) suspense/clearing
  accounts (e.g. 2390/2380) net to zero, (iii) subledger control accounts tie to their subledgers, (iv) no
  unbalanced batch. Surfaces blockers in the period-close UI; an override is reason-logged. *Detective→
  preventive.* Migration (a `close_validations` results table) + harness + RCM GL-17.
- **DA2 — Close-task ↔ scheduler binding.** When a scheduler action-job runs for the open period (e.g.
  `gl_recurring_journals`), auto-complete the matching checklist step with a system signature. No new
  control (operational); narrative + harness.

### Track D-B — Procurement depth
- **DB1 — RFQ / competitive sourcing (control candidate PROC-09).** `rfqs` + `rfq_lines` + `rfq_quotes`:
  raise an RFQ from a PR, collect quotes from ≥1 suppliers, **award** (authorized; award ≠ requester) →
  seed a PO from the winning quote. Web on the existing RFQs route. Migration + RCM PROC-09 + harness.
- **DB2 — AP invoice 3-way hold (control candidate PROC-10).** On AP invoice entry, compare to PO + GR; a
  price/qty variance beyond tolerance puts the invoice on **hold** (no payment) until released by an
  authorized approver (release ≠ enterer). Extends the existing three-way data. Migration + RCM PROC-10 +
  harness. (Ties to **REV/AP** disbursement SoD R07.)
- **DB3 — Supplier-performance analytics.** A `supplier_scorecard` BI report type (on-time / quality /
  price-variance / overall, underperformer flag) on the existing scorecard data + a portfolio surface. No
  new control (reporting); narrative + harness.

### Track D-C — Manufacturing / MRP (flagship)
- **DC1 — MRP net-requirements run (control candidate MFG-04).** The genuinely-new core: explode demand
  (sales orders / forecast / reorder points) against BOMs, net of on-hand + on-order, into **planned
  orders** — planned **purchase requisitions** (→ DB1/procurement) for bought items and planned **work
  orders** for made items, respecting lead times. Releasing a planned order is authorized (planner ≠
  approver). Tables `mrp_runs` + `mrp_planned_orders`; reuses `bom_master`, inventory on-hand, PO on-order.
  Migration + RCM MFG-04 + harness + web (MRP workbench).
- **DC2 — QC hold/release on work-order completion (control candidate MFG-05).** A WO can't `complete` into
  sellable FG while a QC hold is open; release is authorized + logged (inspector ≠ producer). Extends
  `manufacturing.service.ts complete`. Migration (`wo_qc_holds`) + RCM MFG-05 + harness.
- **DC3 — Scrap classification.** Separate **scrap** (Dr scrap-loss) from **yield variance** at WO
  completion, with a reason code, so loss is analysable. No new control (refines MFG-03); narrative + harness.

### Track D-D — Cross-module analytics
- **DD1 — Budget-vs-actual variance report type.** A `budget_variance` BI `REPORT_TYPE` bridging the budget
  module and GL actuals (per account/period: budget, actual, variance, %, RAG), schedulable + on a web
  surface. Ties to **ELC-06** (budget review); no new control. Migration only if a snapshot is needed.
- **DD2 — Executive cross-module scorecard.** A `exec_scorecard` BI type uniting finance (margin, cash),
  CRM (win rate, pipeline), projects (portfolio CPI/SPI, at-risk — reuse `portfolioEvm`), supply chain
  (MRP shortages, supplier underperformers, open high project risks) into one health board. Read-only
  composition over existing services; no new control; narrative + harness + web.

## 4. Suggested delivery order

1. **DC1 (MRP)** — highest net-new value, the one true greenfield, and the spine DB1/DB3 plug into.
2. **DB1 → DB2 → DB3** (procurement depth) — DB1 consumes MRP planned requisitions.
3. **DC2 → DC3** (manufacturing governance) — layer QC + scrap onto the WO path.
4. **DA1 → DA2** (close depth) — independent; can run in parallel (disjoint files).
5. **DD1 → DD2** (analytics) — last, so the scorecard can surface MRP/procurement/manufacturing signals.

Each is one PR; phases sharing the migration journal or `build_rcm.py` are sequenced (not overlapped) to
avoid the known journal/RCM merge collisions (CLAUDE.md). New controls would take the RCM to ~**148**.

## 5. Verification (per phase)
- Local: `pnpm -r typecheck`, `pnpm --filter @ierp/api build`, `pnpm --filter @ierp/web build` (UI phases),
  the relevant cutover harness extended + green (new `mrp.ts` for DC1; extend `manufacturing.ts`,
  `procurement.ts`/new `rfq.ts`, `close.ts`, `bi.ts`), `migrations-journaled` gate clean, RCM regenerated.
- CI: full 88-check matrix green before merge; docs reconciled per the documentation-sync policy.

## 6. Risks / out-of-scope
- **No rebuilds.** If a "gap" turns out to be already covered on closer inspection, the phase is dropped and
  the finding recorded here — duplication is a defect, not a deliverable.
- Finite-capacity scheduling (APS), full WIP inter-stage routing, and real-time streaming analytics remain
  **out of scope** (their own future roadmap) unless requested.
- Tax/e-invoice, payroll depth, and POS hardware are unrelated and excluded.

## 7. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-30 | ERP / Product | Initial Track-D gap-closure roadmap. Reframes docs/20's parked Track D after a current-state survey found close/procurement/analytics already substantially built and MRP the real greenfield. Phases DA1–2, DB1–3, DC1–3, DD1–2 with candidate controls GL-17, PROC-09/10, MFG-04/05. No code yet. |
