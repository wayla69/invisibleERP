# Project Management (PPM)

**Audience:** Project managers, planners, project accountants · **Required role/permission:** any of
`exec` / `planner` / `ar` (the win/loss dashboard also opens for `crm`). · **Process narrative:**
`docs/process-narratives/16-project-accounting.md` · **Design/roadmap:** `docs/19-project-management-ppm-plan.md`.

The Project Management workspace turns the project ledger into a full operational PPM experience —
work breakdown, schedule/Gantt, resourcing, earned value, and a sales win/loss dashboard whose won
deals convert into projects.

## Where to find it
Project Management has its own sidebar group — **จัดการโครงการ (Project Management)** (ERP workspace):
- **Portfolio** — **จัดการโครงการ → พอร์ตโครงการ (Portfolio)** (`/projects/portfolio`) — the PM landing,
  or the **Portfolio** button on the Projects page.
- **Projects** — **จัดการโครงการ → โครงการ (Projects)** (`/projects`).
- **Win/Loss Pipeline** — **จัดการโครงการ → ไปป์ไลน์ Win/Loss** (`/projects/pipeline`), or the
  **Win/Loss** button on the Projects page.

## Portfolio command center (`/projects/portfolio`)
An executive cross-project overview for the PMO / leadership:
- **Health band** — portfolio **CPI** (green ≥ 1, amber ≥ 0.9, red below), **on-track** vs **at-risk**
  project counts (at risk = CPI or SPI < 0.9), and **resources over capacity** (> 100% allocation).
- **Financial band** — total contract, billed, WIP and margin across all projects.
- **Pipeline → delivery funnel** — open opportunities → won → converted-to-project.
- **At-risk projects** — a click-through list of the projects dragging the portfolio; **project health
  table** — CPI/SPI per project with an on-track / at-risk / no-data badge. Click any row to open it.

## Projects register (`/projects`)
The KPI band shows project count, unbilled WIP, cumulative billed, and cumulative margin. The table lists
every project with cost, budget usage (amber ≥ 85%, red ⚠ over budget), billed %, WIP and margin. A
**งานของฉัน (My tasks)** panel lists your still-open tasks across all projects where you are *Accountable* (A)
or *Responsible* (R) — click one to jump to its schedule.
- **Create a project** — fill the form (name, optional code, customer, T&M or Fixed, contract value) → *สร้าง*.
- **Start from a template** — pick a scaffold in *เริ่มจากแม่แบบ* on the create form to spin up a standard WBS +
  milestones in one step (dated from the project start). Templates are reusable; a project that already has
  tasks can't have a template applied (`PROJECT_HAS_TASKS`). Author templates via the projects API
  (`POST /api/projects/templates`).
- **Open a project** — click any row to open its workspace.
- **Quick actions** — the clock (log cost) and receipt (bill) icons on a row open those dialogs without leaving the list.

## Project workspace (`/projects/{code}`)
Tabbed, deep-linkable (`?tab=`):
- **ภาพรวม (Overview)** — % complete, **CPI** (cost) and **SPI** (schedule) health tiles (green ≥ 1, amber
  ≥ 0.9, red below), cumulative margin/WIP; an **S-curve** of planned cost vs the current EV/AC; and the
  full earned-value breakdown (BAC/PV/EV/AC/CV/SV/EAC).
- **กำหนดการ & Gantt (Schedule)** — a dependency-aware **Gantt** with the **critical path** highlighted in
  the primary colour and an inner fill for % complete, plus the WBS table. **เพิ่มงาน** adds a task (hours,
  budget, dates, %, predecessors, and **RACI** — an *Accountable* owner + *Responsible* doers); the check
  icon marks a task done (→ 100%). The **ผู้รับผิดชอบ (RACI)** column shows the accountable owner (an *A* badge,
  or *— ไม่มี A* when the task has no single owner) and the responsible doers.
- **หมุดหมาย (Milestones)** — add milestones; the flag icon marks one **reached**. A milestone with a
  *วางบิล %* raises that Fixed-price progress bill automatically when reached.
- **ทรัพยากร (Resources)** — assign people (the cost/bill rate is pulled from the rate card by role);
  over-allocation across projects is flagged in the capacity report.
- **ความเสี่ยง & ปัญหา (Risks & issues)** — log a **risk** (scored *probability × impact*) or an **issue**
  (scored by impact) with an owner, mitigation plan and due date. Each gets a RAG level (สูง/กลาง/ต่ำ). The KPI
  band highlights **open high risks** and — critically — those that are **high with no mitigation plan**
  (`สูง·ยังไม่มีแผนรับมือ`); the check icon closes an item. Governance control **PROJ-08** surfaces an
  unmitigated high risk for review rather than letting it be buried.
- **ต้นทุน & บิล (Costs & bill)** — the cost-entry ledger with the posting JE, plus *ลงต้นทุน* / *วางบิล* dialogs.
  For a project set to **over-time (POC) revenue recognition**, this tab also shows the % complete (cost-to-cost),
  recognised revenue, and the contract-asset / billings-in-excess position, with a **รับรู้รายได้ (Recognise)**
  button — revenue is earned as work progresses, and *ออกใบแจ้งหนี้ (invoice)* is separate from recognition.

**Revenue recognition (create form).** On *สร้างโครงการ* pick **การรับรู้รายได้**: *เมื่อวางบิล (Billing)* recognises
revenue point-in-time when you bill (default), or *ตามความคืบหน้า (POC)* recognises it over time on a
cost-to-cost basis — POC needs an **estimated total cost (EAC)**, and earned revenue accrues a contract asset
until billed (control PROJ-09).

## Win/Loss pipeline dashboard (`/projects/pipeline`)
Win rate, weighted forecast, won and lost value; a **pipeline-by-stage** funnel; **loss reasons**; a
**monthly win-rate** trend; and a **by-owner** league table with each rep's win rate. A won opportunity can
be converted into a project from the CRM pipeline (control **CRM-WL**).

## Control callouts
- Billing (incl. milestone billing) is segregated from cost initiation (**R07**) and capped at the contract
  value — see the troubleshooting list for `BILL_EXCEEDS_CONTRACT`, `OPP_NOT_WON`, `SOD_SELF_APPROVAL`,
  `BAD_ALLOC`, `BAD_DEPENDENCY`.
- EVM (CPI/SPI) and the critical-path schedule are **detective** signals (**PROJ-06**) — they post nothing.

## Revision history
| Version | Date | Notes |
|---|---|---|
| 1.0 | 2026-06-30 | Initial guide — PPM workspace, Gantt/EVM, win/loss dashboard (PPM roadmap `docs/19`). |
| 1.1 | 2026-06-30 | Project **templates** (`docs/20` B2) — *เริ่มจากแม่แบบ* picker on the create form scaffolds a standard WBS + milestones; `TEMPLATE_EXISTS` / `TEMPLATE_NOT_FOUND` / `PROJECT_HAS_TASKS` added to troubleshooting. |
| 1.2 | 2026-06-30 | **RACI** on tasks (`docs/20` B3) — Accountable/Responsible inputs + RACI column on the schedule; *งานของฉัน (My tasks)* panel on `/projects`. |
| 1.3 | 2026-06-30 | **Risk & issue register** (`docs/20` B4, PROJ-08) — *ความเสี่ยง & ปัญหา* workspace tab with RAG scoring, open-high / unmitigated-high KPIs and close action; `RISK_NOT_FOUND` added to troubleshooting. |
| 1.4 | 2026-06-30 | **POC revenue recognition** (PROJ-09) — *การรับรู้รายได้* picker on create (Billing / POC); Costs tab shows POC %, recognised revenue, contract asset/liability + a *รับรู้รายได้* action; `NOT_POC` / `NO_ESTIMATE` added to troubleshooting. |
