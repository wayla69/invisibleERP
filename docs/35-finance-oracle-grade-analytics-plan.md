# Doc 35 — Finance & Accounting: Oracle-Grade Dashboards & KPI Plan

**Status:** Draft for approval · **Owner:** CTO / CFO · **Created:** 2026-07-05
**Driver:** Executive feedback — *"the account & finance part is still too far from Oracle; there should be
more valuable dashboards and KPIs."* Today's finance analytics are **broad but scattered**: raw statement
endpoints, a generic widget dashboard, a 4-metric BI KPI board, and a single working-capital health score.
There is no CFO command center, no canonical financial-KPI/ratio scorecard, no close cockpit, and no visual
cash/treasury dashboard. This plan builds the **Oracle Fusion ERP + EPM-grade analytics layer** on top of the
ledger and sub-ledgers we already have — a decision-grade, drill-through, comparative KPI experience.

> **Working-agreement note (CLAUDE.md):** every code change in this plan ships with its doc updates —
> process narratives + Mermaid + RCM/SoD (`compliance/build_rcm.py` → regenerate the xlsx), user-manual
> module guides, and UAT cases (positive + negative/control). Each workstream below lists its doc
> deliverables. Migrations (if any) are journaled (`meta/_journal.json`), use the **next free** 4-digit
> number, and carry a strictly-increasing `when`. The **`basics`** harness is the primary gate for GL/AR/AP
> work; a new **`finance-kpi`** cutover harness gates the metrics engine. Keep `bi`, `compliance`,
> `worldclass`, `epm-planning`, `financial-health` green.

---

## 0. Guiding principles

1. **Aggregate, don't duplicate.** Everything here is a **read-only aggregator** over the existing GL
   (`journalLines`/`accounts`), sub-ledgers (`arInvoices`, `apTransactions`, `custPosSales`,
   `inv_balances`), budget (`BudgetService`), planning (`PlanningService`), and cash-flow engines
   (`LedgerService.cashFlow*`). No new posting logic, no touching parity-locked paths.
2. **One canonical metric definition.** Every KPI is defined **once** in a `FinanceMetricsService` with an
   explicit formula, GL/sub-ledger source, and RAG threshold — so the dashboard, the scheduled email pack,
   the AI narrative, and the `exec_scorecard` all read the **same** number. No metric drift.
3. **Comparatives are the value, not the number.** Oracle's edge is *context*: every KPI ships with
   **prior-period, prior-year (YoY), budget, and forecast** comparatives + variance% + RAG + trend
   sparkline. A bare number is a report; a number-in-context is a decision.
4. **Drill-through everywhere.** Each tile links to the statement/sub-ledger rows behind it
   (KPI → account group → GL lines). No dead-end dashboards.
5. **Business-day correct (Asia/Bangkok).** All period math uses `ymd()`/`bizYmdDash` on the business day
   (UTC+7), never raw UTC (CLAUDE.md timezone gotcha).
6. **Every phase stays green and ships its docs.** Each phase is an independently mergeable, doc-synced PR
   in the docs/19–23 style.

---

## 1. Oracle benchmark → gap analysis

| Oracle capability (Fusion ERP / EPM) | What Oracle gives | What we have today | Gap this plan closes |
|---|---|---|---|
| **Financial Reporting Center / GL Infolets & Account Groups + KPIs** | Configurable account groups with computed ratios, prior-period & budget comparison, RAG, drill | `bi kpi_board` (4 aggregates), `finance/health` (1 score) | **Canonical ~32-KPI engine** with comparatives + RAG + drill (Phase 1–2) |
| **CFO / Executive infolet dashboard** | Single pane: liquidity, profitability, cash, AR/AP, close | Generic widget grid `/dashboard`; `exec_scorecard` has **no UI** | **CFO Command Center** page (Phase 2) |
| **Financial Consolidation & Close (FCCS) — Close Manager** | Period-close task status, subledger tie-out, recon status, close monitor | `close.service`, `subledger-tieout.service`, `/finance/period-close` (functional, not a cockpit) | **Controller Close Cockpit** (Phase 3) |
| **Account Reconciliation (ARCS)** | Recon status board, aging of unreconciled items | `reconcile`/`reconcileControls` endpoints, `/reconciliation` page | **Reconciliation status dashboard** (Phase 3) |
| **Cash Management / Treasury** | Bank-balance position, N-week cash forecast, liquidity | `cashFlowForecast` (8-week) endpoint only; no visual | **Treasury / Cash Command** (Phase 4) |
| **Profitability & Cost Mgmt (PCM)** | P&L by segment (entity/product/customer/cost-center) | `/profitability` page (thin), multi-dim postings exist | **Segment profitability analytics** (Phase 5) |
| **Narrative Reporting (MD&A)** | Auto-commentary explaining KPI/variance movements | `/insights`, `/nl-analytics` (generic) | **AI finance narrative** on KPI/variance deltas (Phase 6) |
| **Smart View live KPIs / streaming** | Near-real-time refresh | `BiLive` SSE emits only `kpi_refresh` | **Live finance KPI stream** (`fin_kpi_refresh`) across phases |

**Net:** the plumbing (statements, sub-ledgers, budget, planning, EVM, both cash-flow methods) is already
there — but there is **no analytical layer** that turns it into a canonical, comparative, drill-through,
CFO-grade experience. That layer is what we build.

---

## 2. Target architecture

```
                     ┌─────────────────────────────────────────────┐
                     │  FinanceMetricsService  (new, read-only)     │
                     │  • METRICS registry: id → {formula, source,  │
                     │    unit, group, direction, ragThresholds}    │
                     │  • computePack(asOf, {compare:[pp,py,budget, │
                     │    forecast]}) → KPI[] with value+deltas+RAG │
                     │  • trend(id, periods) → sparkline series      │
                     │  • drill(id) → underlying account-group rows  │
                     └───────────────┬─────────────────────────────┘
        reads (no writes)            │  reuses existing services
   ┌───────────────┬─────────────────┼───────────────┬───────────────┐
 LedgerService   FinanceService   BudgetService   PlanningService  CollectionsSvc
 (TB, IS, BS,    (AR/AP aging,    (budgetVsActual) (scenario/       (AR worklist,
  cashFlow*)      health, kpi)                       forecast)        credit)
        │                                                                │
        └──────────────────────────── consumers ─────────────────────────┘
   BiService.exec_scorecard   ·   new BI report types (§6)   ·   BiLive SSE (fin_kpi_refresh)
   /api/finance/metrics/*  →  CFO Command Center · Close Cockpit · Treasury · Profitability (web)
```

**New API surface** — `@Controller('api/finance/metrics')` (perms `exec`, `fin_report`, `dashboard`):
- `GET /pack?as_of=&compare=pp,py,budget,forecast&group=` → the KPI scorecard (all groups or one).
- `GET /:id/trend?periods=12&grain=month` → single-KPI trend series (sparkline + table).
- `GET /:id/drill?as_of=` → the account-group / sub-ledger rows behind a KPI (drill-through).
- `GET /close-status?period=` → close-cockpit snapshot (Phase 3).
- `GET /cash-position?weeks=13` → treasury snapshot (Phase 4).
- `GET /profitability?by=branch|customer|product|cost_center&period=` → segment P&L (Phase 5).

**Web** — a dedicated **Finance Analytics** workspace/subgroup in `nav.ts` (lift finance analytics out of the
generic `planning` group): CFO Command Center, Close Cockpit, Treasury, Profitability, plus the existing
`/financial-statements`, `/financial-health`, `/bi` re-homed under it.

---

## 3. The canonical KPI catalog (`METRICS` registry — Phase 1)

Every entry: `id · formula · source · unit · direction (↑good/↓good) · RAG thresholds`. Grouped as Oracle's
infolet families. (~32 KPIs; RAG bands are defaults, tenant-overridable in a later iteration.)

**Liquidity**
| KPI | Formula | Source |
|---|---|---|
| Current ratio | current assets ÷ current liabilities | TB account groups |
| Quick (acid-test) ratio | (current assets − inventory) ÷ current liabilities | TB |
| Cash ratio | cash & equivalents ÷ current liabilities | TB (`CASH_ACCOUNTS`) |
| Working capital | current assets − current liabilities | TB |
| Days cash on hand | cash ÷ avg daily operating outflow | TB + P&L (extends `financial-health`) |
| Cash conversion cycle (CCC) | DSO + DIO − DPO | sub-ledgers |

**Efficiency / working-capital velocity**
| KPI | Formula | Source |
|---|---|---|
| DSO (days sales outstanding) | AR ÷ credit revenue × days | `arInvoices` + revenue |
| DPO (days payable outstanding) | AP ÷ COGS × days | `apTransactions` + COGS |
| DIO (days inventory outstanding) | inventory ÷ COGS × days | `inv_balances` + COGS |
| AR turnover | credit revenue ÷ avg AR | sub-ledger |
| AP turnover | COGS ÷ avg AP | sub-ledger |
| Inventory turnover | COGS ÷ avg inventory | sub-ledger |

**Profitability**
| KPI | Formula | Source |
|---|---|---|
| Gross margin % | (revenue − COGS) ÷ revenue | P&L (reuses `financeTrend` classify) |
| Operating margin % | operating income ÷ revenue | P&L |
| Net margin % | net income ÷ revenue | P&L |
| EBITDA | operating income + D&A | P&L (D&A from FA/lease depreciation accounts) |
| EBITDA margin % | EBITDA ÷ revenue | P&L |
| Return on assets (ROA) | net income ÷ avg total assets | P&L + BS |
| Return on equity (ROE) | net income ÷ avg equity | P&L + BS |

**Leverage / solvency**
| KPI | Formula | Source |
|---|---|---|
| Debt-to-equity | total liabilities ÷ equity | BS |
| Interest coverage | EBIT ÷ interest expense | P&L |
| Net debt | interest-bearing debt − cash | BS |

**Growth & cash**
| KPI | Formula | Source |
|---|---|---|
| Revenue growth (MoM / YoY) | Δ revenue vs prior period/year | `financeTrend` |
| Operating cash flow (OCF) | from `cashFlowStatement` (indirect) | `LedgerService` |
| Free cash flow (FCF) | OCF − capex | cash-flow + FA capex accounts |
| Cash burn / runway (months) | cash ÷ monthly net burn | TB + P&L |

**Receivables / payables health** (drill straight to aging)
| KPI | Formula | Source |
|---|---|---|
| Overdue AR % | overdue AR ÷ total AR | `arAging` |
| AR > 90d concentration | 90+ bucket ÷ total AR | `arAging` |
| Overdue AP % / early-pay-discount capture | overdue AP ÷ total AP | `apAging` |
| Bad-debt / allowance coverage | ECL allowance ÷ AR | `ar-allowance` |

**Budget & close** (Phase 3/6)
| KPI | Formula | Source |
|---|---|---|
| Budget variance % (rev/opex) | (actual − budget) ÷ budget | `BudgetService.budgetVsActual` |
| Forecast accuracy | actual vs prior forecast | `PlanningService` variance |
| Days to close | close-complete date − period-end | `close.service` |
| Unreconciled items / aging | open recon count + age | `reconcile` |

Each KPI returns: `{ id, group, label/labelEn, value, unit, prior_period, prior_year, budget, forecast,
delta_pp_pct, delta_yoy_pct, vs_budget_pct, rag: 'green'|'amber'|'red', trend: number[], drill_href }`.

---

## PHASE 1 — Finance Metrics Engine (foundation, API-only) — ✅ DELIVERED (2026-07-05)

**Shipped:** `FinanceMetricsService` + `finance-metrics-constants` (31-KPI `METRICS` registry + `FIN_STATEMENT_MAP`
account groups) + `GET /api/finance/metrics/pack|:id/trend|:id/drill`; `exec_scorecard` finance leg now reads the
canonical engine; detective control **ELC-07** added to the RCM (→ 184 controls); `finance-kpi` cutover harness
(34 checks) green; docs synced (PN-26 §3c rev 2.0, user manual 09 §1b, UAT-RPT-050). Efficiency KPIs (turnover,
DSO/DPO/DIO, ROA/ROE, days-cash, runway) use a **trailing-twelve-month basis** so partial-month views aren't
distorted; margins use the selected window. Below is the original plan.

**Goal:** the canonical `FinanceMetricsService` + `GET /api/finance/metrics/pack|:id/trend|:id/drill`, wired
into `exec_scorecard` so it stops hand-rolling finance legs.
**Outcome demo:** `GET /api/finance/metrics/pack?compare=pp,py,budget` returns all ~32 KPIs with
comparatives, variance%, and RAG — one call, one source of truth.

- **Service:** `apps/api/src/modules/finance/finance-metrics.service.ts` — `METRICS` registry + `computePack`,
  `trend`, `drill`. Reuses `LedgerService` (TB/IS/BS/cash-flow), `FinanceService` (aging/health),
  `BudgetService`, `PlanningService`. All legs `@Optional()` so partial harnesses still construct (BI pattern).
- **Account grouping:** introduce a `FIN_STATEMENT_MAP` (asset/liability/equity/revenue/COGS/opex/interest/D&A
  buckets by GL code) next to `CF_CLASSIFY`/`ledger-constants.ts`, so BS/P&L KPIs classify consistently. **New
  balance-sheet/P&L accounts must be added here** (mirror the existing CF_CLASSIFY gotcha).
- **Controller:** `finance-metrics.controller.ts` (perms `exec`,`fin_report`,`dashboard`). Reuse the BI
  read-through cache (`BI_CACHE_TTL_MS`) — dashboard polls collapse to one query set per tenant/window.
- **Refactor:** `BiService.execScorecard()` finance leg → delegate to `FinanceMetricsService` (single source).
- **Docs:** PN — new §"Financial analytical review" in the GL/finance narrative; **new detective control
  `ELC-07` (management review of financial KPIs)** in `build_rcm.py` → regenerate xlsx + `compliance.ts`.
  User manual: new "Finance KPIs" reference (each KPI's formula + RAG). UAT: KPI values reconcile to the
  statements (positive) + permission denial for non-finance roles (control).
- **Harness:** new `tools/cutover/src/finance-kpi.ts` — seed a known GL and assert each KPI equals the
  hand-computed value; assert comparatives + RAG; assert drill rows tie to the sub-ledger. Register as a
  cutover gate.

## PHASE 2 — CFO Command Center (web dashboard + live) — ✅ DELIVERED (2026-07-05)

**Shipped:** `/finance/command-center` (server-prefetch page + client island) — a RAG summary strip + the
KPI scorecard grouped by family; each tile shows value + RAG (icon+label, never colour-alone) + prior-period/
prior-year/budget deltas, expandable to a lazy 12-month SVG sparkline with a drill link to the statements.
Live off the SSE bus: `BiService.refreshSnapshot` now also publishes **`fin_kpi_refresh`**, and the client
re-pulls the pack on it (reuses `useRealtime`). New nav entry (Finance → `nav.command_center`, `Gauge` icon),
i18n (`fnx.cfo.*`, th/en). Theme-aware (uses the design-system status tokens; dark mode inherited). Below is
the original plan.

**Goal:** the single-pane executive finance dashboard Oracle infolets deliver.
**Outcome demo:** `/finance/command-center` shows KPI scorecard tiles (value + RAG + YoY + sparkline), a cash
snapshot, P&L-vs-budget bars, and AR/AP aging — each tile drills to detail.

- **Page:** `apps/web/src/app/(internal)/finance/command-center/page.tsx` (server-prefetch pattern like
  `financial-health`). Sections: **KPI scorecard grid** (grouped tiles w/ RAG chips + sparkline + delta),
  **Liquidity & CCC** gauge, **P&L vs budget vs forecast** bars, **AR/AP aging** heat with drill,
  **cash position** mini-chart. Tiles link to `/financial-statements`, `/finance` (aging), etc.
- **Charts:** follow the `dataviz` skill for palette/RAG semantics (accessible in light+dark).
- **Live:** publish `fin_kpi_refresh` on the existing `BiLive` bus (extend `BiLiveEvent`) so tiles update
  without a reload; `refreshSnapshot` already publishes — add the finance KPI payload.
- **Nav:** new **Finance Analytics** subgroup under `nav.group.finance` (or a lifted workspace): Command
  Center, + re-home `/financial-statements`, `/financial-health`, `/bi`. Perms `exec`,`fin_report`,`dashboard`.
- **Docs:** user-manual module guide (route, role, drill map, RAG legend); PN screenshot/reference; UAT: tile
  values match the pack API; drill navigates correctly; RAG turns red past threshold.
- **Harness:** extend `finance-kpi.ts` for the `fin_kpi_refresh` SSE + tenant isolation (mirror `bi.ts`
  `kpi_refresh` test). Optional Playwright smoke (`command-center.capture.spec.ts`, `testIgnore`d in CI).

## PHASE 3 — Controller Close Cockpit + Reconciliation board — ✅ DELIVERED (2026-07-05)

**Shipped:** `GET /api/finance/metrics/close/status?period=` + `/finance/close-cockpit` (server-prefetch page +
client island). One RAG board composing the existing detective controls: sub-ledger↔GL **tie-out** (REC-04),
**pre-lock readiness** (GL-19 + snapshot recon GL-20), the **pending maker-checker queue** (GOV-01), and the
**close checklist** (GL-15/16), plus a **days-to-close** metric. New detective control **GL-22** (close cockpit
review) → RCM 185 controls. `finance-kpi` harness extended to 41 checks (tie-out break → RED → reconcile →
GREEN; non-finance role denied). Nav + i18n (`fnx.cockpit.*`). Below is the original plan.

**Goal:** Oracle FCCS Close-Manager / ARCS-style monitoring surface for the controller.
**Outcome demo:** `/finance/close-cockpit` shows current-period close status: subledger tie-out (green/red),
open reconciliations + aging, pending journal approvals, days-to-close, and a period-close checklist.

- **Aggregator:** `GET /api/finance/metrics/close-status?period=` — composes `close.service` (period state),
  `subledger-tieout.service` (AR/AP/inventory ⇄ control-account tie-out), `reconcile`/`reconcileControls`,
  `ledger journal/pending`, and the close KPIs (§3). Read-only.
- **Page:** close-cockpit web page — tie-out RAG rows, recon aging, approval queue, close checklist,
  days-to-close trend.
- **Controls/Docs:** **new detective control `GL-20` (period-close monitoring / cockpit review)** in the RCM;
  update the close-cycle narrative + Mermaid; user-manual close guide; UAT: cockpit flags an out-of-balance
  subledger (control) + a clean close (positive).
- **Harness:** extend `basics.ts` (primary GL gate) — seed an intentional tie-out break, assert the cockpit
  reports it red; then reconcile and assert green.

## PHASE 4 — Treasury / Cash Command — ✅ DELIVERED (2026-07-05)

**Shipped:** `GET /api/finance/metrics/cash/position?weeks=13` + `/finance/treasury` (server-prefetch page +
client island). Composes the GL cash/bank position (per account + house banks, ties to the trial balance),
the **13-week direct cash forecast** (reuses `cashFlowForecast`/GL-07) with projected closing + the liquidity
**trough** (min balance + week), the liquidity KPI subset, and **FX exposure** by non-THB currency. Web page:
headline stats + a single-series cash-forecast area chart (trough marked) + cash/bank, liquidity and FX
panels. New detective control **TR-01** (treasury cash-position review) → RCM 186. `finance-kpi` harness
extended to 48 checks (total_cash ties to TB; 13-week forecast 100k→150k; FX picks up a USD payable; role
denied). Nav + i18n (`fnx.treasury.*`). Below is the original plan.

**Goal:** Oracle Cash-Management-style liquidity view.
**Outcome demo:** `/finance/treasury` shows bank/cash balances by account, a **13-week direct cash forecast**
waterfall (extends `cashFlowForecast` to 13w + scenario overlay), liquidity ratios, and an FX exposure strip.

- **Aggregator:** `GET /api/finance/metrics/cash-position?weeks=13` — bank/cash GL balances (`cash-banking`,
  `bankrec`), the direct forecast (open AR/AP by due date, reuse `cashFlowForecast`, raise cap to 13w),
  liquidity KPIs, and FX exposure (`fxreval`/`fx`). Read-only.
- **Page:** treasury dashboard (balances table + forecast waterfall chart + liquidity gauges).
- **Docs:** cash/treasury narrative section; user-manual treasury guide; UAT: forecast reconciles to open
  AR/AP; balances tie to `trial-balance`. **Control `TR-01` (cash-position review)** if not already covered.
- **Harness:** extend `cashreport.ts`/`financial-health.ts` for the 13-week forecast + balances tie-out.

## PHASE 5 — Segment profitability analytics (PCM-lite) — ✅ DELIVERED (2026-07-05)

**Shipped:** `GET /api/finance/metrics/profitability?by=branch|cost_center|project&period=` + `/finance/profitability`
(server-prefetch page + client island). Segment P&L (revenue → COGS → gross → opex → net + margins per
segment, contribution %, top-down sorted) computed straight from the **dimensional GL** (branch/cost-centre/
project already on `journal_lines`), with a **reconcile-to-consolidated-P&L** flag. Web: dimension switcher +
totals + reconcile badge + a net-contribution bar chart + the per-segment P&L matrix. `finance-kpi` harness
extended to 54 checks (branch segments reconcile to the P&L: rev 150k / net 50k; empty period → zero, not
error; bad dimension → 400). Nav + i18n (`fnx.prof.*`). **No new RCM control** — read-only analytics that
reinforces GL-13 (dimensional completeness) + ELC-07 (analytical review). *Customer/product profitability is
sub-ledger, not a GL dimension — a documented follow-up.* Below is the original plan.

**Goal:** Oracle PCM-style P&L by dimension.
**Outcome demo:** `/profitability` upgraded — gross/operating margin **by branch / customer / product /
cost-center**, contribution ranking, and margin-trend, all from the multi-dimensional postings that already
exist (`income-statement/by-branch`, `cost-centers`).

- **Aggregator:** `GET /api/finance/metrics/profitability?by=&period=` — segment P&L + margin + contribution
  %, top/bottom performers, MoM trend. Reuse dimensional GL (branch/cost-center already on postings).
- **Page:** rebuild `/profitability` as a segment analytics board (matrix + waterfall + trend).
- **Docs:** update profitability narrative + user manual; UAT: segment totals reconcile to the consolidated
  P&L (positive) + a segment with no activity returns zero, not error (control).
- **Harness:** extend `finance-kpi.ts` — per-branch margins sum to the total P&L.

## PHASE 6 — AI narrative (MD&A) + scheduled KPI packs + benchmarks

**Goal:** Oracle Narrative-Reporting-style auto-commentary + schedulable/emailable KPI packs.
**Outcome demo:** a monthly `cfo_kpi_pack` email lands with the scorecard **and** an AI paragraph:
*"Gross margin fell 2.1pp MoM driven by COGS +8%; DSO rose to 47d (amber); runway 9.2 months."*

- **New BI report types** (`bi.service.ts` `REPORT_TYPES` + `generateReport`, journaled scheduler pattern):
  `cfo_kpi_pack`, `financial_ratios`, `working_capital`, `cash_position`, `close_status` — each wraps a
  `FinanceMetricsService` method, idempotent, `@Optional()`-injected. Schedulable daily/weekly/monthly,
  delivered via the existing email/LINE/in-app recipient loop.
- **AI narrative:** feed the KPI pack (with comparatives + RAG) to the existing AI insight surface
  (`analytics POST /insight` / `nl-analytics`) to generate variance commentary; attach to the pack + surface
  on the Command Center as a "What changed" panel.
- **Benchmarks (optional):** tenant-set target/threshold overrides for RAG (a small `finance_kpi_targets`
  table) so RAG reflects each business's own targets — Oracle account-group behaviour.
- **Docs:** register the new report types in the user-manual scheduled-reports guide + PN; UAT: a scheduled
  `cfo_kpi_pack` run produces a report + narrative and logs a `reportRuns` row; ITGC-OP-04 failure capture
  holds (mirror `bi.ts`).
- **Harness:** extend `bi.ts` — assert the new report types exist, generate, and their summaries carry the
  headline KPIs; assert the scheduler runs one and logs it.

---

## 4. Controls summary (RCM additions)

| Control | Type | Assertion |
|---|---|---|
| **ELC-07** — Management review of financial KPIs | Detective / monitoring | CFO scorecard reviewed on cadence; RAG breaches trigger action (COSO P16 ongoing evaluation) |
| **GL-20** — Period-close monitoring (cockpit) | Detective | Subledger tie-out + reconciliation status reviewed before close lock |
| **TR-01** — Cash-position review | Detective | Weekly liquidity/forecast review (if not already covered by an existing treasury control — confirm during Phase 4) |

All three are **read-only monitoring** controls (no new posting authority ⇒ no new SoD conflict). Add via
`compliance/build_rcm.py`, regenerate `Oshinei_ERP_SOX_RCM_v1.xlsx` (Phase 1 adds **ELC-07** → 184 controls), and
mirror in `tools/cutover/src/compliance.ts`.

## 5. Sequencing & PR plan

Six sequential, independently-shippable, doc-synced PRs (docs/19–23 cadence):

1. **PR-1 (Phase 1):** metrics engine + `/api/finance/metrics/*` + `finance-kpi` harness + `ELC-07`. *No web.*
2. **PR-2 (Phase 2):** CFO Command Center page + nav + `fin_kpi_refresh` SSE.
3. **PR-3 (Phase 3):** Close Cockpit + reconciliation board + `GL-20`.
4. **PR-4 (Phase 4):** Treasury / Cash Command (13-week forecast) + `TR-01`.
5. **PR-5 (Phase 5):** Segment profitability rebuild.
6. **PR-6 (Phase 6):** Scheduled KPI packs + AI narrative + RAG target overrides.

PR-1 is the keystone (single source of truth); 2–6 layer on it and can be reordered by business priority.
**Recommended first slice for fastest visible value: PR-1 + PR-2** (engine + CFO Command Center) — that alone
closes the biggest Oracle gap (a real, comparative, drill-through CFO dashboard).

## 6. Explicitly out of scope

- Rebuilding the posting engine / CoA (that is docs/17–18; this plan **consumes** the ledger, never rewrites it).
- Parity-locked paths (`forecasting.service.ts`) — untouched.
- New statutory statements (we already have IS/BS/both cash-flow methods; we visualize and analyze them).
- Full multi-dimensional OLAP/Smart-View pivot builder — the existing `/query` + `/nl-analytics` cover ad-hoc;
  this plan delivers **curated** CFO analytics, not a generic cube designer.

## 7. Success criteria

- `GET /api/finance/metrics/pack` returns ≥30 KPIs with prior-period + YoY + budget comparatives and RAG, and
  every value reconciles to the statements (asserted in `finance-kpi.ts`).
- CFO Command Center renders the scorecard with live RAG + drill-through in light and dark themes.
- A scheduled `cfo_kpi_pack` delivers the scorecard + AI narrative and logs a `reportRuns` row.
- All existing gates stay green; three new monitoring controls added to the RCM; docs (PN + user manual +
  UAT) updated per the working agreement.

---

## Revision history

| Date | Author | Change |
|---|---|---|
| 2026-07-05 | CTO/CFO | Initial draft for approval — Oracle-grade finance dashboards & KPI plan (Phases 1–6). |
| 2026-07-05 | Platform | **Phase 1 DELIVERED** — FinanceMetricsService (31 KPIs) + `/api/finance/metrics/*`, exec_scorecard refactor, ELC-07 control, `finance-kpi` harness (34 ✓), doc sync (PN-26 §3c, manual 09 §1b, UAT-RPT-050). |
| 2026-07-05 | Platform | **Review fix** — efficiency/annualized KPIs (turnover, DSO/DPO/DIO, ROA/ROE, days-cash, runway) moved to a **trailing-12-month basis** (window-length-independent; CLOSE-excluded via new `incomeStatement` `excludeSources` arg) after review showed month-to-date windows distorting them; growth KPIs regrouped into `growth_cash`. Harness 28→34 checks. |
| 2026-07-05 | Platform | **Phase 2 DELIVERED** — `/finance/command-center` web dashboard (RAG scorecard tiles + comparatives + lazy 12-mo sparkline + drill), live `fin_kpi_refresh` SSE, nav + i18n. Web build + `pnpm -r typecheck` clean. |
| 2026-07-05 | Platform | **Phase 3 DELIVERED** — Controller Close Cockpit: `GET /api/finance/metrics/close/status` + `/finance/close-cockpit` (tie-out REC-04 + readiness GL-19/20 + approvals GOV-01 + checklist, RAG + days-to-close); control GL-22 (RCM 185); `finance-kpi` 41 checks; nav + i18n. |
| 2026-07-05 | Platform | **Phase 4 DELIVERED** — Treasury / Cash Command: `GET /api/finance/metrics/cash/position` + `/finance/treasury` (GL cash/bank position + 13-week forecast w/ trough + liquidity subset + FX exposure); control TR-01 (RCM 186); `finance-kpi` 48 checks; nav + i18n. |
| 2026-07-05 | Platform | **Phase 5 DELIVERED** — Segment profitability: `GET /api/finance/metrics/profitability?by=branch\|cost_center\|project` + `/finance/profitability` (per-segment P&L + margins + contribution, reconciles to consolidated P&L); `finance-kpi` 54 checks; nav + i18n. No new control (read-only analytics; reinforces GL-13/ELC-07). |
