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
- **Capacity calendar** — a time-phased heatmap of each resource's demand by month vs 100%/month capacity;
  a month over 100% (double-booked across projects) shows red, so an over-allocation in a *specific window*
  is visible even when the lifetime average looks fine.
- **Billings/cash forecast** — a forward, month-by-month *พยากรณ์การวางบิล/กระแสเงินสด*: a **มั่นใจ (committed)** band
  (Fixed-price milestone billing on its due date + each POC project's earned-but-unbilled contract asset) overlaid
  with the **ไปป์ไลน์ถ่วงน้ำหนัก (weighted pipeline)** (each open opportunity's value × win probability, at its expected
  close month), with the committed capacity demand % shown alongside — so you can see *"if we win the pipeline,
  when does the cash land, and where are we already over-allocated?"*.

The project workspace **Overview** also carries a **แนวโน้มสุขภาพโครงการ (Health trend)** — capture a dated
CPI/SPI/RAG snapshot with *บันทึกสุขภาพ*, and the chart plots the trajectory over time. Schedule the
*project_health_capture* report (Scheduled reports) to snapshot every project automatically.

## Action Center (`/projects/action-center`)
The PMO **"what needs me now"** inbox — a single, severity-ranked worklist of everything that needs an
approval, a decision, or a fix across **all** your projects, so you don't have to open each project to find
trouble. Reach it from **จัดการโครงการ → ศูนย์งานที่ต้องทำ (Action Center)** or the **ศูนย์งานที่ต้องทำ** button on the
Portfolio page. It surfaces:
- **ด่วน (High)** — projects gone **red** (CPI or SPI < 0.9), **over budget**, and **open high risks with no
  mitigation plan**.
- **ปานกลาง (Medium)** — **change orders** and **project timesheets awaiting approval** (a *different* person
  must approve — maker-checker), **overdue milestones**, and in-flight projects with **no baseline**.
- **ทั่วไป (Low)** — projects whose **health snapshot is stale** (none captured within the window, default 14 days).

Each row deep-links to the offending project tab — click **เปิด** to go straight there and resolve it; once
you do (e.g. a different user approves the change order) the item drops off the list. A **เรียลไทม์ / ออฟไลน์**
badge shows the live connection: when a project drifts red or a high risk is logged with no mitigation, the
inbox updates **instantly** (no refresh needed). Governance control **PROJ-11** — the inbox posts nothing; it
makes the detective signals impossible to miss.

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
Tabbed, deep-linkable (`?tab=`). The header carries a **รายงานสถานะ (Status report)** button that opens a
print-friendly **period governance pack** (`/projects/{code}/status`): the project's RAG, EVM, the CPI/SPI
**health trend**, baseline variance, open high risks, milestone status, and the change-order log — the status
deck assembled for you. (It can also be scheduled portfolio-wide via the `project_governance_pack` report.)
- **ภาพรวม (Overview)** — % complete, **CPI** (cost) and **SPI** (schedule) health tiles (green ≥ 1, amber
  ≥ 0.9, red below), cumulative margin/WIP; an **S-curve** of planned cost vs the current EV/AC; the
  full earned-value breakdown (BAC/PV/EV/AC/CV/SV/EAC); and a **ใบสั่งเปลี่ยนแปลง (Change orders)** panel —
  request a contract/budget variation; a *different* person approves it (maker-checker), which applies the
  change and re-baselines the project.
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
| 1.5 | 2026-06-30 | **Change orders** (PROJ-10) — *ใบสั่งเปลี่ยนแปลง* panel on the project Overview: request a contract/budget variation; a different user approves (maker-checker), applying the change + re-baselining; `EMPTY_CHANGE_ORDER` / `SOD_SELF_APPROVAL` / `CHANGE_ORDER_DECIDED` added to troubleshooting. |
| 1.6 | 2026-06-30 | **Resource capacity calendar** — a time-phased *ปฏิทินกำลังคน* heatmap on the Portfolio command center: per-resource demand vs 100%/month capacity, with over-booked months in red. |
| 1.7 | 2026-06-30 | **Project health history** — a CPI/SPI *แนวโน้มสุขภาพโครงการ* trend on the workspace Overview (*บันทึกสุขภาพ* to capture a dated RAG/EVM snapshot); schedulable via the `project_health_capture` report. |
| 1.8 | 2026-06-30 | **Action Center** (PROJ-11) — a new *ศูนย์งานที่ต้องทำ* PMO inbox (`/projects/action-center`): one severity-ranked worklist of pending approvals, red/over-budget projects, slipping milestones, unmitigated-high risks and governance gaps across the whole portfolio, each deep-linked, with a live (SSE) update when a project goes red or a high risk is logged. Linked from the Portfolio header. |
| 1.9 | 2026-06-30 | **Forward billings/cash forecast** (PMO-2) — a *พยากรณ์การวางบิล/กระแสเงินสด* band on the Portfolio command center: committed milestone/POC billing overlaid with the probability-weighted pipeline (value × win %, at expected close) per month, alongside committed capacity demand — the "if we win the pipeline, when does cash land / where are we over-allocated?" view. |
| 2.0 | 2026-06-30 | **Period governance / status pack** (PMO-3) — a print-friendly *รายงานสถานะ* report (`/projects/{code}/status`, opened from the workspace header): RAG + EVM + CPI/SPI health trend + baseline variance + open high risks + milestone status + change-order log, auto-assembled per period. Schedulable portfolio-wide via the `project_governance_pack` report. |
