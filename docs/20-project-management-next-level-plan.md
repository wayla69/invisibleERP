# 20 — Project Management — Next-Level Design & Roadmap

> **Date:** 2026-06-30 · **Status:** v0.1 DRAFT — PLANNING (no code yet) · **Owner:** ERP / Product
> **Scope:** Take the now-complete PPM suite (`docs/19`, P0–P4 + analytics + web UI + BI reports) to the
> next level across **three tracks** — an executive **Portfolio command center**, deeper **project
> delivery** (baselines, templates, RACI, risk/issue log), and a dedicated **Project Management workspace
> IA** — plus a parked track for **adjacent ERP areas**.
> **Decision recorded:** Same delivery discipline as `docs/19` — each phase is an independently-shippable,
> doc-synced PR (migration + module + permissions/SoD + RCM control + narrative + user-manual + UAT +
> cutover-harness), merged only on a fully green CI matrix.

---

## 0. Read this first

`docs/19` delivered the operational spine: opportunity→project conversion, WBS/tasks/milestones,
resourcing & rate cards, timesheet→labor (maker-checker), dependencies & EVM, a sleek web workspace
(portfolio register, Gantt, EVM S-curve, win/loss dashboard), and two schedulable BI report types.
What it does **not** yet have: an **executive cross-project view**, **change-controlled baselines**, a way
to **start projects from a template**, **risk/issue governance**, and a **dedicated PM information
architecture**. This plan closes those, building on what already exists (`modules/projects`,
`ProjectsService.portfolioEvm`/`schedule`/`evm`/`evmSeries`, `modules/crm-pipeline.winLoss`).

Current state to build on: **RCM 140 controls**; `projects` cutover harness **44 checks**; PN-16 narrative
at **rev 0.11**; UAT through **UAT-O2C-211**.

---

## Track A — Portfolio command center
*An executive, cross-project overview. Highest value, lowest risk — reuses freshly-built data.*

### A1 — Portfolio backend (`GET /api/projects/portfolio`)
- Expose the existing `ProjectsService.portfolioEvm` as a route, **enriched** to one exec payload:
  EVM rollup (BAC/EV/AC/EAC/CPI), **health buckets** (on-track / at-risk / no-data by CPI·SPI < 0.9),
  **status counts**, **financial totals** (contract, billed, WIP, margin, cost-to-date), the **at-risk
  list** (code, name, cpi, spi), a **resource-capacity** summary (reuse `resourceUtilization` —
  over-allocated count), and a **pipeline→delivery funnel** (open → won → converted-to-project, from
  `crm-pipeline` + `projects.crm_opp_no`).
- Read-only; rides **PROJ-06** (EVM) / **REV-17** (pipeline). No migration, no new control.
- Harness: extend `tools/cutover/src/projects.ts` (totals/health/at-risk shape). Docs: PN-16 §11 note.

### A2 — Portfolio command center page (`/projects/portfolio`)
- Sleek exec dashboard (existing design system): a **health command band** (portfolio CPI with tone, at-risk
  vs on-track counts, total WIP/margin/contract), an **at-risk projects** strip (chips → project detail),
  a **CPI/SPI scatter** or health bars, a **capacity** mini-heatmap, and the **pipeline→delivery funnel**.
- Nav: add under Planning (or the new PM group from Track C). Reuse recharts; no new dependency.
- Docs: user-manual `14-project-management.md` (portfolio section); UAT case.

---

## Track B — Deepen project delivery
*Per-project depth that maturing PMOs expect. Each sub-phase is its own PR.*

### B1 — Baselines & schedule/cost variance (control **PROJ-07**)
- New `project_baselines` table (snapshot of tasks' planned cost/dates + BAC at a point in time) + a
  `POST /api/projects/:code/baseline` (snapshot) and EVM/schedule compared **against the baseline**
  (baseline variance %, not just current plan). **Change-controlled:** re-baselining is an authorized,
  audited act (maker-checker or DoA) so a project can't silently move its goalposts — new control
  **PROJ-07** (baseline change governance).
- Migration (next free 4-digit); RCM PROJ-07 + regenerate xlsx; narrative + UAT + harness.

### B2 — Project templates (WBS/milestone scaffolds) — DELIVERED
- `project_templates` (+ `project_template_items`, migration 0189) and `POST /api/projects/:code/apply-template/:tpl`
  (+ `POST/GET /api/projects/templates[/:tpl]`) to spin a **standard WBS + milestones** in one step. Items
  carry relative date offsets, planned effort/cost, WBS nesting (`parent_seq`) and dependencies
  (`depends_on_seq`) keyed by in-template `seq`. Operational; no new control. Web: a "from template" picker
  on the create form. Narrative PN-16 step 13; UAT-O2C-214; harness `tools/cutover/src/projects.ts`.

### B3 — RACI & people assignment on tasks — DELIVERED
- `project_tasks` extended (migration 0190) with the four **RACI** roles — `accountable` (single owner),
  `responsible`/`consulted`/`informed` (CSV). `GET /api/projects/:code/raci` is the accountability matrix
  (per-task A/R/C/I, per-person rollup, `missing_accountable` gaps); `GET /api/projects/my-tasks` is each
  user's open A/R queue across projects. Operational; SoD note (accountable ≠ cost/timesheet approver → rides
  PROJ-04). Web: RACI column + Accountable/Responsible inputs on the task form, *งานของฉัน* panel on
  `/projects`. Narrative PN-16 step 14; UAT-O2C-215; harness `tools/cutover/src/projects.ts`.

### B4 — Risk & issue log (control **PROJ-08**)
- `project_risks` / `project_issues` (RAG status, owner, probability·impact score, mitigation, due date,
  open/closed) with CRUD + a project **risk register** tab and a portfolio **top-risks** roll-up (Track A).
  Detective governance control **PROJ-08** (open high risks reviewed at close; an unmitigated high risk is
  surfaced, not buried).
- Migration; RCM PROJ-08 + regenerate; narrative + UAT + harness; web (Risks/Issues tab).

---

## Track C — Project Management workspace IA
*A dedicated home, per `docs/19` §10.*

### C1 — PM nav group + landing page
- Restructure nav (`apps/web/src/lib/nav.ts`) into a **Project Management** group with collapsible
  subgroups (Pipeline · Projects · Schedule · Resources · Analytics/Portfolio), **URL-stable** per the
  §15 IA convention (no `href` changes — only grouping/labels). A PM **landing page** (`/projects`
  becomes the portfolio overview; the register moves to a clear tab/section).
- Web-only; e2e smoke must stay green (additive grouping). Docs: user-manual + `docs/15`/`19` IA note.

---

## Track D — Adjacent ERP areas *(parked — plan separately on request)*
Out of scope here; candidates to scope as their own roadmap when PPM is saturated: finance **close
automation** (checklist orchestration + the existing scheduler jobs), **procurement** depth,
**manufacturing** (MRP/scheduling), and a cross-module **analytics** workspace. Listed so the backlog is
explicit; **not** part of this plan's execution.

---

## Suggested delivery order
1. **A1 → A2** (portfolio command center) — fast, visible, reuses merged data.
2. **C1** (PM workspace IA) — gives everything a home; do before/with A2 so the portfolio lands in the new group.
3. **B1 → B4** (delivery depth) — sequential; B1 (baselines) and B4 (risk/issue) add controls **PROJ-07/08**.

Each is one PR (B-track may be one PR per sub-phase). New controls: **PROJ-07** (baseline governance),
**PROJ-08** (risk register) → RCM would reach **142**. No phase blocks another except the order above.

## Verification (per phase)
- Local: `pnpm -r typecheck`, `pnpm --filter @ierp/api build`, `pnpm --filter @ierp/web build` (UI phases),
  the `projects` cutover harness extended + green, `migrations-journaled` gate clean, and no regression in
  adjacent harnesses (`bi`/`crm`/`compliance`/`hcm` as touched).
- CI: full 88-check matrix green before merge; docs reconciled per the CLAUDE.md documentation-sync policy.

## Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-30 | ERP / Product | Initial next-level roadmap — Portfolio, delivery depth (baselines/templates/RACI/risk), PM workspace IA. No code yet. |
