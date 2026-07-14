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
  full earned-value breakdown (BAC/PV/EV/AC/CV/SV/EAC) with a **กำหนดการที่ได้รับ (Earned schedule)** block
  underneath — **ES** (the date the plan said you'd be where you are), **AT** (months actually elapsed),
  **SV(t)**, an **SPI(t)** badge (green ≥ 1, grey ≥ 0.9, red below) and a forecast finish month. Trust SPI(t)
  late in a project: the classic SPI drifts back to 1 as the plan runs out, while SPI(t) keeps telling the
  truth (a red SPI(t) also raises a *schedule_slip_es* item on the Action Center); it needs tasks with
  planned cost + due dates, otherwise the block explains what's missing. And a **ใบสั่งเปลี่ยนแปลง (Change
  orders)** panel — request a contract/budget variation; a *different* person approves it (maker-checker),
  which applies the change and re-baselines the project.
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
  a line (record the actual measured quantity vs the budgeted one). Each line shows its **งบ / ผูกพัน / คงเหลือ**
  (budget / committed / remaining) so you see the draw against every line at a glance. See the BoQ section below.
- **ขอเบิกวัสดุ (Material requisitions, PROJ-13)** — raise a **PMR** against a BoQ line (*ขอเบิกวัสดุ*): within
  budget it auto-routes to a project-tagged **PR** (or an on-hand **stock issue**), over budget it parks pending
  and pushes a one-tap **LINE** approval to the authoriser; a *different* person approves/rejects the pending
  ones here (maker-checker). The KPI band shows open/consumed commitments and the pending count. Site staff can
  also raise these from a friendly shop — the **Shop for this project** button (top of the workspace) opens a
  Grab/Shopee-style shop restricted to this project's approved-budget items.
- **ขอเพิ่มวัสดุเข้างบ (Material scope-change requests, PROJ-15)** — a requester can only shop items that are
  already in the approved BoQ; when they need something **not** in the budget they *request* it from the
  project shop (item, qty, expected price). The request is parked **pending** and adds nothing until an
  **authorised person (planner/exec, ≠ the requester)** approves it — approval **appends a new line to the
  approved BoQ and grows the project budget**, so the item becomes shoppable and commitment-enforced. This is
  the only way to enlarge a project's material budget: a requester proposes, an authoriser approves. Approvers
  can approve/reject inline on the project-shop page.
- **จองสต๊อก (Stock reservations, INV-13)** — reserve on-hand stock to the project (the dialog shows
  **available-to-issue** = on-hand − held for the item/warehouse), then **issue-to-project** (moves value into
  project WIP) or **release** a held reservation.
- **เงินสดหน้างาน (Site cash, PROJ-14)** — the **advances**, **expense reimbursements** and **petty cash**
  raised against this project, with the site-cash total — so project cash is managed on the project. You can
  **raise cash straight from this tab**: *ออกเงินทดรอง* issues a project-tagged **advance**, and *ขอเงินสดย่อย*
  files a **petty-cash request** (pick the fund; it routes to maker-checker approval). Either can be **linked to
  a BoQ line**, so when it settles/approves it **consumes that line's budget** (FU1) — material and site cash
  sit under one ceiling.
- **ต้นทุน & บิล (Costs & bill)** — the cost-entry ledger with the posting JE, plus *ลงต้นทุน* / *วางบิล* dialogs.
  For a project set to **over-time (POC) revenue recognition**, this tab also shows the % complete (cost-to-cost),
  recognised revenue, and the contract-asset / billings-in-excess position, with a **รับรู้รายได้ (Recognise)**
  button — revenue is earned as work progresses, and *ออกใบแจ้งหนี้ (invoice)* is separate from recognition.

**Revenue recognition (create form).** On *สร้างโครงการ* pick **การรับรู้รายได้**: *เมื่อวางบิล (Billing)* recognises
revenue point-in-time when you bill (default), or *ตามความคืบหน้า (POC)* recognises it over time on a
cost-to-cost basis — POC needs an **estimated total cost (EAC)**, and earned revenue accrues a contract asset
until billed (control PROJ-09).

## Leads & Opportunities → the CRM workspace (`/crm`; CRM-2)
The working CRM sales pipeline (control **REV-17**) now lives in the unified **CRM workspace** — see manual
**[16 — CRM Workspace](./16-crm-workspace.md)**. The old addresses keep working: `/projects/crm` and
`/pipeline` forward to `/crm` automatically. Everything this section used to describe is there, upgraded:
a drag-and-drop **deal board** (stages as columns, age-in-stage on every card), the **leads** tab
(qualify / convert / lose + a CSV/Excel import wizard + website web-to-lead capture), and a **deal page**
(`/crm/deals/{OPP-…}`) whose timeline shows every activity, stage change and linked quotation. A **won**
deal's **เป็นโครงการ (convert to project)** button (control **CRM-WL**) is on that deal page; it still seeds
the project contract from the deal value and jumps to the project workspace (idempotent on re-convert).
*Won/lost stay terminal everywhere* (`OPP_CLOSED`) and every stage change is recorded in the per-deal audit
trail (`GET /api/crm/pipeline/opportunities/{OPP-…}/history`).

## CRM accounts & contacts — duplicate governance (CRM-1/CRM-2)
The CRM party model behind the pipeline — now with a full web surface in the workspace (`/crm?tab=accounts`,
`/crm?tab=contacts`, account page `/crm/accounts/{ACC-…}`; manual 16 §16.4). The API:
- **บัญชีลูกค้า (Accounts)** — `POST/GET /api/crm/accounts`, `GET/PATCH /api/crm/accounts/{ACC-…}` (perms
  `crm`/`exec`/`ar`): the company record (name, เลขผู้เสียภาษี, industry, size, a real owner user, and a
  `customer_no` link — an account becomes the customer-of-record once it transacts).
- **ผู้ติดต่อ (Contacts)** — `POST/GET /api/crm/contacts`, `PATCH /api/crm/contacts/{id}`: people under an
  account with a role tag (decision_maker / billing / technical / other), optional LINE id and a loyalty
  member link.
- **กันข้อมูลซ้ำ (duplicate detection)** — creating an account/contact that matches an existing record on the
  normalized tax id / email / phone / company name (legal suffixes like "จำกัด"/"Co., Ltd." are ignored) is
  refused **409 `DUPLICATE_SUSPECT`**; the response lists the suspected matches (`error.details.matches`).
  After reviewing, resubmit with `force: true` only if it genuinely is a different party.
- **รวมรายการซ้ำ (merge)** — `POST /api/crm/accounts/{survivor}/merge {duplicate_account_no}` (perms
  `crm`/`exec`/`masterdata`) moves the duplicate's contacts and deals onto the survivor, fills the survivor's
  blank fields from the duplicate, and retires the duplicate (status `merged`, fully traceable — nothing is
  deleted). **Maker-checker:** if the duplicate has contacts/deals to move, the person who created the
  duplicate cannot perform the merge (403 `SOD_VIOLATION`) — a second person must.

## Win/Loss pipeline dashboard (`/projects/pipeline`)
Win rate, weighted forecast, won and lost value; a **pipeline-by-stage** funnel; **loss reasons**; a
**monthly win-rate** trend; and a **by-owner** league table with each rep's win rate. Manage the underlying
leads/opportunities in the **CRM workspace** (`/crm` — manual 16); convert a won deal into a project from its
deal page (**CRM-WL**).

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

## Resource capacity heatmap & role/skill supply-vs-demand (`/projects/resources`, PROJ-20)
A dedicated workspace deepening the settings-page utilization roll-up and the portfolio heatmap:
- **ปฏิทินกำลังคน (Heatmap)** — the same time-phased capacity heatmap as the portfolio card, but now each
  cell's over-allocation is checked against the resource's **real** availability (see below) instead of a flat
  100% assumption, and each resource is tagged **ระบุตัวบุคคล (Named)** or **ยังไม่ระบุตัวบุคคล (Generic)** — a
  generic booking has no matching skill tag (e.g. "Senior Dev TBD"), so you can see at a glance which bookings
  are placeholders.
- **ทักษะ (Skills)** — tag a real person with a skill/role (optionally a proficiency level). This is what makes
  a booking **named** and is the supply side of the role/skill roll-up below.
- **ปฏิทินความพร้อม (Availability calendar)** — set a person's availability for a specific month (e.g. 50% for a
  documented part-time month, or a PTO/leave month) — every resource defaults to 100% until you set one.
- **อุปสงค์-อุปทานตามบทบาท (Role supply-vs-demand)** — per role/skill, per month: assigned **demand** vs qualified
  **supply** (every named person tagged with that skill, at their calendar availability); a role is flagged
  **กำลังคนไม่พอ (Understaffed)** when demand exceeds supply — surfaced before it becomes a schedule slip.

Required role/permission: same as the rest of PPM (`exec`/`planner`/`ar`). Read-only detective surface —
posts nothing to the GL.

## Richer scheduling — dependency types, constraints, working calendar (PROJ-21)
The project schedule (`/projects/[code]`, Gantt/critical-path tab) is no longer finish-to-start-only:
- **Dependency type & lag** — when editing a task's predecessors (the **ลิงก์งานก่อนหน้า (dependencies)**
  icon on each task row), pick per-predecessor whether it's **FS** (finish-to-start), **SS** (start-to-start),
  **FF** (finish-to-finish), or **SF** (start-to-finish), and a **lag** in days (a negative lag is a **lead** —
  the successor may start/finish early). A predecessor with no type/lag set behaves exactly as before
  (FS, 0 lag). The task table shows the effective type/lag next to each predecessor id (e.g. "#3 (SS+2d)").
- **Constraints** — a task can carry **SNET** (start no earlier than) or **FNLT** (finish no later than) with
  a day-offset, independent of its predecessors — useful for a hard site-access date or a contractual
  deadline. Leave it unset for a task whose date is driven purely by its dependencies.
- **ปฏิทินการทำงาน (Working calendar)** — a new tab on `/projects/settings`. Off by default (a task's
  duration counts raw calendar days, as before). Turn it **on** to count only **working days**: pick which
  weekdays are non-working (default เสาร์-อาทิตย์) and add specific **วันหยุด (holiday exceptions)** — every
  dated task's duration then excludes those days.

Required role/permission: same as the rest of PPM (`exec`/`planner`/`ar`). No change to who may create/edit a
task; the calendar tab is on the same settings page as rate cards/templates/utilization.

## Bottom-up cost-to-complete (ETC) vs the formulaic EAC (PROJ-22)
The project overview's EVM card (**ประมาณการต้นทุนคงเหลือ (ETC) เทียบกับ EAC**, beside the earned-schedule
block) now shows TWO completion estimates side by side:
- **ตามสูตร (Formulaic)** — the existing CPI-based estimate (`ac + (bac−ev)/cpi`), unchanged.
- **ประมาณการจากหน้างาน (Bottom-up)** — a manual estimate management enters directly, when one exists; a
  **ส่วนต่าง EAC (EAC variance)** badge highlights how far the two disagree.

**Submitting an estimate** — pick a **งาน (task)** from the dropdown (or leave it as **ระดับโครงการ
(project-level)** for one figure covering all remaining work), enter the **ต้นทุนคงเหลือโดยประมาณ (estimate
to complete)** and an optional note, then **บันทึกประมาณการ**. Submitting again for the **same** task
**replaces** the earlier figure (only the latest counts) — it does not add a second entry. A project-level
entry and per-task entries **add together** into one bottom-up total; the entries list shows exactly what is
currently contributing.

With no estimate submitted yet, the bottom-up side reads **"ยังไม่มีประมาณการจากหน้างาน"** and only the
formulaic EAC is shown — nothing about the existing EVM numbers changes.

Required role/permission: same as the rest of PPM (`exec`/`planner`/`ar`). Detective — the comparison posts
nothing to the GL.

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

**Material requisition (PMR) — the draw-and-approve flow (docs/32, M2).** Staff request material against BoQ
lines via `POST /api/pmr` (project + line + qty + unit cost). The system checks each line's **remaining
budget**:
- **Within budget** → the requisition is *routed*. If the material is **already on hand** it is **reserved and
  issued straight to the project** from stock (no purchase needed); otherwise a **project-tagged purchase
  requisition (PR)** is raised for procurement to buy (docs/32 FU2).
- **Over budget** → the requisition is **held for approval** and a **LINE approval card** (อนุมัติ / ปฏิเสธ) is
  pushed to the authoriser(s). The authoriser (≠ the requester) approves — from the app or **one-tap in LINE** —
  and an **over-budget project PO is auto-drafted** (status *Draft*) for procurement to complete the purchase.
  Rejecting draws nothing. Pending over-budget requisitions also appear on the **Action Center**.

**Budget enforcement (docs/32, M1).** Once a BoQ is approved, a project **PO** tagged to a BoQ line
**reserves (encumbers)** that line's budget. A PO that would push the line past its budget is **blocked**
(`เกินงบรายการ BoQ` / `BUDGET_EXCEEDED`) — the order is not created — so staff cannot commit more material than
the line allows, and two orders raised at the same time can't jointly overrun (the check is atomic). The BoQ
tab shows each line's **budget / committed / remaining**; **cancelling** a PO frees its reservation, and
**receiving** it in full turns the reservation into actual spend. The full ledger is at
`GET /api/projects/{code}/commitments` (open / consumed / released).

**Tolerance & site cash (docs/32, FU1).** A project can set an **over-budget tolerance %**
(`budget_tolerance_pct` on *สร้างโครงการ*): a draw may exceed a BoQ line by up to that % of the line budget
before it's blocked or routed to the over-budget approval (0 = strict). And **site cash counts against the
budget**: an advance or petty-cash raised against a **BoQ line** (`boq_line_id`) **consumes** that line's
remaining — so material + site cash share one ceiling.

## Reserving stock for a project (docs/32, M3)
When the material is **already in the warehouse**, staff reserve it for the project instead of buying:
- **Check availability** — `GET /api/reservations/available?item_id=…` shows **on hand / held / available**
  (available = on hand − what's already reserved).
- **Reserve** — `POST /api/reservations` holds a quantity for the project. Two people can't reserve the same
  stock twice: a reservation that exceeds what's available is rejected (`INSUFFICIENT_STOCK`).
- **Issue to the project** — `POST /api/reservations/{id}/issue` moves the reserved stock **out of inventory
  and into the project's cost (WIP)** at its stock cost (Dr project WIP 1260 / Cr Inventory 1200), and books
  it against the BoQ line. **Release** (`…/{id}/release`) frees a reservation you no longer need.

## Site cash on the project — advances & reimbursements (docs/32, M4)
Cash spent at site can be booked **against the project** so it shows up in the project's cost:
- **Advances** (`POST /api/finance/advances` with `project_code`), **reimbursement claims**
  (`ess.submitExpense` with `project_code`) and **petty-cash** (`POST /api/petty-cash/requests` with
  `project_code`) all accept a project — an unknown code is rejected (`PROJECT_NOT_FOUND`). The expense/advance
  posts to the ledger **tagged with the project**.
- **See it on the project** — `GET /api/projects/{code}/site-cash` lists every advance, reimbursement and
  petty-cash request raised against the project, with per-category and grand totals.

## Control callouts
- Billing (incl. milestone billing) is segregated from cost initiation (**R07**) and capped at the contract
  value — see the troubleshooting list for `BILL_EXCEEDS_CONTRACT`, `OPP_NOT_WON`, `SOD_SELF_APPROVAL`,
  `BAD_ALLOC`, `BAD_DEPENDENCY`.
- EVM (CPI/SPI) and the critical-path schedule are **detective** signals (**PROJ-06**) — they post nothing.
- **Earned schedule** (SPI(t)/SV(t), the Overview block + `schedule_slip_es` Action-Center item) is the
  time-based schedule check (**PROJ-19**) — read-only, it flags slips the classic SPI stops seeing late in a
  project.
- The **resource capacity heatmap** now checks over-allocation against each person's real availability
  calendar (not a flat 100%), and **role/skill supply-vs-demand** (**PROJ-20**) flags an understaffed role
  before it slips a schedule — both are read-only detective surfaces, they post nothing.
- **Dependency type/lag, SNET/FNLT constraints and the opt-in working calendar** (**PROJ-21**) make the
  critical-path schedule (**PROJ-06**) match how work is actually planned — a self-dependency is rejected
  (`BAD_DEPENDENCY`); still read-only/detective, posts nothing.
- A manual **bottom-up cost-to-complete (ETC)** entry, compared against the formulaic EAC (**PROJ-22**),
  surfaces a material divergence between management's ground-level estimate and the CPI-driven number for
  review — read-only/detective, the comparison posts nothing; a `task_id` off the project is rejected
  (`TASK_NOT_FOUND`).

## Revision history
| Version | Date | Notes |
|---|---|---|
| 2.29 | 2026-07-13 | **PROJ-22 — bottom-up cost-to-complete (ETC) vs the formulaic EAC.** The project overview's EVM card gains an **ETC/EAC comparison** panel: submit a manual estimate-to-complete per task (or project-level) and see it side by side with the existing CPI-based EAC, with a variance badge. A second submission for the same task supersedes the first; a project-level entry sums alongside per-task entries. No change to the existing EVM/schedule figures when no estimate has been submitted. |
| 2.28 | 2026-07-13 | **PROJ-21 — richer scheduling: dependency types/lag, SNET/FNLT constraints, opt-in working calendar.** The task dialog and a new dependency-editor dialog (per-predecessor **type** — FS/SS/FF/SF — and **lag/lead days**) on `/projects/[code]`; new per-task **constraint** fields (SNET/FNLT + day-offset); a new **ปฏิทินการทำงาน (Working calendar)** tab on `/projects/settings` (enable + non-working weekdays + holiday exceptions, off by default). The schedule/critical-path computation now honours all four dependency types and the constraints, and — once the calendar is enabled — counts only working days toward a dated task's duration. No change when none of the new fields are set. |
| 2.27 | 2026-07-13 | **PROJ-20 — resource capacity heatmap governed by a real availability calendar + role/skill supply-vs-demand.** New page **`/projects/resources`** (four tabs): the **Heatmap** now flags over-allocation against each resource's TRUE monthly availability (a documented part-time/leave override, default 100% absent one) instead of a flat 100%, and tags each booking **ระบุตัวบุคคล (Named)** or **ยังไม่ระบุตัวบุคคล (Generic)**; **Skills** tags a real person with a skill/role (the supply side); **Availability calendar** sets a person's monthly availability override; **Role supply-vs-demand** rolls assigned demand up against qualified supply per role/month, flagging **กำลังคนไม่พอ (Understaffed)**. Read-only — no new permission beyond the existing `exec`/`planner`/`ar` PPM gate. |
| 2.26 | 2026-07-12 | **PROJ-19 — earned schedule on the workspace Overview.** A **กำหนดการที่ได้รับ (Earned schedule)** block under the earned-value breakdown: **ES** / **AT** / **SV(t)** in months, an **SPI(t)** badge (green ≥ 1, grey ≥ 0.9, red below) and a forecast finish month (`GET /api/projects/{code}/earned-schedule`). SPI(t) stays honest late in a project where the classic SPI converges to 1; a red SPI(t) on a project that otherwise reads fine raises a **schedule_slip_es** (medium) item on the Action Center. Needs tasks with planned cost + due dates (`NO_DATED_PLAN` otherwise). Read-only — no new permission. |
| 2.25 | 2026-07-10 | **CRM-2 — the CRM workspace replaces `/projects/crm` + `/pipeline` (both now redirect to `/crm`; deep links preserved).** The pipeline section points to the new manual **16-crm-workspace.md** (kanban board, deal page with the CRM-WL convert-to-project button, leads import wizard, web-to-lead, accounts/contacts web surface). Win/Loss dashboard (`/projects/pipeline`) unchanged. |
| 2.24 | 2026-07-10 | **CRM-1 — one pipeline, duplicate-governed accounts/contacts (migration 0293).** `/projects/crm` and `/pipeline` now work the SAME deal list (unified `crm_opportunities` spine; tenant-configurable stages; won/lost terminal everywhere → `OPP_CLOSED`; per-deal stage-change audit trail). Lead conversion also creates/links a CRM account + primary contact. New API section **CRM accounts & contacts**: `/api/crm/accounts` + `/api/crm/contacts` with create-time duplicate detection (**409 `DUPLICATE_SUSPECT`** + `force` override) and a maker-checked survivor **merge** (`SOD_VIOLATION` when the duplicate's creator tries to merge away children). CPQ quotes now validate their opportunity link (`OPP_NOT_FOUND`). Troubleshooting rows added in 99. |
| 2.23 | 2026-07-09 | **Project picked from a dropdown on the construction screens (UI-only).** **วางบิลงวดงาน** (`/projects/billing`), **ผู้รับเหมาช่วง** (`/projects/subcontracts`) and the tender form (`/projects/tenders`) no longer ask you to type `PRJ-…`: the project field is a dropdown of the project register (`GET /api/projects` — name + status shown; picking it opens the project immediately; choose **พิมพ์เลขเอกสารเอง…** to key a code). No endpoint/control change. |
| 2.22 | 2026-07-05 | **Printable documents — งวดงาน tax invoice + subcontract certificate** (docs/35 P1/P2). Each certified/raised item now has a **Print / open PDF** button (🖨). On **วางบิลงวดงาน** (`/projects/billing`) every claim row prints the **ใบวางบิลงวดงาน / ใบกำกับภาษี** (progress-claim tax invoice) — BoQ-line movement, retention, VAT, จำนวนเงินที่เรียกเก็บ, and the amount in Thai words. On **ผู้รับเหมาช่วง** (`/projects/subcontracts`) a raised valuation prints the **ใบรับรองผลงานผู้รับเหมาช่วง** (subcontract valuation certificate) — scope, retention, back-charge, WHT (ภ.ง.ด.53), input VAT, จำนวนเงินที่ต้องจ่าย, and the amount in words. Both can also be emailed to the customer/subcontractor as a PDF attachment (`POST /api/progress-billing/{claimNo}/send-email`, `POST /api/subcontracts/valuations/{valNo}/send-email`); the document renders as a web page when the PDF engine is unavailable. Presentation-only — no change to the accounting. |
| 2.21 | 2026-07-05 | **Subcontractor input VAT** (docs/35 P5/Depth) — a subcontract now takes a **VAT %** as well as the WHT %; the certified valuation books the subcontractor's VAT as **recoverable input VAT (ภาษีซื้อ)**, so the payable is *service − WHT + VAT*. (Real-estate **ownership transfer** — the revenue-recognition step — is documented in user-manual 15.) |
| 2.20 | 2026-07-05 | **Scheduled jobs** (docs/35 Depth-5) — three new schedulable report/action jobs (Scheduled Reports): **คืนเงินประกันผลงานที่ถึงกำหนด** (auto-releases retention tranches on their due date, posting the accounting), **ยกเลิกการจองที่หมดอายุ** (cancels lapsed unit bookings and frees the unit), and **งวดผ่อนอสังหาฯ ที่เกินกำหนด** (an overdue-installment worklist). Schedule them like any other report; each is idempotent. |
| 2.19 | 2026-07-05 | **Web screens now live** (docs/35 Depth-4) — the construction/real-estate features have dedicated pages (the earlier "API only" notes are superseded): **ประมูลงาน** (`/projects/tenders` — build an estimate, submit, mark win/loss, and award → seed a project + draft BoQ), **วางบิลงวดงาน** (`/projects/billing` — pick a project, raise a งวดงาน claim against a BoQ line with retention/VAT, certify), **ผู้รับเหมาช่วง** (`/projects/subcontracts` — issue a subcontract against BoQ scope, raise & certify valuations with retention/WHT), and a new **อสังหาริมทรัพย์** section (`/realestate` — developments/units availability grid, booking, maker-checker sale contract, installment payments). New sidebar entries under Project Management + a Real Estate group, permission-gated (`re_sales` for the property module). |
| 2.18 | 2026-07-05 | **VAT & WHT on the billing chain** (docs/35 Depth-2/3). A progress claim now takes a **VAT %** — the tax invoice adds **output VAT (7%)** so the customer's AR includes it, and the figure feeds the VAT return. A subcontract now takes a **WHT %** — the certified valuation withholds Thai construction **withholding tax (3%, ภ.ง.ด.53)** from the subcontractor's payment (they're paid net of WHT; we remit it). And progress billing now **plays nicely with POC revenue recognition**: on a POC project a claim only *bills* (it doesn't recognise revenue twice — recognition stays with the *รับรู้รายได้* action), while on a billing-method project it recognises revenue as before. |
| 2.17 | 2026-07-05 | **Retention release** (docs/35 Depth-1). Releasing retention (`POST /api/retention/{id}/release`, by amount or a scheduled tranche) now **books the accounting**: a customer's เงินประกันผลงานค้างรับ moves from retention receivable (1170) back to normal AR (1100); a subcontractor's เงินประกันผลงานค้างจ่าย moves from retention payable (2440) to normal AP (2000). You can't release more than the outstanding (`RETENTION_OVER_RELEASE`). When a scheduled release date passes, the item appears on the **PMO action center** (`/projects/action-center`) as *เงินประกันผลงานถึงกำหนดคืน (retention due)* so the controller actions it. |
| 2.16 | 2026-07-05 | **Tender / estimating → award** (docs/35 P3, PROJ-18). Build a priced **estimate** for a bid (`POST /api/tenders`): each line has a cost build-up (จำนวน × ต้นทุน/หน่วย, plus a **markup %** → เรทเสนอราคา `bid_rate`), and the tender totals an **estimated cost** and a **bid price**. Track it through *ประเมินราคา (estimating) → ยื่นซอง (submitted) → ชนะ/แพ้ (won/lost)*; a lost tender needs a reason. When you **win**, **award** it (`:no/award`) — one click **spins up the project** (Fixed-price, contract = the bid) and a **draft BoQ** from your estimate lines, so the winning bid becomes the project's budget baseline. The BoQ lands as **draft** and is finalised by the usual maker-checker approve (an independent approver sets the baseline). New errors for troubleshooting: `TENDER_NOT_WON` (award only a won tender), `TENDER_DECIDED`, `LOSS_REASON_REQUIRED`, `EMPTY_TENDER`. Register + win-rate at `GET /api/tenders`. *(The dedicated web tender workspace is a fast-follow; the API is live now.)* |
| 2.15 | 2026-07-05 | **Subcontractor management + retention payable** (docs/35 P2, PROJ-17). Issue a **subcontract** against BoQ scope (`POST /api/subcontracts`) — it reserves that BoQ-line budget (a subcontract counts against the works budget like a PO; over budget → `BUDGET_EXCEEDED`). The subcontractor's periodic **valuations** (`:subNo/valuations`) certify % complete (cumulative — only the movement since the last valuation is certified); an independent certifier (**not** the preparer — `proj_subcon` vs `proj_subcon_certify`, SoD R18) certifies (`valuations/:valNo/certify`), which posts the certified **net** to AP, **withholds retention payable** (เงินประกันผลงานค้างจ่าย → 2440 in the retention sub-ledger), capitalises the works cost into project WIP, and deducts any **back-charges**. New errors for troubleshooting: `SOD_SELF_APPROVAL`, `VALUATION_NOT_DRAFT`, `NOTHING_TO_CERTIFY`, `BAD_BACK_CHARGE`, `BUDGET_EXCEEDED`, `VAL_EXCEEDS_SUBCONTRACT`. Register at `GET /api/subcontracts/project/{code}`. *(The dedicated web subcontracts tab is a fast-follow; the API is live now.)* |
| 2.14 | 2026-07-05 | **Progress billing / งวดงาน + retention** (docs/35 P1, PROJ-16). Bill a construction contract in periodic **progress claims**: `POST /api/progress-billing` raises a claim valuing work **by BoQ line** (% complete → value-to-date; the system bills only the *movement* since the last certified claim, so you can't double-bill or over-certify beyond 100% of a line). An independent certifier (**not** the preparer — `proj_billing` vs `proj_billing_certify`, SoD R17) certifies it (`:claimNo/certify`), which raises the invoice for the **net**, **withholds retention** (เงินประกันผลงาน) into the retention sub-ledger as *ลูกหนี้เงินประกันผลงาน* (1170), recognises revenue and relieves project WIP. A Fixed-price contract can't be certified beyond its contract value. New errors for troubleshooting: `SOD_SELF_APPROVAL` (preparer ≠ certifier), `CLAIM_NOT_DRAFT`, `NOTHING_TO_BILL` (no new work since the last claim), `BAD_PERCENT`, `BILL_EXCEEDS_CONTRACT`. Register at `GET /api/progress-billing/project/{code}` (certified-to-date, retention withheld). *(The dedicated web billing tab is a fast-follow; the API is live now.)* |
| 2.13 | 2026-07-05 | **Retention (เงินประกันผลงาน) — shared sub-ledger foundation** (docs/35, Phase 0). Two new chart-of-accounts entries appear in ผังบัญชี: **1170 ลูกหนี้เงินประกันผลงาน (Retention Receivable)** and **2440 เจ้าหนี้เงินประกันผลงาน (Retention Payable)**. A retention ledger now tracks amounts **withheld − released = คงค้าง (outstanding)** per contract/subcontract with an optional release schedule, and a *due* worklist for tranches whose release date has passed (controller/treasury endpoints `/api/retention/withhold`, `/api/retention/{id}/release`, `/api/retention/due`, `/api/retention/project/{code}`; `RETENTION_OVER_RELEASE` if a release exceeds the outstanding). This is the plumbing only — the customer **progress-billing (งวดงาน)** screen (Track A) and **subcontractor valuation** screen (Track B) that withhold/release retention as part of certifying a claim arrive in the next phases. |
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
| 2.12 | 2026-07-04 | **Raise site cash from the project** (docs/32, FU4) — the *เงินสดหน้างาน* tab gains *ออกเงินทดรอง* (raise a project-tagged advance → `POST /api/finance/advances`) and *ขอเงินสดย่อย* (file a petty-cash request against a fund → `POST /api/finance/petty-cash/requests`), each optionally linked to a BoQ line so settlement/approval consumes that line's budget. Existing endpoints; no API/schema change. |
| 2.11 | 2026-07-04 | **Material-control web screens** (docs/32, FU3) — the project workspace gains four tabs: **BoQ & งบวัสดุ** (create/append/approve/lock/re-measure + per-line budget/committed/remaining), **ขอเบิกวัสดุ** (raise a PMR against a BoQ line; maker-checker decide the pending over-budget ones), **จองสต๊อก** (available-to-issue check → reserve → issue-to-project/release) and **เงินสดหน้างาน** (advances/reimbursements/petty-cash rollup). No new endpoints — screens over the existing docs/32 M0–M4 spine. |
| 2.10 | 2026-07-03 | **Requisition prefers stock** (docs/32, FU2) — a within-budget requisition now issues the material straight to the project **from on-hand stock** when available, and only raises a PR to buy when it isn't. |
| 2.9 | 2026-07-03 | **Budget policy** (docs/32, FU1) — a per-project **over-budget tolerance %** (small overages auto-proceed before approval; 0 = strict), and **site cash consumes budget** (an advance/petty-cash tagged to a BoQ line reduces its remaining). |
| 2.8 | 2026-07-03 | **Project-linked advances & reimbursements** (docs/32, M4, PROJ-14) — advances, expense-reimbursement claims and petty-cash can be raised **against a project** (`project_code`; unknown → `PROJECT_NOT_FOUND`); the spend posts tagged to the project, and `GET /api/projects/{code}/site-cash` rolls up all site cash (advances + reimbursements + petty-cash + totals) on the project. |
| 2.7 | 2026-07-03 | **Stock reservation → issue-to-project** (docs/32, M3, INV-13) — reserve on-hand stock for a project (`POST /api/reservations`; available = on hand − held, no double-allocation → `INSUFFICIENT_STOCK`), then **issue it to the project** (`…/{id}/issue`) which moves the value from inventory (1200) into project WIP (1260); **release** frees an unused hold. |
| 2.6 | 2026-07-03 | **Material requisition + over-budget LINE approval** (docs/32, M2, PROJ-13) — staff raise a **PMR** against BoQ lines (`POST /api/pmr`): within budget it routes to a project-tagged PR; over budget it holds for an authoriser who approves from the app **or one-tap in LINE** (maker-checker, ≠ requester), which **auto-drafts an over-budget project PO** (Draft) for procurement. Pending over-budget requisitions show on the Action Center (`pmr_over_budget`). |
| 2.5 | 2026-07-03 | **Material-budget enforcement** (docs/32, M1, PROJ-12) — a project **PO** tagged to a BoQ line now **reserves** that line's budget; a PO that would exceed it is **blocked** (`BUDGET_EXCEEDED`) and not created, so staff can't over-commit a line (and concurrent orders can't jointly overrun). The BoQ tab shows **budget / committed / remaining** per line; cancelling a PO frees the reservation, full receipt makes it actual. Ledger at `GET /api/projects/{code}/commitments`. |
| 2.4 | 2026-07-03 | **Bill of Quantities (BoQ)** (docs/32, M0) — a **BoQ** tab on the project workspace: rate-built material/works budget lines (จำนวน × ราคา = งบรายการ), draft → maker-checker approve (which **syncs the project budget** to the BoQ total) → lock, with per-line **re-measurement**. Purchase requisitions/POs can be raised **against a project + BoQ line** (unknown project → rejected); a goods receipt inherits the PO's project. Structure/traceability only in M0 — budget enforcement arrives with the commitment ledger (M1). |
| 2.3 | 2026-07-01 | **UI coverage build** — screens for previously headless endpoints: **ปิดงวดโครงการ** (`/projects/close`, PROJ-03 close review + maker-checker + PMO-3 period roll-up); **ลีด & โอกาสการขาย** (`/projects/crm`, REV-17 lead/opportunity management + convert-won-deal-to-project CRM-WL); **แม่แบบ & อัตราค่าแรง** (`/projects/settings`, PROJ-05 rate cards, B2 template builder, cross-project utilization); a **กำกับดูแล (Governance)** workspace tab (PROJ-07 baseline capture + variance, B3 RACI matrix, PMO-4 program membership); a **top-risks** card on the Portfolio (PROJ-08); and project/task allocation + maker-checker approval on the **`/hcm` timesheet** screen (PROJ-04). |
