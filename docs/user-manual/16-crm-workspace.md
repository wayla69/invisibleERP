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
  the **account page** — header, the **Customer 360 panel** (§16.5), its **contacts**, its **deals** (open
  first) and the recent activity across those deals. **แก้ไข (Edit)** updates the basics.
- **ผู้ติดต่อ (Contacts):** people under an account, tagged by role (ผู้ตัดสินใจ / วางบิล / เทคนิค / อื่น ๆ).
- **กันข้อมูลซ้ำ (Duplicate protection):** if the account/contact you create matches an existing record on
  tax ID / email / phone / normalized company name, the system refuses and shows the **suspected matches**
  in a dialog — open the existing record instead, or press **ยืนยันสร้างซ้ำ (force)** only if it truly is a
  different party. Confirmed duplicates are merged by a steward (see manual 14 — the merge is maker-checked:
  the duplicate's creator cannot merge it away, `SOD_VIOLATION`).

---

## 16.5 Customer 360 — see the money before you call (ลูกค้า 360)

On every account page a **Customer 360 panel** sits under the header so you have the whole relationship —
and the money — in front of you before you dial. It is **read-only** (it changes nothing) and requires the
`crm`, `exec` or `ar` permission. It joins:

- **The money (company position).** ยอดค้างชำระ **AR open balance**, **overdue** and the **max days overdue**,
  the **credit limit / available credit**, and a clear **ระงับเครดิต (On credit hold)** or **เครดิตปกติ (Credit
  OK)** badge with the hold reason. Below it, the **last payments** (recent receipts). *These figures are the
  **company's** receivables and credit standing — this single-company edition has no per-customer AR
  sub-ledger, so the panel labels them accordingly ("ยอดลูกหนี้/เครดิต…เป็นระดับบริษัท").*
- **Open deals & quotes.** The account's open-pipeline value and probability-weighted forecast, plus its
  **CPQ quotes** (number, status, amount).
- **Loyalty (สมาชิก).** When a contact is linked to a loyalty member, the member's **tier**, **points**,
  **RFM segment** and **churn risk**, with an **NPS detractor** or **open recovery case** flag when relevant.
- **Recent sales orders (company).** The latest company sales orders with their status and estimated
  delivery.

If the account has no member-linked contact the loyalty box shows "ยังไม่มีผู้ติดต่อที่เชื่อมสมาชิก" — link a
contact to a member (§16.4) to light it up.

---

## Common errors on these screens

| Error | Meaning | What to do |
|---|---|---|
| `LOST_REASON_REQUIRED` | Closing a deal as Lost without a reason | Fill in the reason in the dialog. |
| `OPP_CLOSED` | Moving a won/lost deal | Closed deals are final — create a new deal if the customer returns. |
| `DUPLICATE_SUSPECT` | The new account/contact matches an existing record | Review the matches in the dialog; open the existing record, or force-create a genuinely different party. |
| `TENANT_REQUIRED` | Website form posted without a company code (multi-company installs) | Ask the administrator to add `tenant_code` to the embedded form. |
| `MISSING_COLUMNS` / `ต้องระบุ 'Name'` | Lead import file without the `Name` column / a row with a blank name | Use the template; fix or accept that the row is skipped. |
| `ACCOUNT_NOT_FOUND` | Opening Customer 360 for an account number that doesn't exist in your company | Check the `ACC-…` number, or open the account from the Accounts tab. |

## Revision history

| Version | Date | Notes |
|---|---|---|
| 1.0 | 2026-07-10 | **CRM-2 — first release of the unified CRM workspace** (docs/41): `/crm` kanban board + list toggle, saved filter views, deal page with unified timeline + next-step, account page, leads import wizard, web-to-lead capture; `/pipeline` and `/projects/crm` now redirect here; member CRM 360 moved to `/crm/members`. |
| 1.1 | 2026-07-10 | **CRM-3 — Customer 360 panel on the account page** (docs/42): new §16.5. The account page now shows a read-only *see-the-money-before-you-call* panel that joins the company AR/credit position + last payments, the account's open deals + CPQ quotes, and the linked member's loyalty (tier/points/RFM/NPS/recovery) in one view (`GET /api/crm/customer-360/:accountNo`). Added the `ACCOUNT_NOT_FOUND` error row. |
