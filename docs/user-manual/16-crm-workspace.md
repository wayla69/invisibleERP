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

### Lead scoring (คะแนนลีด) — CRM-4

Every lead carries an **explainable grade A–D** (`GET /api/crm/pipeline/leads/<LEAD-…>/score`). The score
combines the **source** (referral/partner rank highest, a purchased list lowest), **size** (a company name ⇒
a bigger B2B opportunity), **contactability** (has an email + a phone) and **engagement recency** (how
recently the lead was touched). Open a lead to see the per-factor **breakdown** — so you can tell *why* a
lead is an A (chase it today) or a D. The formula is versioned (`v1`); re-score after new activity with
**คำนวณคะแนนใหม่ (Re-score)** (`POST …/score`).

## 16.3b Follow-up discipline (วินัยการติดตาม) — CRM-4

Leads and deals must not go cold. The **follow-up center** (`GET /api/crm/pipeline/follow-up`) is one
severity-ranked worklist of what needs attention now:

- **ลีดเกิน SLA (SLA breach):** a **new** lead that has had **no activity logged** for longer than the
  response SLA (default **24 hours**). This is detective control **REV-22** — leads must be touched in time.
  Log any activity (a call/email/note) and the breach clears.
- **งานเลยกำหนด (overdue task):** an open follow-up **task** whose due date has passed.
- **ดีลค้าง (rotting deal):** an **open** deal with no activity for longer than the rotting window
  (default **7 days**).

**Round-robin assignment:** when owners are configured, each new lead is auto-assigned to the next owner in
rotation (or press **มอบหมาย (Assign)**, `POST …/leads/:no/assign`, to rotate/override).

**Settings (`GET/PUT …/follow-up/settings`)** — a sales manager (`crm`/`exec`) sets `sla_hours`,
`rotting_days` and the `round_robin_owners` list. Schedule the **สรุปการติดตามงานขายประจำวัน (CRM follow-up
digest)** BI report to run the sweep daily: it posts a summary notification and fires `lead.stagnant` into
the automation rules so you can auto-escalate a stale lead.

**Automation from the pipeline:** the pipeline emits `lead.created`, `lead.stagnant`, `opp.stage_changed`,
`deal.won` and `deal.lost` events — build no-code rules (Settings → Automation) to notify a channel, send a
LINE message or enrol a journey when they fire.

## 16.3c Send email / LINE from a deal (ส่งอีเมล/LINE จากดีล) — CRM-4

From a deal you can message the customer directly (`POST …/opportunities/:oppNo/comms`). Choose the channel
(**email / LINE / SMS**), write a subject/body and use **merge fields** — `{{contact.name}}`, `{{opp.name}}`,
`{{opp.amount}}`, `{{account.name}}`, `{{owner}}` (list at `GET …/comms/merge-fields`) — which are filled
from the deal before sending. The send is **logged as a timeline activity** so the whole thread stays on the
deal (and the Customer-360). If the contact has no address for the chosen channel, pass an explicit `to`.

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

## 16.4b Account hierarchy, buying committee & account plans (โครงสร้างบริษัท คณะผู้ตัดสินใจ และแผนบัญชีลูกค้า — CRM-7)

Three tools deepen the account view so a strategic B2B account is *governed*, not just listed.

- **โครงสร้างบริษัท (Account hierarchy).** Give an account a **parent** (`PATCH …/accounts/:no/parent`) to
  model a group — a holding company and its subsidiaries. The system blocks a company being its own parent
  (`SELF_PARENT`) or a link that would loop back on itself (`HIERARCHY_CYCLE`). The **hierarchy** view
  (`GET …/accounts/:no/hierarchy`) shows the parent chain, the direct children, and a **subtree pipeline
  roll-up** — the open, probability-weighted pipeline across the whole group, so you see the buying group's
  value, not just one company. Merging a duplicate keeps the tree intact (its children re-parent to the survivor).
- **คณะผู้ตัดสินใจ (Buying committee).** On a deal, record **who decides** — add contacts as committee
  members with a **role** (ผู้ตัดสินใจ / แชมเปี้ยน / ผู้มีอิทธิพล / ผู้ประเมิน / ผู้คัดค้าน / ผู้ใช้งาน) and an
  **influence** weight; mark exactly one as **primary**. A committee contact must belong to the deal's account
  (`CONTACT_ACCOUNT_MISMATCH`) and appears once per deal (`COMMITTEE_DUP`). So a forecast rests on a documented
  decision unit, not a single name.
- **แผนบัญชีลูกค้า (Account plans) — the "Account plans" tab.** Create a plan for an account with an **owner**,
  **objective**, **target revenue** and **target product categories** (comma-separated category codes, checked
  against your item categories — an unknown code is rejected `UNKNOWN_CATEGORY`). A plan runs a governed
  lifecycle: **ร่าง (draft) → เปิดใช้งาน (active) → ปิด (closed)**. **เปิดใช้งาน (Activate)** needs an owner **and**
  an objective; a closed plan is read-only. The **whitespace panel** (per account) shows every active product
  category as **covered** (green — targeted by an active plan) or **whitespace** (not yet pursued), so coverage
  gaps are obvious at a glance.

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

## 16.6 Inbound replies & the review queue (อีเมลตอบกลับเข้า CRM) — CRM-6

CRM-4 lets you email a customer *from* a deal (§16.3c); **CRM-6 captures their reply back onto the same deal**
automatically, so the whole conversation lives on the timeline — no copy-pasting from your inbox. It works over
your company's **CRM inbound email address** (your administrator points the mail provider's inbound route at
`/api/crm/email/inbound/<company code>`); the system never reads your personal mailbox.

- **Automatic threading.** Every email you send from a deal now carries a hidden reference tag (`[ref:…]`). When
  the customer replies (even from a different address, or forwarded by a colleague), that tag threads the reply
  straight back to the right deal and it appears as an **inbound email activity** on the deal page and Customer-360.
- **Match by sender.** If there's no tag, the reply is matched by the sender's email to a **contact's open deal**,
  or to an **open lead**.
- **Review queue (คิวตรวจสอบ).** A reply that can't be matched — a brand-new sender, or a stray email — is **not**
  guessed onto a deal. It waits in the **review queue** (`GET /api/crm/inbound/review`). Open the queue, and for
  each item either **Link** it to the right deal/lead (`POST /api/crm/inbound/:id/link` — it's logged as an
  activity and leaves the queue) or **Dismiss** it (`POST /api/crm/inbound/:id/dismiss`) if it's spam.
- **Authenticity.** The inbound webhook is signed with your company's email secret (HMAC); a forged or unsigned
  delivery is rejected and never journaled. Capture is **read-only to your pipeline** — it adds timeline
  activities but never posts to the ledger and never moves a deal's stage.

---

## 16.7 Service contracts & subscriptions (สัญญาบริการ & การสมัครสมาชิก — `/service`)

The **บริการ** workspace is the after-sales home: SLA-backed service contracts, incident tracking with breach
detection, and recurring **subscription billing**. It has two tabs.

**Contracts tab (สัญญาบริการ).** Create a contract for a customer and pick an **SLA tier** (Bronze / Silver /
Gold / Platinum) — the tier sets the response/resolution-hour targets automatically. Click a contract row to open
its **SLA events** panel below:

- **Log an event (บันทึกเคส).** Enter a title and priority (P1–P4). The system stamps the response-due and
  resolution-due times from the contract's tier.
- **Resolve (ปิดเคส).** Press **ปิดเคส** on an open event to close it. The system records the resolved time and
  computes whether the **response** and **resolution** SLAs were breached, shown as green *ตรงเวลา* / red *เกิน SLA*
  badges. A red **เกิน SLA** count badge on the panel header tallies the breaches so a manager can see them at a
  glance. Resolved events no longer show the button.

**Subscriptions tab (การสมัครสมาชิก).** Manage recurring revenue streams:

- **Create a subscription (เปิดการสมัคร).** Enter customer, product code, unit price, quantity (default 1), the
  billing cycle (monthly / quarterly / annual) and a start date. Revenue per cycle for active subscriptions is
  summarised in the stat cards.
- **Run billing (รันรอบเรียกเก็บ).** Press **รันรอบเรียกเก็บ** to generate invoices for every **Active**
  subscription whose next-billing date has arrived. Each run posts subscription revenue to the ledger
  (Dr AR / Cr Subscription Revenue) and advances the next-billing date by the cycle. Paused and cancelled
  subscriptions are skipped. Requires the **approvals** permission.
- **Pause / Resume (พัก / เปิดใช้).** **พัก** stops billing without ending the subscription; **เปิดใช้** brings a
  paused subscription back to Active so it bills again on the next run.
- **Cancel (ยกเลิก).** **ยกเลิก** ends a subscription permanently — you're asked to confirm, and a cancelled
  subscription **cannot be reactivated** (create a new one if the customer returns).
- **Invoices (ใบแจ้งหนี้).** Press **ใบแจ้งหนี้** on a row to see that subscription's invoices (period, amount, due
  date, status). Press **บันทึกชำระ** on an unpaid invoice to mark it paid — the payment posts to the ledger
  (Dr Cash / Cr AR).

---

## 16.8 Warranty & Entitlement (การรับประกัน & สิทธิ์คุ้มครอง — `/service/warranty`)

The **การรับประกัน & สิทธิ์** page tracks serialized units you have sold and the warranty coverage they carry, and
controls warranty claims so that free service or replacement goods are only given when the unit is actually in
coverage (**control SVC-01**). It has four tabs.

- **เงื่อนไขรับประกัน (Warranty terms).** The catalogue of your warranty offerings. Create a term with a code, a
  name, a **ระยะเวลา (coverage months)**, and a **ประเภทความคุ้มครอง** — `full` (covers everything), `parts`, or `labor`.
  Requires the master-data duty.
- **ทะเบียนเครื่อง (Installed base).** Register a sold unit against a term: its **หมายเลขเครื่อง (serial)** (unique in
  your company), item code, customer, **วันที่ขาย (sold date)**, and the warranty term. The system automatically
  computes the **สิ้นสุดการรับประกัน (warranty end)** = sold date + the term's coverage months. Requires the
  master-data duty.
- **เคลม (Claims).** Raise a claim against a registered unit (unit, fault, and the **ขอเคลมประเภท** — parts / labor /
  full). The system checks coverage the moment you raise it:
  - **In coverage** (still within the warranty window *and* the coverage type covers the claim kind) → the claim
    is **authorized automatically and free of charge** — it is contractually covered.
  - **Out of coverage** (expired, or a kind the term doesn't cover) → the claim **waits as *pending*** and shows a
    red **นอกความคุ้มครอง** badge. A **different person** (the approvals duty — never the person who raised it) must
    press **อนุมัติ (Authorize)** and either set a real charge (a paid repair) or authorize it free, or **ปฏิเสธ
    (Reject)** it with a reason. If you try to authorize your own claim the system blocks it
    (`SOD_SELF_APPROVAL`).
- **รายการยกเว้นความคุ้มครอง (Coverage exceptions).** A read-only register of claims that were authorized **free**
  even though the unit was **out of coverage** — the list a reviewer or auditor samples to confirm every free
  grant was independently authorized. A soon-expiring-warranty worklist is available via the *expiring* read.
## 16.9 Contract renewals & expiry (ต่ออายุสัญญา — `/service/renewals`)

Service contracts have an end date. The **ต่ออายุสัญญา** workspace stops a contract from silently lapsing and
controls the renewal price. It requires the **บริการ/ผู้บริหาร** (`marketing`/`exec`) permission to view. It has
two tabs.

**Proposing a renewal.** From the contract you propose a renewal with an **uplift %** (the price increase on the
next term). The new value is computed as **base × (1 + uplift ⁄ 100)**. What happens next depends on the size of
the uplift and your tenant's **renewal-uplift ceiling** (default **5%**, changeable by an executive):

- **Within the ceiling** (and not an auto-renew that raises price) → the renewal is **approved automatically** and
  a **successor contract** is created immediately for the new term and value. The old contract is marked
  *ต่ออายุแล้ว (renewed)* and links to its successor.
- **Above the ceiling, or any auto-renew that raises price** → the renewal is parked **รออนุมัติ (pending)** and
  routes to maker-checker: a **different** person (with the **approvals**/**exec** duty) must approve it. The person
  who proposed it **cannot** approve their own — the system returns *SOD_SELF_APPROVAL* (control **SVC-02**). Only on
  independent approval is the successor contract created.

**Renewal queue tab (คิวต่ออายุ).** Lists the pending renewals with base value, uplift %, the computed new value and
the proposed term. Press **อนุมัติ** to approve (creates the successor contract) or **ปฏิเสธ** to reject (leaves the
old contract untouched — it is marked *declined*, not renewed).

**Expiring tab (ใกล้หมดอายุ).** A detective worklist of Active contracts nearing their end date **that have no
renewal in flight** — pick a horizon (30 / 60 / 90 / 180 days). Already-renewed or pending contracts are excluded, so
what remains is exactly the list a service manager must action before it lapses. An already-expired contract carries a
red *หมดอายุแล้ว* badge.

---

## 16.10 Support cases & Email-to-Case (เคสบริการ & อีเมลเข้าเคส — `/service`, SVC-4)

The **เคสบริการ (Support cases)** tab on `/service` is where the service team tracks every customer request or
complaint as a **case** — and where customer emails become cases automatically (**Email-to-Case**) so nothing is
lost.

**Open a case** — fill in the subject, pick a **priority** (P1–P4), optionally the customer's email and an
assignee, and press **เปิดเคส (Open case)**. The case gets a number (`CASE-…`) and starts at **new** (or **open**
if you named an assignee).

**Work the case** — each row has the actions that its status allows:
- **มอบหมาย (Assign)** — type the owner's username; the case moves to **open**.
- **แก้ไขแล้ว (Resolve)** — mark the case resolved once you've handled it.
- **ปิดเคส (Close)** — close the case (terminal).
- **เปิดใหม่ (Reopen)** — bring a resolved/closed case back to **open**.

The lifecycle is governed (**new → open → pending → resolved → closed**, with reopen), so the status you see is
always reliable — you can't, for example, resolve a case that's already closed.

**Email-to-Case (control SVC-04).** Point your support inbox (e.g. `support@yourcompany`) at the tenant webhook
`/api/service/email-to-case/inbound/<company code>` at your mail provider (SendGrid Inbound Parse / Mailgun route
/ Postmark), authenticated with the **same per-tenant email secret** your CRM inbound uses. Then:
- A customer email that matches no case **opens a new case** (source **email**) — so no request is dropped.
- A **reply** threads straight back onto its case (via the hidden `[case:…]` tag on the reply we send, or the
  sender's open case), and if the case was already resolved/closed the reply **reopens** it.
- Duplicate provider redeliveries are ignored automatically.

The webhook is HMAC-signed — forged or replayed deliveries are rejected — and Email-to-Case never posts to the
ledger.

---

## 16.11 Case SLAs & breach worklist (ระดับ SLA ของเคส — `/service`, SVC-5)

Every support case carries a **service level (SLA)** so you can see whether you're meeting your commitments.

**SLA tier.** When you open a case, pick an **SLA tier** (Standard / Bronze / Silver / Gold / Platinum). The tier
sets two clocks from the moment the case opens: a **first-response** target and a **resolution** target (e.g. Gold
= respond within 2 h, resolve within 8 h; Standard = 8 h / 48 h). You can change a case's tier later with
**ตั้งระดับ SLA (Set SLA tier)** on its row — the due times recalculate from the original open time. Cases created
from an email get the **Standard** tier automatically.

**Breach flags.** The first reply you send is recorded as the **first response** — if it's late, the case shows a
red **เกิน SLA (Breached)** badge. Likewise a case resolved after its resolution target is flagged breached.

**Breach worklist.** The **เกิน SLA (SLA breaches)** stat at the top of the เคสบริการ tab counts the **open** cases
that are currently past a first-response or resolution target (with no response / not yet resolved). Work those
down to zero — responding to or resolving a case removes it from the count. It turns green when nothing is
breaching.

---

## 16.12 Knowledge base & case deflection (ฐานความรู้ — `/service`, SVC-6)

The **ฐานความรู้ (Knowledge base)** tab on `/service` is where the team writes help articles and sees how well
they **deflect** cases (customers self-serving instead of opening a case).

**Write & publish.** Press **เขียนบทความ (Write an article)** to save a **draft** (title, body, category, tags).
A draft is only visible to the team. To make it live, **a different colleague** presses **เผยแพร่ (Publish)** on
it — the author can't publish their own article (you'll get a *publisher must differ from author* error). This
keeps every published article reviewed. You can edit a draft freely; once published it's locked (re-draft a new
version if it needs changes). Press **เก็บถาวร (Archive)** to retire a published article.

**Search.** The search box finds **published** articles only (by title, body, or tags) — this is what agents and
customers use to self-serve, and each hit bumps the article's view count.

**Deflection rate.** The **อัตราการเบี่ยงเคส (Deflection rate)** stat shows what share of KB-assisted
interactions ended without a case being opened — a direct read on how much work the knowledge base is saving.

---

## Common errors on these screens

| Error | Meaning | What to do |
|---|---|---|
| `LOST_REASON_REQUIRED` | Closing a deal as Lost without a reason | Fill in the reason in the dialog. |
| `OPP_CLOSED` | Moving a won/lost deal | Closed deals are final — create a new deal if the customer returns. |
| `DUPLICATE_SUSPECT` | The new account/contact matches an existing record | Review the matches in the dialog; open the existing record, or force-create a genuinely different party. |
| `TENANT_REQUIRED` | Website form posted without a company code (multi-company installs) | Ask the administrator to add `tenant_code` to the embedded form. |
| `MISSING_COLUMNS` / `ต้องระบุ 'Name'` | Lead import file without the `Name` column / a row with a blank name | Use the template; fix or accept that the row is skipped. |
| `NO_ROUND_ROBIN` | **Assign** pressed with no round-robin owners configured and no owner given | Set `round_robin_owners` in follow-up settings, or pass an owner. |
| `NO_RECIPIENT` | Comms send where the contact has no address for that channel | Enter a `to` address, or set the contact's email/LINE id/phone. |
| `ACCOUNT_NOT_FOUND` | Opening Customer 360 for an account number that doesn't exist in your company | Check the `ACC-…` number, or open the account from the Accounts tab. |
| `HIERARCHY_CYCLE` / `SELF_PARENT` | Setting an account's parent to itself or to one of its own subsidiaries (§16.4b, CRM-7) | Pick a parent outside the account's own group subtree. |
| `CONTACT_ACCOUNT_MISMATCH` / `COMMITTEE_DUP` | Adding a buying-committee contact from another account, or the same contact twice (§16.4b, CRM-7) | Add only this deal account's contacts; each contact appears once per deal. |
| `UNKNOWN_CATEGORY` | An account-plan target category code that isn't one of your item categories (§16.4b, CRM-7) | Use an existing active item-category code (comma-separated). |
| `PLAN_INCOMPLETE` / `PLAN_NOT_DRAFT` / `PLAN_NOT_ACTIVE` / `PLAN_CLOSED` | An out-of-order account-plan lifecycle action (§16.4b, CRM-7) | Follow draft → active → closed; set owner + objective before activating; a closed plan is read-only. |
| `BAD_INBOUND_SECRET` / `INBOUND_UNVERIFIED` | An inbound CRM email arrived unsigned or with a wrong signature (CRM-6) | Not a user action — ask your administrator to configure the CRM inbound email secret at the mail provider. |
| `ALREADY_RESOLVED` | Linking a review-queue item that was already linked or dismissed | Refresh the review queue; someone already handled it. |
| `SUB_CANCELLED` | Resuming/pausing a subscription that is already cancelled (§16.7) | Cancel is permanent — create a new subscription instead. |
| `ALREADY_PAID` | Marking an invoice paid that is already paid (§16.7) | Refresh the invoices list; it was already settled. |
| `SOD_SELF_APPROVAL` | Authorizing/rejecting a warranty claim you raised yourself (§16.8, SVC-01) | A different person with the approvals duty must action the claim. |
| `CLAIM_NOT_PENDING` | Authorizing/rejecting a warranty claim that is already decided (§16.8) | Refresh the claims list; it was already actioned. |
| `SERIAL_EXISTS` / `TERM_EXISTS` | Registering a serial / creating a term code that already exists (§16.8) | Use a unique serial / term code. |
| `SOD_SELF_APPROVAL` | Approving a contract renewal you proposed yourself (§16.9, SVC-02) | A different service/executive user must approve the renewal. |
| `CONTRACT_ALREADY_RENEWED` | Proposing a renewal on a contract that already has a successor (§16.9) | The contract is already renewed — open its successor instead. |
| `RENEWAL_IN_FLIGHT` | Proposing a second renewal while one is still pending (§16.9) | Approve or reject the pending renewal first. |
| `CASE_NOT_ACTIVE` | Resolving a case that is not new/open/pending (§16.10) | Reopen the case first if you need to work it again. |
| `CASE_ALREADY_CLOSED` / `CASE_NOT_CLOSED` | Closing an already-closed case / reopening a case that isn't resolved/closed (§16.10) | Refresh the list; the status changed under you. |
| `UNKNOWN_TENANT` | An Email-to-Case delivery used a company code that doesn't exist (§16.10) | Not a user action — fix the webhook URL's company code at the mail provider. |

## Revision history

| Version | Date | Notes |
|---|---|---|
| 2.0 | 2026-07-12 | **B2B account/contact 360 depth (`/crm`) — CRM-7, control CRM-07:** new §16.4b. **Account hierarchy** (give an account a parent to model a group; the hierarchy view rolls the whole group's weighted pipeline up; cycles blocked); **buying committee** (record who decides on a deal — role + influence + one primary, contacts must belong to the deal's account); and **account plans** (a new *Account plans* tab — governed draft → active → closed plans with an owner, objective, target revenue and target product categories, plus a **whitespace** panel showing which product categories the account isn't being pursued for). Added the `HIERARCHY_CYCLE`/`SELF_PARENT`, `CONTACT_ACCOUNT_MISMATCH`/`COMMITTEE_DUP`, `UNKNOWN_CATEGORY`, and `PLAN_*` error rows. |
| 1.9 | 2026-07-12 | **Knowledge base & case deflection (`/service`) — SVC-6, control SVC-06:** new §16.12. Write help articles as drafts; a **different colleague** publishes them (authors can't self-publish — governed review); published articles are searchable (published-only), archivable, and score helpful votes; a **deflection-rate** stat shows the share of KB-assisted interactions that avoided opening a case. |
| 1.8 | 2026-07-12 | **Case SLAs & breach worklist (`/service`) — SVC-5, control SVC-05:** new §16.11. Each case gets an **SLA tier** (Standard/Bronze/Silver/Gold/Platinum) that sets first-response + resolution due times from the case open time; the first reply and a late resolution flag a red **เกิน SLA** badge; a **SLA-breaches** stat counts open past-due cases and clears as you respond/resolve. Added a **Set SLA tier** row action and the SLA-tier field on the open-a-case form; email-opened cases default to Standard. |
| 1.7 | 2026-07-11 | **Support cases & Email-to-Case (`/service`) — SVC-4, control SVC-04:** new §16.10. The เคสบริการ tab opens/tracks support cases with a governed lifecycle (new→open→pending→resolved→closed, reopen) + priority/assignee, and **Email-to-Case** turns customer emails into cases automatically — an unmatched email opens a new case (nothing dropped), a reply threads back onto its case (reopening it if resolved/closed), duplicate redeliveries are ignored, and the HMAC-signed webhook rejects forged/replayed mail. Added the `CASE_NOT_ACTIVE` / `CASE_ALREADY_CLOSED` / `CASE_NOT_CLOSED` / `UNKNOWN_TENANT` error rows. |
| 1.6 | 2026-07-11 | **Contract renewals & expiry (`/service/renewals`) — SVC-3, control SVC-02:** new §16.9. Propose a renewal with an uplift % (new value = base × (1+uplift)); within the tenant ceiling (default 5%) it auto-approves and creates the successor contract, above the ceiling — or any auto-renew that raises price — it routes to maker-checker (a different user must approve; the proposer is blocked with `SOD_SELF_APPROVAL`). Renewal queue (approve/reject) + an expiry worklist of Active contracts near their end date with no renewal in flight. Added the `SOD_SELF_APPROVAL` / `CONTRACT_ALREADY_RENEWED` / `RENEWAL_IN_FLIGHT` error rows. |
| 1.5 | 2026-07-11 | **SVC-2 Warranty & Entitlement registry (`/service/warranty`):** new §16.8 documenting the warranty-term catalogue, the installed-base serialized-unit registry (auto-computed warranty end), and warranty claims with the **SVC-01** coverage-authorization maker-checker (in-coverage → auto-free; out-of-coverage → a *different* person authorizes/rejects, `SOD_SELF_APPROVAL` on self-approval), plus the coverage-exceptions override register. Added `SOD_SELF_APPROVAL` / `CLAIM_NOT_PENDING` / `SERIAL_EXISTS`+`TERM_EXISTS` error rows. |
| 1.4 | 2026-07-11 | **Service workspace (`/service`) — subscription lifecycle + SLA resolve made usable:** new §16.7 documenting the after-sales workspace. Surfaced the previously UI-less flows: **ปิดเคส (Resolve)** on SLA events (with breach computation + red *เกิน SLA* badges), and on subscriptions a **create form**, **รันรอบเรียกเก็บ (Run billing)**, per-row **พัก/เปิดใช้/ยกเลิก (pause/resume/cancel)** with a cancel-confirm, and an **ใบแจ้งหนี้ (invoices)** drill-down with **บันทึกชำระ (mark paid)**. New backend endpoint `POST /api/service/subscriptions/:id/resume`; cancel is now terminal. Added the `SUB_CANCELLED` / `ALREADY_PAID` error rows. |
| 1.3 | 2026-07-10 | **CRM-6 — inbound email capture (2-way comms)** (docs/41): new §16.6. Customer replies to a deal email are captured back onto the deal timeline automatically — via the hidden reply-threading tag CRM-4 now embeds in outbound emails, or the sender's contact/lead email — and appear as inbound email activities on the deal page + Customer-360. Unmatched replies land in a **review queue** (`GET /api/crm/inbound/review`) to **Link** or **Dismiss**. The inbound webhook is HMAC-signed (forged deliveries rejected); capture never posts to the ledger. Added the `BAD_INBOUND_SECRET`/`INBOUND_UNVERIFIED` and `ALREADY_RESOLVED` error rows. |
| 1.2 | 2026-07-10 | **CRM-4 — sales automation** (docs/41): lead scoring (grade A–D, explainable/versioned breakdown), the follow-up center (SLA-breach / overdue-task / rotting-deal worklist, detective control **REV-22**) + round-robin assignment + the daily follow-up digest, pipeline events into the automation rules engine, and send email/LINE from a deal with merge fields (logged as an activity). |
| 1.1 | 2026-07-10 | **CRM-5 — analytics that answer "why"** (Module-Depth Uplift Wave 4): new §16.5 covering the funnel-conversion + time-in-stage velocity, source-ROI, and forecast-categories + quota + activity-leaderboard analytics (`/api/crm/pipeline/analytics/*`), each date-bounded and schedulable as the BI report types `crm_funnel` / `crm_source_roi` / `crm_forecast`. |
| 1.0 | 2026-07-10 | **CRM-2 — first release of the unified CRM workspace** (docs/41): `/crm` kanban board + list toggle, saved filter views, deal page with unified timeline + next-step, account page, leads import wizard, web-to-lead capture; `/pipeline` and `/projects/crm` now redirect here; member CRM 360 moved to `/crm/members`. |
| 1.1 | 2026-07-10 | **CRM-3 — Customer 360 panel on the account page** (docs/42): new §16.5. The account page now shows a read-only *see-the-money-before-you-call* panel that joins the company AR/credit position + last payments, the account's open deals + CPQ quotes, and the linked member's loyalty (tier/points/RFM/NPS/recovery) in one view (`GET /api/crm/customer-360/:accountNo`). Added the `ACCOUNT_NOT_FOUND` error row. |
