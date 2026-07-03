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
- **Leads & Opportunities** — **จัดการโครงการ → ลีด & โอกาสการขาย** (`/projects/crm`) — manage the CRM
  sales pipeline and convert a won deal into a project.
- **Project Period Close** — **จัดการโครงการ → ปิดงวดโครงการ** (`/projects/close`) — exec-only period-end
  WIP/clearing review + maker-checker sign-off (PROJ-03).
- **Templates & Rate Cards** — **จัดการโครงการ → แม่แบบ & อัตราค่าแรง** (`/projects/settings`) — author WBS
  templates, maintain role rate cards, and see cross-project resource utilization.

## Portfolio command center (`/projects/portfolio`)
An executive cross-project overview for the PMO / leadership:
- **Health band** — portfolio **CPI** (green ≥ 1, amber ≥ 0.9, red below), **on-track** vs **at-risk**
  project counts (at risk = CPI or SPI < 0.9), and **resources over capacity** (> 100% allocation).
- **Financial band** — total contract, billed, WIP and margin across all projects.
- **Pipeline → delivery funnel** — open opportunities → won → converted-to-project.
- **At-risk projects** — a click-through list of the projects dragging the portfolio; **project health
  table** — CPI/SPI per project with an on-track / at-risk / no-data badge. Click any row to open it.
- **Top risks (PROJ-08)** — a *ความเสี่ยงสูงสุดทั้งพอร์ต* card ranks the open risks/issues across every project by
  score, flagging high risks with no mitigation plan; click a row to jump to that project's risk tab.
- **Capacity calendar** — a time-phased heatmap of each resource's demand by month vs 100%/month capacity;
  a month over 100% (double-booked across projects) shows red, so an over-allocation in a *specific window*
  is visible even when the lifetime average looks fine.
- **Billings/cash forecast** — a forward, month-by-month *พยากรณ์การวางบิล/กระแสเงินสด*: a **มั่นใจ (committed)** band
  (Fixed-price milestone billing on its due date + each POC project's earned-but-unbilled contract asset) overlaid
  with the **ไปป์ไลน์ถ่วงน้ำหนัก (weighted pipeline)** (each open opportunity's value × win probability, at its expected
  close month). Each month also shows the projected **กำลังคน (FTE)** demand — your *committed* allocation plus the
  pipeline's projected staffing draw (the weighted pipeline value ÷ a configurable *revenue-per-FTE-month* rate,
  default ฿200,000) — with a peak-FTE badge, so you can see *"if we win the pipeline, when does cash land, and how
  many people would each month need?"*.

- **Programs** — when projects are grouped into a **program** (cross-project delivery), a *โปรแกรม (Programs)*
  card lists each program with its member count, total duration, and how many projects sit on the **program
  critical path**. Click one to open its **cross-project critical-path** view (`/projects/program/{code}`) —
  a timeline of the member projects (each row is a whole project, sized by its own critical-path duration) with
  the program critical chain highlighted and per-project slack, so a slip that ripples *across* projects is
  visible. Program membership + dependencies are set on the project workspace **กำกับดูแล (Governance)** tab
  (or via `PATCH /api/projects/{code}/program`).

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
  tasks can't have a template applied (`PROJECT_HAS_TASKS`). Author templates on the **แม่แบบ & อัตราค่าแรง**
  page (`/projects/settings`).
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
- **กำกับดูแล (Governance)** — three governance controls in one tab:
  - **เส้นฐาน (Baseline, PROJ-07)** — capture a change-controlled baseline of the approved BAC + critical-path
    duration; the tiles then show **scope/cost creep** (current vs baseline BAC + duration delta). Re-baselining
    requires a reason (`BASELINE_REASON_REQUIRED`); prior baselines are kept as history.
  - **เมทริกซ์ RACI (B3)** — the per-person accountability rollup (A/R/C/I counts) with a **missing-Accountable**
    gap warning, so a task with no single owner is caught.
  - **โปรแกรม (Program, PMO-4)** — set this project's **program** and the projects it must follow
    (finish-to-start), feeding the program critical-path view.
- **BoQ (Bill of Quantities)** — the project's **material/works budget baseline** (for construction/contractor
  work). Add rate-built lines (จำนวน × ราคาต่อหน่วย = งบรายการ), tagged by category (วัสดุ/ค่าแรง/รับเหมาช่วง/อื่นๆ)
  and optionally linked to an item and a WBS task. A BoQ is authored as a **draft**, then **approved by a
  *different* person** (maker-checker) — approval **syncs the project budget** to the BoQ total (the limit that
  requisitions draw against). An approved BoQ can be **locked** (frozen); before locking you can **re-measure**
  a line (record the actual measured quantity vs the budgeted one). See the BoQ section below.
- **ต้นทุน & บิล (Costs & bill)** — the cost-entry ledger with the posting JE, plus *ลงต้นทุน* / *วางบิล* dialogs.
  For a project set to **over-time (POC) revenue recognition**, this tab also shows the % complete (cost-to-cost),
  recognised revenue, and the contract-asset / billings-in-excess position, with a **รับรู้รายได้ (Recognise)**
  button — revenue is earned as work progresses, and *ออกใบแจ้งหนี้ (invoice)* is separate from recognition.

**Revenue recognition (create form).** On *สร้างโครงการ* pick **การรับรู้รายได้**: *เมื่อวางบิล (Billing)* recognises
revenue point-in-time when you bill (default), or *ตามความคืบหน้า (POC)* recognises it over time on a
cost-to-cost basis — POC needs an **estimated total cost (EAC)**, and earned revenue accrues a contract asset
until billed (control PROJ-09).

## Leads & Opportunities (`/projects/crm`)
The working CRM sales pipeline (control **REV-17**), two tabs:
- **โอกาสการขาย (Opportunities)** — a KPI band (open value, weighted forecast, won value, win rate), an *add
  opportunity* form, and a table where the **stage** dropdown walks each deal through the machine
  (prospecting → qualification → proposal → negotiation → won/lost; *won*/*lost* are terminal). A deal moved to
  **won** shows a **เป็นโครงการ (convert to project)** button — it seeds a project's contract from the deal value
  (control **CRM-WL**) and jumps to the new workspace. Converting the same deal twice is idempotent.
- **ลีด (Leads)** — add a lead, **คัดกรอง (qualify)** it, **แปลงเป็นโอกาสการขาย (convert)** it into an opportunity
  (creating a customer-of-record), or mark it **ปิด/เสีย (lost)**.

## Win/Loss pipeline dashboard (`/projects/pipeline`)
Win rate, weighted forecast, won and lost value; a **pipeline-by-stage** funnel; **loss reasons**; a
**monthly win-rate** trend; and a **by-owner** league table with each rep's win rate. Manage the underlying
leads/opportunities on **ลีด & โอกาสการขาย** (`/projects/crm`); convert a won deal into a project there (**CRM-WL**).

## Project period close (`/projects/close`) — exec only
The period-end **WIP/clearing close review** with maker-checker sign-off (control **PROJ-03**):
1. Pick a **งวด (YYYY-MM)** and press **จัดทำการสอบทาน** — this snapshots the period's total WIP, the clearing
   balance (should be 0 when everything is billed/relieved), and the open-project count, status **Prepared**.
2. A **different** user (approver ≠ preparer, `SOD_VIOLATION` otherwise) presses **อนุมัติ** to sign off, or
   **ปฏิเสธ** with a reason.
The page also shows the **PMO-3 portfolio governance roll-up** for the chosen period — each project's RAG, CPI/SPI,
WIP, open high risks, overdue milestones, and pending change orders (click a row for its status pack) — plus a
history table of every prior close.

## Templates & rate cards (`/projects/settings`)
PMO configuration, three tabs:
- **อัตราค่าแรง (Rate cards, PROJ-05)** — maintain effective-dated cost/bill rates per **role**; when you assign a
  person to a project the applicable rate is pulled automatically.
- **แม่แบบ WBS (B2)** — the **template builder**: name the template and add task/milestone rows (planned hours/cost,
  start/end day offsets from the project start, and a billing % for milestones), then *สร้างแม่แบบ*. It then appears
  in the *เริ่มจากแม่แบบ* picker on the Projects create form.
- **การใช้กำลังคน (Utilization)** — the cross-project allocation rollup per resource, flagging anyone booked
  **over 100%**.

## Timesheets → project labour (`/hcm`, tab ลงเวลา / OT)
When logging a timesheet you can allocate it to a **โครงการ (project)** and a **งาน (WBS task)** and mark it
**billable**. The entry lands **Pending**; a **different** approver presses **อนุมัติ** (maker-checker,
`SOD_SELF_APPROVAL` otherwise) — a billable, project-allocated timesheet then posts its labour cost into project
WIP once, via the authorized cost path (control **PROJ-04**). The table shows each row's project, billable flag,
status, and — once approved — the posting JE number.

## Bill of Quantities (BoQ) — material/works budget (docs/32, M0)
The **BoQ** turns a project budget from a single number into an itemised, rate-built schedule you can track
material against.

1. **Create** — on the project workspace **BoQ** tab, *สร้าง BoQ* with lines: description, unit (UoM), budget
   quantity, and rate. The line budget (`งบรายการ = จำนวน × ราคาต่อหน่วย`) and the BoQ total compute automatically.
   Tag each line by category and, for a material line, pick the stock item and the WBS task it belongs to.
2. **Edit while draft** — add lines to a **draft** BoQ (*เพิ่มรายการ*). Once approved, lines are frozen
   (`BOQ_NOT_DRAFT`).
3. **Approve (maker-checker)** — a **different** person approves it (you cannot approve a BoQ you authored —
   *แบ่งแยกหน้าที่*). On approval the **project's budget is set to the BoQ total** — this is the material budget
   that requisitions and POs are checked against (enforced from M1 onward).
4. **Lock** — freeze an approved BoQ as the definitive baseline of record.
5. **Re-measure** — before locking, record the **actual measured quantity** on a line; the variance vs the
   budgeted quantity is shown. Re-measuring a locked BoQ is refused (`BOQ_LOCKED`).

**Raising material against a project.** A purchase requisition or PO can carry a **project** (and a specific
**BoQ line**) so material spend is traceable to the project's budget — pick the project on the requisition/PO;
an unknown project code is rejected (`PROJECT_NOT_FOUND`). A goods receipt inherits the PO's project.

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
| 2.1 | 2026-06-30 | **Program (cross-project) critical path** (PMO-4) — group projects into a *program* (`program_code`) with cross-project finish-to-start dependencies; the new `/projects/program/{code}` view runs a CPM over the program (each row a whole project) and highlights the program critical chain + per-project slack. A *โปรแกรม (Programs)* card on the Portfolio command center lists them. |
| 2.2 | 2026-06-30 | **Pipeline → FTE forecast** (PMO-5) — the Portfolio billings forecast now also projects **กำลังคน (FTE)** demand per month: committed allocation + the pipeline's projected staffing draw (weighted value ÷ a configurable revenue-per-FTE-month rate), with a peak-FTE badge — "if we win the pipeline, how many people would each month need?". |
| 2.4 | 2026-07-03 | **Bill of Quantities (BoQ)** (docs/32, M0) — a **BoQ** tab on the project workspace: rate-built material/works budget lines (จำนวน × ราคา = งบรายการ), draft → maker-checker approve (which **syncs the project budget** to the BoQ total) → lock, with per-line **re-measurement**. Purchase requisitions/POs can be raised **against a project + BoQ line** (unknown project → rejected); a goods receipt inherits the PO's project. Structure/traceability only in M0 — budget enforcement arrives with the commitment ledger (M1). |
| 2.3 | 2026-07-01 | **UI coverage build** — screens for previously headless endpoints: **ปิดงวดโครงการ** (`/projects/close`, PROJ-03 close review + maker-checker + PMO-3 period roll-up); **ลีด & โอกาสการขาย** (`/projects/crm`, REV-17 lead/opportunity management + convert-won-deal-to-project CRM-WL); **แม่แบบ & อัตราค่าแรง** (`/projects/settings`, PROJ-05 rate cards, B2 template builder, cross-project utilization); a **กำกับดูแล (Governance)** workspace tab (PROJ-07 baseline capture + variance, B3 RACI matrix, PMO-4 program membership); a **top-risks** card on the Portfolio (PROJ-08); and project/task allocation + maker-checker approval on the **`/hcm` timesheet** screen (PROJ-04). |
