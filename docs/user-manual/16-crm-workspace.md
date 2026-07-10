# 16 — CRM Workspace (งานขาย: บอร์ดดีล ลีด บัญชีลูกค้า ผู้ติดต่อ)

**Who this is for:** Sales, CRM/Credit Manager, Marketing, Executives
**Screens:** `/crm` (workspace) · `/crm/deals/<OPP-…>` (deal) · `/crm/accounts/<ACC-…>` (account) · `/crm/members` (member CRM 360) · `/projects/pipeline` (win/loss analytics)
**Required permission:** `crm`, `marketing`, `exec` or `ar` (the workspace); account **merge** additionally needs `crm`/`exec`/`masterdata`

The CRM workspace is ONE screen for the whole sales motion: a drag-and-drop **deal board**, **leads**
(with bulk import and website capture), **accounts** and **contacts**. It replaced the three older screens —
`/pipeline` and `/projects/crm` now forward here automatically (old links keep working), and the retail
member CRM 360 (branch KPI, member lookup, messaging) moved to **`/crm/members`**.

---

## 16.1 The deal board (บอร์ดดีล)

Open **CRM งานขาย (บอร์ดดีล)** (`/crm`). The board shows one **column per pipeline stage** (your company's
configured stages; the six defaults are Prospect → Qualified → Proposal → Negotiation → Won → Lost). Each
card shows the deal name, account, amount, owner, win probability, and **how many days it has sat in the
current stage** (an age over 30 days shows red — a stalling deal).

- **Move a deal:** drag its card to another column, **or** use the list view's *ย้ายไป…* dropdown, or the
  stage stepper on the deal page. Every move is recorded in the deal's audit trail (**REV-17** — who, from
  → to, when). **Note:** dropping a card on **Won/Lost asks for the reason** — a Lost close *requires* one
  (`LOST_REASON_REQUIRED`); a Won close may record one. Won/lost deals are final: they cannot be dragged
  again (`OPP_CLOSED`).
- **Board / list toggle** (บอร์ด/รายการ): your choice is remembered on this device.
- **Filters:** free-text search, owner, amount range; the list view adds a stage filter. **บันทึกมุมมอง
  (Save view)** stores the current filter set under a name (synced per user via *Saved views*); pick it back
  from the **มุมมองที่บันทึกไว้** dropdown.
- **สร้างดีล (New deal):** name, amount, expected close date and (optionally) the account.
- The four headline tiles are the open pipeline value, the **weighted forecast** (amount × probability),
  won value and win rate. For loss reasons, per-owner win rates and the monthly trend, open
  **วิเคราะห์ Win/Loss** (`/projects/pipeline`) from the header.

## 16.2 The deal page (`/crm/deals/<OPP-…>`)

Click any card (or a row in list view) to open the deal:

- **Header:** amount, probability, status, expected close, a link to the **account**, and the **primary
  contact**. The **stage stepper** moves the deal by clicking a stage; **ชนะ/เสีย** buttons close it (same
  reason dialog as the board).
- **งานถัดไป (Next step):** the nearest unfinished task on the deal is highlighted with its due date —
  tick **ทำเสร็จแล้ว** when done.
- **ไทม์ไลน์กิจกรรม (Timeline):** every activity (call / email / meeting / note / task), every **stage
  change** (from the audit trail) and every **linked quotation** merged in time order. Log a new activity
  from the quick-add row (a *task* takes a due date).
- **ใบเสนอราคาที่เชื่อมโยง (Linked quotes):** the CPQ quotes created against this deal, with status and
  amount (create new ones on `/cpq` — pass the deal when creating so they link).
- A **Won** deal shows **เป็นโครงการ (To project)** — it seeds a project's contract from the deal value
  (control **CRM-WL**) and opens the new project workspace.

## 16.3 Leads (ลีด)

The **ลีด** tab lists leads with status/source filters and three actions per row: **คัดกรอง (qualify)**,
**แปลงเป็นโอกาสการขาย (convert — creates the customer-of-record, the CRM account + primary contact and the
deal, then opens the deal page)** and **ปิด/เสีย (lose)**.

Three ways leads arrive:

1. **เพิ่มลีด (Add manually)** — the form at the top of the tab.
2. **นำเข้า CSV/Excel (Import wizard)** — pick a `.csv`/`.xlsx` file or paste CSV text. Columns:
   **Name (required)**, Company, Email, Phone, Source, Owner, Notes (download the template from the
   dialog). Press **ตรวจสอบก่อน (Validate)** to see a per-row report (e.g. `แถวที่ 2: ต้องระบุ 'Name'`)
   without importing; **นำเข้า (Import)** then creates the valid rows (invalid rows are skipped and listed).
3. **Web-to-lead** — your website's contact form posts to `POST /api/crm/web-to-lead` (no login needed) and
   the enquiry appears here with source **web**. Ask your administrator to embed the form; on a
   multi-company install the form must send your company's `tenant_code`. The endpoint is rate-limited per
   visitor and carries a hidden anti-spam (honeypot) field — bot submissions are dropped silently.

## 16.4 Accounts & contacts (บัญชีลูกค้า & ผู้ติดต่อ)

- **บัญชีลูกค้า (Accounts):** the company records behind your deals. Search, create, and click through to
  the **account page** — header, its **contacts**, its **deals** (open first) and the recent activity across
  those deals. **แก้ไข (Edit)** updates the basics. (The finance-joined customer 360 — invoices, AR — is a
  separate upcoming enhancement.)
- **ผู้ติดต่อ (Contacts):** people under an account, tagged by role (ผู้ตัดสินใจ / วางบิล / เทคนิค / อื่น ๆ).
- **กันข้อมูลซ้ำ (Duplicate protection):** if the account/contact you create matches an existing record on
  tax ID / email / phone / normalized company name, the system refuses and shows the **suspected matches**
  in a dialog — open the existing record instead, or press **ยืนยันสร้างซ้ำ (force)** only if it truly is a
  different party. Confirmed duplicates are merged by a steward (see manual 14 — the merge is maker-checked:
  the duplicate's creator cannot merge it away, `SOD_VIOLATION`).

---

## 16.5 Analytics — the "why" behind the pipeline (CRM-5)

Beyond the win/loss dashboard, three read-only analytics answer *why* deals move the way they do. Each looks
back over a **time window** (`months`, default 6 — add e.g. `?months=3` to narrow it) and needs the `crm`,
`exec` or `ar` permission.

- **กรวยการขาย + ความเร็ว (Funnel + velocity)** — `GET /api/crm/pipeline/analytics/funnel`. The conversion
  funnel **ลูกค้ามุ่งหวัง → ผ่านคุณสมบัติ → โอกาสการขาย → ปิดการขายได้** with the drop-off at each step, plus,
  from the deal's stage history, **how long deals sit in each stage** (time-in-stage velocity), which stages
  they reach, and the **average sales cycle** (days from creation to a win). Use it to find where deals stall.
- **ผลตอบแทนตามแหล่งที่มา (Source ROI)** — `GET /api/crm/pipeline/analytics/source-roi`. Each **lead source**
  (webinar, expo, web, referral, …) with the **won revenue**, win rate and average deal size it produced —
  so marketing spend follows the channels that actually close. Deals with no originating lead show as `direct`.
- **พยากรณ์การขาย + โควตา (Forecast + quota)** — `GET /api/crm/pipeline/analytics/forecast`. Open pipeline
  split into **commit** (probability ≥ 70%), **best-case** (40–69%) and **pipeline** (< 40%) with a
  risk-adjusted forecast total; **quota attainment per owner** (won-so-far vs a quota you pass in the report
  filters — left blank if you don't track quotas here); and an **activity leaderboard** (who logged and
  completed the most touches).

All three are also **schedulable reports** on the report builder (report types `crm_funnel`,
`crm_source_roi`, `crm_forecast`, alongside `crm_win_loss`) — subscribe to get them emailed/LINE'd on a cadence.

---

## Common errors on these screens

| Error | Meaning | What to do |
|---|---|---|
| `LOST_REASON_REQUIRED` | Closing a deal as Lost without a reason | Fill in the reason in the dialog. |
| `OPP_CLOSED` | Moving a won/lost deal | Closed deals are final — create a new deal if the customer returns. |
| `DUPLICATE_SUSPECT` | The new account/contact matches an existing record | Review the matches in the dialog; open the existing record, or force-create a genuinely different party. |
| `TENANT_REQUIRED` | Website form posted without a company code (multi-company installs) | Ask the administrator to add `tenant_code` to the embedded form. |
| `MISSING_COLUMNS` / `ต้องระบุ 'Name'` | Lead import file without the `Name` column / a row with a blank name | Use the template; fix or accept that the row is skipped. |

## Revision history

| Version | Date | Notes |
|---|---|---|
| 1.1 | 2026-07-10 | **CRM-5 — analytics that answer "why"** (Module-Depth Uplift Wave 4): new §16.5 covering the funnel-conversion + time-in-stage velocity, source-ROI, and forecast-categories + quota + activity-leaderboard analytics (`/api/crm/pipeline/analytics/*`), each date-bounded and schedulable as the BI report types `crm_funnel` / `crm_source_roi` / `crm_forecast`. |
| 1.0 | 2026-07-10 | **CRM-2 — first release of the unified CRM workspace** (docs/41): `/crm` kanban board + list toggle, saved filter views, deal page with unified timeline + next-step, account page, leads import wizard, web-to-lead capture; `/pipeline` and `/projects/crm` now redirect here; member CRM 360 moved to `/crm/members`. |
