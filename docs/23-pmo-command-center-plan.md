# 23 — PMO Command Center: Action, Forecast & Governance — Design & Roadmap

> **Date:** 2026-06-30 · **Status:** v1.0 — **DELIVERED** (PMO-1, PMO-2, PMO-3 all shipped & merged) · **Owner:** ERP / Product
> **Scope:** Turn the now-complete PPM suite (`docs/19`/`20` + the four `docs/22`-era PPM upgrades —
> POC rev-rec, change orders, capacity calendar, health history) from a set of **pull** signals into a
> **PMO operating loop**: a single *what-needs-me-now* action center (proactively pushed), a
> **pipeline-weighted forward** resource/cash forecast, and a one-click **period governance pack**.
> **Decision recorded:** Same delivery discipline as `docs/19`/`20` — each phase is an
> independently-shippable, doc-synced PR (migration *if any* + module + permissions/SoD + RCM control +
> narrative + user-manual + UAT + cutover-harness), merged only on a fully green CI matrix.

---

## 0. Read this first — build on, don't duplicate

The spine is strong and **already built**; this plan adds *no new business-cycle accounting* — it
**aggregates and forecasts** over data the modules already produce. The relevant surfaces:

- **Project state** — `apps/api/src/modules/projects/projects.service.ts`:
  `evm()` / `evmSeries()` (`:516`/`:597`), `portfolioEvm()` (`:618`), risk register
  `listRisks()` / `topRisks()` with the `unmitigated_high` PROJ-08 signal (`:886`/`:932`/`:899`),
  change orders `createChangeOrder()` / `approveChangeOrder()` / `listChangeOrders()` (`:711`/`:728`/`:756`),
  milestones `listMilestones()` / `reachMilestone()` (`:387`/`:396`), baselines `getBaseline()` (`:693`),
  health snapshots `captureHealth()` / `captureAllHealth()` / `healthHistory()` (`:952`/`:959`),
  capacity `resourceCapacity()` (`:479`), CPM `schedule()` (`:549`).
- **Maker-checker queues already exist** but are scattered per-project: change-order approval
  (approver ≠ requester), timesheet→labor approval (HCM `/api/hcm/timesheets/:id/approve`), POC recognise
  (`gl_post`/`exec` gate).
- **Realtime bus** — `apps/api/src/modules/bi/bi-live.service.ts`: `publish({type, tenant_id, ...})`
  (`:16`), `stream()` (`:23`), tenant-filtered `recent()` (`:25`); web `useRealtime(onEvent, {path})`
  (`apps/web/src/hooks/use-realtime.ts`). This is how we make the action center **proactive** instead of
  a screen you remember to open.
- **BI scheduler** — `apps/api/src/modules/bi/bi.service.ts` `REPORT_TYPES` (`:37`) + `generateReport()`
  dispatch (`:501`): idempotent **action jobs** already include `project_health_capture`. A governance
  pack rides the same rail.
- **Pipeline** — `apps/api/src/modules/crm-pipeline/crm-pipeline.service.ts`: `pipelineSummary()` (`:119`,
  weighted forecast by stage probability) and `winLoss()` (`:140`).

**Current state to build on:** RCM **≈153 controls** (highest project control **PROJ-10**); `projects`
cutover harness **~112 assertions**; PN-16 narrative at **rev 0.20**; UAT through **UAT-O2C-220**; PPM nav
group `จัดการโครงการ` has 3 items (portfolio / projects / pipeline) in `apps/web/src/lib/nav.ts` (`:398`).

The three phases below are **independent** and ship in priority order. They touch the shared
`projects.service.ts`/`projects.controller.ts` and the migration journal, so — per the PPM-upgrade
lesson — they run **sequentially**, one merged PR before the next starts.

---

## Phase PMO-1 — Action center / exception inbox (+ proactive SSE)  ⭐ first — **DELIVERED**
> Shipped: `GET /api/projects/action-center` (`ProjectsService.actionCenter`), proactive `project_action`
> SSE via the shared `BiLiveService` (extracted to `bi-live.module.ts`), the `/projects/action-center` web
> inbox, control **PROJ-11** (RCM 154), PN-16 step 19 / row 16 / rev 0.21, user-manual 14 rev 1.8,
> UAT-O2C-221. Harness: `projects` 96 checks. No migration.
*Highest leverage, lowest new surface area. Converts every detective/maker-checker control we already own
into a single driven worklist.*

### Backend — `GET /api/projects/action-center`
A read-only aggregator (model it on `portfolioEvm()` — same `JwtUser` tenant scoping, same
`@Permissions('exec','planner','ar')` default) that returns a **prioritized, typed list of exceptions**
across all of the caller's projects, each item `{ kind, severity, project_code, title_th, title_en, ref,
href, as_of, meta }`, grouped/sorted by severity. Exception kinds, each sourced from an **existing** method
(no new data, no migration):

| Kind | Source | Why it's on my desk |
|---|---|---|
| `change_order_pending` | `listChangeOrders()` pending rows | Awaiting a *different* approver (the SoD checker half) |
| `timesheet_pending` | HCM pending approvals scoped to projects | Labor awaiting independent approval (PROJ-04) |
| `risk_unmitigated_high` | `topRisks()` `unmitigated_high` | Open HIGH risk with no mitigation plan (PROJ-08) |
| `project_red` | `evm()`/`portfolioEvm()` health buckets | CPI or SPI < 0.9 |
| `over_budget` | project cost vs budget | cost-to-date over budget / EAC > BAC |
| `milestone_slipping` | `listMilestones()` planned date < today, not reached | Schedule slip |
| `stale_health` | `healthHistory()` last snapshot age | No governance snapshot in *N* days (default 14) |
| `no_baseline` | `getBaseline()` empty | Project running without a change-controlled baseline (PROJ-07) |

- **Severity model:** `high` (red project, unmitigated-high risk, over-budget) / `medium` (pending
  approvals, slipping milestone, no baseline) / `low` (stale health). Return a `summary`
  (`{high, medium, low, total, by_kind}`) so a badge can show the count.
- Pure aggregation, posts nothing → it is a **detective control**: new RCM **PROJ-11** *"Governance
  exceptions surfaced for action (single PMO worklist)"* — Detective, Application; ToE = the harness asserts
  each seeded exception appears with the right kind/severity and clears when resolved.

### Proactive SSE
When a project transitions to **red** (in `snapProject()` / on EVM recompute) or an unmitigated-high risk
is logged, `publishLive({ type: 'project_action', tenant_id, kind, project_code, severity, ... })` on the
existing `BiLiveService`. The action-center page subscribes via `useRealtime` and live-prepends the item.
*Idempotent / best-effort* — the page also polls the aggregator, so a missed event self-heals.

### Web — `/projects/action-center`
A sleek inbox landing (new nav item under `จัดการโครงการ`, icon `CheckCheck`, perms `['exec','planner','ar']`):
severity-grouped cards with a one-line reason, a deep link to the offending project tab (`?tab=`), and a
live "connected" dot from `useRealtime`. Surface the same `summary` badge on the portfolio command center.

### Deliverables (one PR)
- Module: `actionCenter(user)` in `projects.service.ts`; `GET action-center` route; SSE emit on red/risk.
- No migration (read-only); **no new table**.
- Permissions: reuse the existing PPM trio — no new permission key.
- RCM: **PROJ-11** in `build_rcm.py` → regenerate xlsx. Docs: PN-16 step 19 + control-matrix row +
  revision; user-manual `14-project-management.md` (action-center section) + `99-troubleshooting-faq.md`;
  UAT-O2C-221 + traceability. Harness: extend `tools/cutover/src/projects.ts` (seed one of each exception,
  assert kinds/severity/clear-on-resolve, assert SSE buffer via `recent()`).

---

## Phase PMO-2 — Pipeline-weighted forward resource & cash forecast — **DELIVERED**
> Shipped: `GET /api/projects/forecast?months=&from=` (`ProjectsService.forecast`) — committed milestone/POC
> billing + probability-weighted pipeline (`amount × probability%` at expected close) per month + committed
> capacity demand; a billings-forecast band on `/projects/portfolio`. No control, no migration. PN-16 step 20
> / rev 0.22, user-manual 14 rev 1.9, UAT-O2C-222. Harness: `projects` 100 checks. (Pipeline→resource-demand
> effort model deferred — see §out-of-scope.)
*Makes the capacity calendar **forward-looking**: not just committed work, but "if we win the pipeline,
where do we break — and when does the cash land?" Uniquely ties pipeline × capacity × milestone/POC billing.*

### Backend — `GET /api/projects/forecast`
Combine three existing sources into a time-phased forecast (`{ months, from, resourcing, billing }`):

- **Committed demand** — `resourceCapacity()` month buckets (today's assignments vs 100%/month).
- **Pipeline-weighted demand** — from `pipelineSummary()` open opportunities, derive a *probable* staffing
  draw (opportunity amount × stage probability, spread across an expected delivery window using the
  template/role mix or a simple value→effort heuristic), and overlay it on the committed demand so a month
  shows **committed**, **weighted-pipeline**, and **combined** load vs capacity — surfacing the *future*
  over-allocation the lifetime average hides.
- **Billing/cash forecast** — expected billing by month from (a) Fixed-price **milestone** `billing_percent`
  on planned milestone dates, (b) **POC** recognise-to-bill for over-time projects, and (c)
  weighted-pipeline contract value on expected start — i.e. a forward **billings/cash curve**.

Read-only; rides **PROJ-05** (resource governance) / **PROJ-06** (EVM) — *candidate* new control only if we
want the forecast itself attested; default **no new control** (decision flagged for sign-off).

### Web
Extend the **Portfolio command center** (`/projects/portfolio`) with a forecast band: a combined
committed-vs-pipeline capacity heatmap/area (reuse the capacity heatmap component + recharts) and a
billings/cash forecast line. No new page, no new dependency.

### Deliverables (one PR)
- Module: `forecast(user, {months})` in `projects.service.ts`; `GET forecast` route. No migration.
- Docs: PN-16 step 20 (forecast note) + revision; user-manual `14` (portfolio forecast) +
  `09-reports-and-analytics.md`; UAT-O2C-222 + traceability. Harness: seed pipeline opps + milestones +
  a POC project, assert weighted demand and billing months.

---

## Phase PMO-3 — Period governance / status pack — **DELIVERED**
> Shipped: `GET /api/projects/:code/governance-pack` (full per-project pack) + `GET /api/projects/governance-pack`
> (RAG-ranked portfolio roll-up) via `ProjectsService.governancePack`; schedulable BI report type
> `project_governance_pack`; a print-friendly `/projects/:code/status` report page + a Status-report button on
> the workspace. No control, no migration. PN-16 step 21 / rev 0.23, user-manual 14 rev 2.0 + 09, UAT-O2C-223.
> Harness: `projects` 103 checks.
*Kills the recurring PMO time-sink: assembling the status deck. The health snapshots we just shipped are
the raw material for the trend.*

### Backend — governance pack + schedulable report type
- `governancePack(user, {code?, period?})` in `projects.service.ts`: assemble, per project (or portfolio),
  a period status object — **EVM trend** (`healthHistory()` RAG/CPI/SPI series), **baseline variance**
  (`getBaseline()`), **open risks/issues** (`listRisks()`), **milestone status** (`listMilestones()`),
  and the **change-order log** for the period (`listChangeOrders()`).
- `GET /api/projects/:code/governance-pack` and `GET /api/projects/governance-pack` (portfolio).
- **Schedulable:** add `project_governance_pack` to `bi.service.ts` `REPORT_TYPES` (`:37`) + a dispatch case
  (`:501`) delegating to `governancePack(user)`, so the pack can be generated/emailed on a schedule like the
  other action jobs (idempotent per period). Detective/read-only — rides **PROJ-06**; no new control.

### Web
A "สร้างรายงานสถานะ (Status report)" action on the project workspace and portfolio that renders the pack
(EVM trend chart already exists from PPM-4; add the risk/milestone/change-order sections) — print-friendly.

### Deliverables (one PR)
- Module: `governancePack()` + two routes + the BI report type/dispatch. No migration.
- Docs: PN-16 step 21 + revision; user-manual `14` + `09-reports-and-analytics.md` (the new report type);
  UAT-O2C-223 + traceability. Harness: extend `projects.ts` (pack shape) + `bi` (the scheduled report type).

---

## Cross-cutting: discipline, sequencing & verification

- **Sequential, one PR each** (PMO-1 → PMO-2 → PMO-3). They share `projects.service.ts` and the migration
  journal; only PMO-1 *might* not even need a migration (all three are read-only aggregators — confirm at
  build that none needs a table). Use the **next free 4-digit** migration id **only if** a table is actually
  required (none is currently planned).
- **Each PR is "done" only with docs** per the CLAUDE.md sync policy: narrative + (RCM if a control changes)
  + user-manual + UAT + harness, in the same commit; bump the affected revision-history rows.
- **Verify** per PR: `pnpm --filter @ierp/api build`, `pnpm --filter @ierp/web build`, `pnpm -r typecheck`,
  and the relevant cutover harnesses (`projects`, `bi`, `compliance`) green; then the full CI matrix green
  before squash-merge. RCM regenerated via `python3 compliance/build_rcm.py` whenever a control is added
  (PMO-1 adds PROJ-11; PMO-2/PMO-3 add none unless sign-off decides otherwise).

## Follow-on (post-PMO-3, now in flight)
- **PMO-4 — Program (cross-project) critical path — DELIVERED.** `program_code` + `depends_on_projects` on
  `projects` (migration 0200) + `GET /api/projects/program-critical-path?program=` / `programs` /
  `PATCH :code/program`; a CPM over the program graph (nodes = whole projects) → program duration, critical
  chain, per-project slack. Web `/projects/program/:code` + a Programs card on the portfolio. Rides PROJ-06
  (no new control). PN-16 step 22 / rev 0.24, user-manual 14 rev 2.1, UAT-O2C-224. Harness: `projects` 108.
- **PMO-5 — configurable value→FTE forecast extension — DELIVERED.** `GET /api/projects/forecast` now also
  projects resourcing demand: a configurable `rev_per_fte_month` (default ฿200k, overridable per request)
  converts the weighted-pipeline value into an FTE draw → per-month `committed_demand_fte` /
  `pipeline_demand_fte` / `total_demand_fte` + `peak_total_demand_fte`. Web: per-month FTE + a peak badge on
  the portfolio forecast band. Rides PROJ-05/PROJ-06 (no control, no migration). PN-16 step 20 / rev 0.25,
  user-manual 14 rev 2.2, UAT-O2C-225. Harness: `projects` 110.

## Out of scope / parked (unless requested)
- Document/deliverable management, external PM-tool sync.

## Revision history
| Version | Date | Notes |
|---|---|---|
| 0.1 | 2026-06-30 | Initial plan — PMO action center (+SSE), pipeline-weighted forecast, period governance pack. Three sequential doc-synced PRs on the existing PPM spine. |
