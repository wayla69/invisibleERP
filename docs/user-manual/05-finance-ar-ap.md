# 05 · Finance — Accounts Receivable & Payable

**Status: DRAFT v0.5 · 2026-07-06**

*v0.5 (2026-07-06): Part C — clarified that a **bank statement is imported single-user by
design** and that the **reconciliation certifier** must review the imported (matched/unmatched)
statement lines before sign-off, so a wrong/unauthorised import is caught at certification
(gap **G10** — documentation only, compensating detective control **REC-02**; no code change).*

*v0.4 (2026-07-06): Part C — a **newly created bank account** is now inactive /
PendingApproval and **cannot receive a deposit** (`BANK_NOT_APPROVED`) until a **different**
approver (`approvals`/`exec`) activates it (`POST /api/bank/accounts/:id/approve`);
self-approval is blocked (`SOD_VIOLATION`). Maker-checker gap G9 — strengthens control
**REC-05** (no new control), migration 0264.*

*v0.3: Part B3 — petty-cash **fund establishment (opening cash) and replenishment** now
raise a pending **funding request** that a second authorised user must approve before the
cash and GL post (self-approval blocked, `SOD_VIOLATION`); strengthens control EXP-08.*

This chapter is for **AR Clerks**, **AP Clerks** and **Procurement / finance**
staff. It covers customer invoices and receipts (AR), supplier bills and payments
(AP), aging analysis, and bank reconciliation.

**Main screen:** `/finance` — organised into **three PEAK-style cycle tabs** so each
job has its own focused screen instead of one long scroll:

- **ภาพรวม (Overview)** — the executive band: **KPI cards** (MTD / YTD revenue, AR
  outstanding **ลูกหนี้คงค้าง**, AP outstanding **เจ้าหนี้คงค้าง**), the **30-day revenue
  trend** (**แนวโน้มรายได้**), and the **AR-vs-AP aging composition** (**อายุหนี้คงค้าง**) —
  a stacked bar per book (*current* vs *1–30 / 31–60 / 61–90 / 90+ days*) with a colour
  legend, so an overdue-heavy book reads "red" at a glance.
- **รายรับ (AR)** — the receivables cycle: the **AR worklist**, **Sync AR** and **รับชำระ
  (receive payment)**, the **collections / dunning** worklist, and **AR aging** detail.
- **รายจ่าย (AP)** — the payables cycle for **Accounting** (`creditors`): the **AP
  worklist**, **บันทึกบิล (add bill)**, the per-bill **pay request**, and **AP aging**
  detail (with Excel export). *Approving and releasing* a payment is a **Finance** job
  and lives on its own screen, **จ่ายเงินเจ้าหนี้ (Disbursements)** (`/disbursements`),
  not on this tab — see Part B step B2.

The active tab is **deep-linkable** via `?tab=` (`/finance?tab=receivables`,
`?tab=payables`) — the **dashboard "สิ่งที่ต้องทำวันนี้" action cards** (pending payment
requests, overdue receivables) link straight to the right tab. Each page reflows to a
single column on phones/tablets.

---

## Part A — Accounts Receivable (money customers owe you)

**Required permission:** `ar` (held by *ArClerk*, *Admin*)

### A1. Create invoices from orders

1. On the **รายรับ (AR)** tab, run **Sync AR** (creates invoices from *Shipped* /
   *Completed* orders).
2. **Expected result:** Invoices (e.g. `INV-…`) are created and the sale, revenue
   and output VAT are posted to the ledger automatically.

### A1b. Print or email a billing invoice (ใบแจ้งหนี้/ใบวางบิล)

On any invoice row in the **AR worklist**, two actions sit next to **รับชำระ**:

- **🖨️ พิมพ์ / เปิด PDF** — opens the billing invoice as a PDF in a new tab (บริษัทของคุณ +
  the customer + the ordered lines + amount billed / paid / **คงเหลือค้างชำระ**). Use your
  browser to print or save it.
- **✉️ ส่งอีเมล** — sends the invoice **as a PDF attachment**. You'll be prompted for the
  recipient — **leave it blank to use the customer's email on file** (from the customer master);
  type an address to override it. (Requires the shop's mail account to be configured; until then
  you'll see *ยังไม่ได้ตั้งค่าอีเมล* — ask your admin to set SMTP. If no address is on file **and**
  you leave the prompt blank, you'll be asked to enter one.)

> This billing invoice (ใบแจ้งหนี้/ใบวางบิล) is **for collection**, not a tax document — it is
> **not** the ใบกำกับภาษี. Issue the statutory tax invoice from **ภาษี ▸ ใบกำกับภาษี** as before.
> Printing/emailing here changes nothing and posts nothing to the ledger.

### A2. Record a customer receipt (payment in)

1. On the **AR** table, find the invoice and click **Receive payment**
   (**รับชำระ**).
2. Enter the **amount**, **method** (e.g. Transfer) and a **reference number**.
3. Save.

**Expected result:** A receipt (e.g. `RCP-…`) is recorded; the invoice status
moves **Unpaid → Partial → Paid**, and the cash / AR entries post to the ledger.

> **Print / email the receipt voucher (ใบสำคัญรับเงิน):** the **ใบสำคัญรับเงินล่าสุด** list on the
> **รายรับ (AR)** tab shows recent receipts, each with a **🖨️ พิมพ์** and **✉️ ส่งอีเมล** action
> (email defaults to the customer's email on file when left blank). Or call
> `GET /api/finance/ar/receipts/{RCP-…}/pdf` / `POST …/send-email` directly. (This is the AR
> cash-receipt voucher — distinct from the POS sales receipt.)

[screenshot: AR receipt dialog]

### A3. AR aging

1. On the **รายรับ (AR)** tab, scroll to the **AR aging** section.
2. Review balances in buckets: **Current / 1–30 / 31–60 / 61–90 / 90+ days**.

**Expected result:** You can see which customers are overdue and by how much.

### A3a. Customer statement of account (การ์ดลูกหนี้)

**Screen:** การ์ดลูกหนี้ (`/finance/customers`, ERP nav → การเงิน → AR/AP) ·
**Required permission:** `ar` or `exec`.

Open **การ์ดลูกหนี้** to see the list of customers with an open balance (their outstanding
exposure, worst days-overdue, and a *ระงับเครดิต* badge for anyone on hold). **Click a customer**
to drill into their statement of account; set the **date range** and export it as **CSV**,
**PDF** (🖨️), or **email** it to the customer (✉️) as a PDF attachment
(`GET /api/finance/ar/statement?tenant_id=&from=&to=`; the **PDF/email** actions use
`…/statement/pdf` and `…/statement/send-email`). The **vendor statement** on
**การ์ดเจ้าหนี้** (`/finance/vendors`) has the same Print/Email actions.

**Expected result:** A statement showing the **opening balance** (as of the start
date), every **invoice** (charge) and **receipt** (payment) in date order with a
**running balance**, and the **closing balance**. It's built from the same posted
AR data as the aging view.

> **Multi-currency:** each document keeps its own currency and booked exchange rate.
> By default the statement reports in **base THB** (each foreign document converted at
> its rate); add **`?currency=USD`** to see only that currency's documents in their
> own units.

### A4. Collections & dunning (chasing overdue invoices)

The **collections worklist** shows every open invoice with its age, the dunning
stage already reached, and the **next recommended step**. The dunning ladder
escalates with age:

| Days overdue | Recommended stage |
|---|---|
| 1–15 | reminder |
| 16–30 | first notice |
| 31–60 | second notice |
| 61–90 | final notice |
| 90+ | legal |

1. On the **รายรับ (AR)** tab, scroll to **ติดตามหนี้ค้างชำระ (Collections)**. The worklist
   lists open overdue invoices (oldest first) with the **current stage** and the
   **recommended** next stage (highlighted when an escalation is due).
2. Contact the customer, then click **ทวงถาม (Record dunning)** on the row: it
   pre-selects the recommended **stage** — confirm or change it, pick the **channel**
   (email / phone / letter / sms), and optionally add a **promise-to-pay date** and
   notes.
3. **Expected result:** A dunning record (`DUN-…`) is saved and the invoice's
   **current stage** advances. **The reminder is also sent to the customer** — an
   email/SMS with the invoice number, amount overdue, days late and an escalating
   message (the `legal` stage is a final demand) — using the email/phone on the
   **customer's master record**. The toast confirms delivery (e.g. "ส่งแจ้งเตือนแล้ว").
   *Phone* / *letter* channels are just logged as a manual contact (nothing is sent).
   If the customer has no email/phone on file, the action is still recorded but the
   send is marked failed. The full history (incl. delivery status) is the audit trail.
   (Recording an action against an already-paid invoice returns `ALREADY_PAID`.)

> **Print / email a formal dunning letter (หนังสือทวงถามหนี้):** on the worklist row, the
> **🖨️ พิมพ์หนังสือทวงถาม** action opens a formal collection letter (PDF) built from the
> latest dunning action — the customer, the invoice, the amount overdue, days late and
> stage-appropriate wording (the `legal` rung reads as a final demand). `POST
> …/collections/{invoice}/dunning-letter/send-email {to_email}` emails it as a PDF.
> This only prints/sends a letter — the dunning *action* is still recorded in step 2.

#### Run dunning automatically

Click **ทวงถามอัตโนมัติ (Run sweep)** at the top of the Collections section (or call
`POST /api/finance/ar/collections/sweep` from a scheduler). The sweep records the
**recommended** dunning action on every overdue invoice that has fallen behind its
stage **and sends each reminder** (auto-picking email, else SMS, from the customer's
contact) — marked as system-actioned.

**Expected result:** The button reports how many invoices it advanced. Running it
again right away advances **nothing** (it's idempotent — no customer gets dunned
twice for the same stage until aging moves them to the next rung).

**To run it every night automatically:** create a **daily scheduled job** of type
**Automated AR dunning** (`ar_collections_dunning`) under Reports → Scheduled reports
(`POST /api/bi/subscriptions {report_type:'ar_collections_dunning', frequency:'daily'}`).
The scheduler then fires the sweep on its daily tick, logs each run, and notifies you
of how many invoices it advanced — no manual button press needed.

#### Credit status & credit hold

- **Check a customer's credit** (`GET /api/finance/ar/credit-status?tenant_id=…`):
  shows their **credit limit**, current **exposure** (open AR), **overdue** amount,
  **available credit**, and an **on-hold** flag. A customer goes **on hold** when
  they are **over their limit** or have invoices **90+ days** past due.
- **Order entry** consults the same decision (`POST /api/finance/ar/credit-check`)
  before extending further credit — a held customer is declined with reason
  `CREDIT_LIMIT_EXCEEDED`, `SERIOUS_OVERDUE`, or `WOULD_EXCEED_LIMIT`.
- **This hold is enforced directly at the till and portal:** creating a credit
  order (POS or customer self-service) for a customer **90+ days overdue** is
  blocked with `CREDIT_OVERDUE` — even if they're under their limit — using the
  same 90-day threshold as the collections hold above.

#### Credit-manager workflow (manual hold / release / limit change)

Beyond the automatic over-limit / overdue holds, a *Credit Manager* can take direct
action on an account. Every action is written to a **credit-events audit trail**
(`GET /api/finance/ar/credit-events?tenant_id=…`).

- **Place a manual hold** (`POST /api/finance/ar/credit-hold {tenant_id, reason}`):
  flags the customer **on hold** regardless of their limit/aging. `credit-check`
  then declines new credit with reason **`CREDIT_HOLD`**, and the hold reason is
  surfaced on the credit-status view.
- **Release a hold** (`POST /api/finance/ar/credit-release {tenant_id}`): clears the
  hold. An account that isn't on hold returns `NOT_ON_HOLD`.
- **Request a credit-limit change** (`POST /api/finance/ar/credit-limit {tenant_id,
  new_limit, reason}`): this **no longer changes the limit on its own** — it **stages a
  pending request** (you get back a `req_no` and `status: PendingApproval`) and logs
  the requested old → new value. The customer's ceiling does **not** move yet.
- **Approve (or reject) the pending change** — a **second authorised user** (`approvals`
  / `exec`), who must be **different from the requester**, works the **Pending
  credit-limit approvals** queue on the `/finance/credit-hold` screen and clicks
  **Approve** (`POST /api/finance/ar/credit-limit/:reqNo/approve`) or **Reject**
  (`…/:reqNo/reject`). **Only on approval** does the new limit take effect; the audit
  entry then flips to *Approved* and records who approved it and when. If the requester
  tries to approve their own change it is blocked with `SOD_VIOLATION`.

> **Note — separation of duties:** the **credit limit** is master data maintained by
> the *Credit Manager*, kept separate from order entry, so nobody can raise a limit
> and then sell against it (rule R09). Both a **credit-limit change** and a **hold
> release** now require **two people**: the user who *requests* a limit change cannot
> approve it themselves (`SOD_VIOLATION`), and the user who *placed* a hold cannot lift
> their own hold (`SOD_SELF_RELEASE`) — each takes a second approver (`approvals` /
> `exec`), so a single person can't both raise/block and apply/unblock an account.

### A5. Allowance for doubtful accounts (provision for bad debts)

**Required permission:** `creditors` / `ar` / `gl_post` / `exec`.

At period-end you set aside a **provision for the receivables you expect not to
collect** (an *allowance for doubtful accounts*), so AR on the balance sheet is shown
at the amount you realistically expect to receive — without writing off any specific
invoice yet.

1. **Compute the allowance** (`POST /api/finance/ar-allowance/compute`). The system
   ages your open AR into buckets (**current / 1–30 / 31–60 / 61–90 / 91–120 / 120+
   days**) and applies a **loss rate** to each (defaults **0% / 1% / 5% / 20% / 50% /
   100%** — older debt is more likely to go bad). The **allowance** is the sum of
   `outstanding × rate`. You can override the rates, choose an `as_of_date`, or use a
   flat **percentage** of total AR instead. This produces an **unposted** draft — it
   does not touch the GL yet.
2. **A different person posts it** (`POST /api/finance/ar-allowance/:id/post`). The
   person who computed the allowance **cannot** post it (`SOD_SELF_POST`) — a second
   reviewer does, so nobody can quietly inflate or shrink the provision to manage the
   numbers. Posting books only the **change since the last posted allowance**: if the
   provision went up it posts **Dr Bad Debt Expense (5720) / Cr Allowance (1190)**; if
   it went down it reverses. Your gross AR (1100) is never touched — the allowance sits
   in a separate contra-asset account (**1190**) that nets against AR on the balance
   sheet.
3. **Review the register** (`GET /api/finance/ar-allowance`) — every computation with
   its buckets, allowance and posted amount.

> A posted allowance can't be posted twice (`ALLOWANCE_POSTED` / `ALREADY_POSTED`); to
> revise, compute a fresh allowance for a later date. Posting into a **hard-closed**
> period is blocked (`PERIOD_LOCKED`). This is the **allowance** (an estimate across all
> AR); writing off a **specific** uncollectible invoice is the separate maker-checker
> **bad-debt write-off** (Dr 5720 / Cr 1100).

---

## Part B — Accounts Payable (money you owe suppliers)

**Required permission:** `creditors` (held by *ApClerk*, *Admin*)

> **Note — employee reimbursements & maintenance show up here too.** When a manager
> approves an **employee expense claim** (Employee Self-Service) or a **maintenance
> work order** is completed with a vendor cost, the system raises an **AP payable**
> automatically (`AP-…`, payee shown as the employee or the vendor). It appears in
> the AP list and aging like any supplier bill and is settled with the same **Pay**
> action below — no separate reimbursement run needed.

### B1. Record a supplier bill

1. On the **รายจ่าย (AP)** tab (or `/creditors`), click **บันทึกบิลเจ้าหนี้ (Add bill)**
   (creates `AP-…`).
2. Enter the supplier, amount, due date, and the **VAT treatment** (standard 7%,
   exempt or zero-rated).
3. Save.

**Expected result:** The bill is recorded; expense and input VAT post to the
ledger, with the balance owed to the supplier.

### B2. Pay a supplier — request, then approve (maker-checker)

Paying a supplier is a **two-step** flow split across **two teams and two screens**, so
that no single person both records and pays a bill (SOX control **EXP-06**):
**Accounting** books the bill and requests payment; **Finance** approves and releases
the cash.

**Step 1 — request payment (Accounting / AP Clerk, `creditors`, on `/finance`):**
1. On the **รายจ่าย (AP)** tab of **การเงิน** (`/finance`), find the bill in the **AP**
   list.
2. Click **Pay** (**ขอจ่ายเจ้าหนี้**), enter the amount, and click **Send payment
   request** (**ส่งคำขอจ่าย**).

**Expected result:** A payment request is created and shown as **awaiting approval**
(**รออนุมัติ**). **No money moves yet** — the bill stays Unpaid and nothing posts to
the ledger until a different person approves.

> **3-way-match gate (EXP-09).** For a bill tied to a **purchase order**, the request
> is refused (**`MATCH_BLOCKED`**) if the invoice hasn't passed its 3-way match (PO ↔
> goods receipt ↔ invoice within tolerance) and hasn't been independently overridden —
> so you can't pay for goods at the wrong quantity or price, or that were never
> received. Resolve the variance (correct the receipt/invoice, or get an independent
> override) on `/procurement/match`, then request the payment again. **Non-PO bills**
> (utilities, services, reimbursements) have no match and pay normally.

**Step 2 — approve / release (Finance, `approvals` or `gl_close`, on `/disbursements`):**
1. Open **จ่ายเงินเจ้าหนี้ (Disbursements)** (`/disbursements`, ERP nav → การเงิน →
   รายรับ–รายจ่าย) — the finance-owned pending-payment queue. (You can also jump here
   from the dashboard **คำขอจ่ายรออนุมัติ** action card.) This screen is **separate
   from the accounting AP screen** so the team that books bills is not the team that
   releases cash.
2. Review the request and click **อนุมัติจ่าย** (approve) or **ปฏิเสธ** (reject).

**Expected result on approval:** The bill is settled (Unpaid → Partial → Paid) and the
cash-disbursement entry posts to the ledger. On rejection nothing posts.

> **Note — you cannot approve your own request:** The approver must be a **different**
> user from the requester — even an Admin is blocked with `SOD_VIOLATION` (control
> **EXP-06**, rules R03/R07). A bill also **cannot be booked already-paid** in one
> step (`AP_PREPAID_BLOCKED`).

> **Note — payment blocked by 3-way match:** If the bill has **not passed the
> 3-way match** you'll see `MATCH_BLOCKED` and cannot request payment. Resolve the
> match first (or have an authorised user override it with a reason). See
> [Procurement](./03-procurement.md).

> **Note — separation of duties:** Whoever **raises a purchase** should not also
> **pay** the supplier (rules R02/R03). The system enforces this.

### B3. AP aging

1. On the **รายจ่าย (AP)** tab, scroll to **วิเคราะห์อายุเจ้าหนี้ (AP Aging)** (with an
   **Excel export**).
2. Review what you owe in buckets: **Current / 1–30 / 31–60 / 61–90 / 90+ days**.

**Expected result:** You can plan payments and avoid late fees.

[screenshot: AP list with Pay action and aging]

### B4. Vendor statement of account (การ์ดเจ้าหนี้)

**Screen:** การ์ดเจ้าหนี้ (`/finance/vendors`, ERP nav → การเงิน → AR/AP) ·
**Required permission:** `creditors` or `exec`.

Open **การ์ดเจ้าหนี้** to see the list of vendors with an open balance (outstanding, worst
days-overdue, open-bill count). **Click a vendor** to drill into their statement, set the **date
range**, and export CSV (`GET /api/finance/ap/statement?vendor=&from=&to=`).

**Expected result:** A statement with the **opening balance**, every **bill**
(charge) and approved **payment** in date order with a **running balance**, and the
**closing balance** — reconcile it to the supplier's own statement before you pay.
Like the customer statement it is **multi-currency**: base THB by default, or add
**`?currency=USD`** for that currency's documents in their own units.

---

## Part B2 — Petty cash / employee advances

**Screen:** `/advances` (**เงินทดรองจ่าย**, ERP nav → การเงิน) · **Required
permission:** `creditors` (held by *ApClerk*, *Admin*).

When you give an employee cash up front (a site-visit float, travel money), record
it as an **advance** so the cash is tracked until it's accounted for.

Open the **Petty Cash** screen (`/advances`) to see the **register** of every advance
with its status, who it was issued to, and — most importantly — the **outstanding
float** (total cash still uncleared) as a KPI. The **ทะเบียน** tab lists them (filter
by *open* / *settled*); each open advance has a **เคลียร์ (settle)** action; the
**เบิกเงินทดรอง** tab issues a new one.

1. **Issue the advance** (`POST /api/finance/advances` — payee, amount, purpose).
   This posts **Dr Employee Advances (1180) / Cr Cash (1000)** and the advance shows
   as **open**. The 1180 balance is your **outstanding float**.
2. **Settle it** when the employee reports back
   (`POST /api/finance/advances/{advanceNo}/settle`): enter the **actual spend** and
   any **cash returned**. The two **must add up to the advance** — otherwise it's
   rejected (`SETTLE_MISMATCH`). This posts the spend to the expense account and
   clears the advance (the 1180 float returns to zero for that advance).

**Expected result:** Every advance is either **open** (still on 1180) or **settled**
(fully accounted for). `GET /api/finance/advances` lists them with the total
outstanding. Settling an already-settled advance → `ALREADY_SETTLED`.

---

## Part B3 — Petty cash funds, direct expenses & advances with approval (EXP-08)

**Screen:** `/petty-cash` (**กองทุนเงินสดย่อย & ค่าใช้จ่าย**, ERP nav → การเงิน) ·
**Required permission:** `creditors` / `exec`.

This is the controlled way to run a **petty-cash fund** with a spending limit and a
**two-person sign-off** on every payout — use it when a branch or department holds a
cash float and pays small expenses or staff advances from it.

### Open a fund and set its limit (วงเงิน) — funding needs a second person

On the **กองทุน (Funds)** tab, create a fund with a **float limit** (the most cash it
may ever hold) and an optional **starting amount**. The fund opens with a **zero
balance**: setting a starting amount does **not** put cash in straight away — it raises
a **pending funding request** that a **second authorised user** (`creditors` / `exec`,
**different from you**) must approve on the **อนุมัติ (Maker-checker)** tab. Only on
their approval does the cash post **Dr Petty Cash (1015) / Cr Cash (1000)** and the
balance rise. **เติมเงิน (Replenish)** tops a fund back up the **same way** — a pending
funding request that a second person approves before the cash posts. You can never
request more than the float (`OVER_FLOAT`), and **you cannot approve your own funding
request** (`SOD_VIOLATION`). So no single person can put cash into a fund: the fund
holds no cash until an independent approval.

### Open a direct expense or an advance — then a *different* person approves

On the **เปิดค่าใช้จ่าย / เบิกล่วงหน้า** tab choose the **fund**, the **type**
(**ค่าใช้จ่ายโดยตรง** = direct expense, or **เงินเบิกล่วงหน้า** = advance), the **amount**,
the **payee**, and a **document/receipt number** (for the audit trail). Submitting
**posts nothing yet** — the request is **รออนุมัติ (PendingApproval)**, and a draw can't
exceed the fund's balance (`INSUFFICIENT_FLOAT`).

A **different** person opens the **อนุมัติ (Maker-checker)** tab and clicks **อนุมัติ
(Approve)** — only then does the accounting post and the fund balance drop:

- **direct expense →** Dr the expense account / Cr Petty Cash (1015);
- **advance →** Dr Employee Advances (1180) / Cr Petty Cash (1015).

The same **อนุมัติ (Maker-checker)** tab also holds the **funding requests** raised when
you establish a fund with a starting amount or **replenish** one — approving those posts
**Dr Petty Cash (1015) / Cr Cash (1000)** and lifts the fund balance (still `SOD_VIOLATION`
if you approve your own).

### Raise a request from LINE chat (LC-2)

If you've linked your LINE account (see [Procurement — LINE chat](./03-procurement.md)),
you can **raise** a request without opening the ERP: type
`expense <รหัสกองทุน> <จำนวนเงิน> [เหตุผล]` (e.g. `expense PCF-01 300 ค่าน้ำแข็งหน้าร้าน`)
or `advance <รหัสกองทุน> <จำนวนเงิน> [เหตุผล]` in the shop's LINE OA chat. Same rules as
the screen: you need `creditors`/`exec`, the fund must be active, and a draw beyond the
balance is refused (`INSUFFICIENT_FLOAT`). Other approvers get a LINE 🔔 when your request
lands, and you get a ✅/❌ push when it's decided — but **approval itself always happens on
`/petty-cash`** (money decisions are deliberately not available in chat).

You can also let the **AI copilot draft** the request from free Thai — e.g.
`บอท ขอเบิก 250 จาก PCF-01 ค่าน้ำแข็ง` (LP-2). The bot replies with a draft card and a
**confirm button**; nothing is raised until you tap it, and the confirmed draft runs the
ordinary `expense`/`advance` command under your own permissions — same maker-checker,
same float guards. If the bot isn't sure, it says so instead of guessing.

**You cannot approve your own request** (`SOD_VIOLATION`, binds **everyone, including
Admin**). **ปฏิเสธ (Reject)** discards it. Pending requests also show up in the
**Approvals** dashboard (`/finance` → approvals) so nothing sits unseen.

### Settle an advance

When the employee reports back, the advance row (now **อนุมัติแล้ว**) has a **เคลียร์
(settle)** action: enter the **actual spend** and **cash returned to the fund** — they
must add up to the advance (`SETTLE_MISMATCH`) — which posts the spend to the expense
account, returns the unused cash to the fund (Dr 1015), and clears the advance (Cr 1180).

**Expected result:** the fund's cash is always within its limit, every payout was
approved by a second person, and each request carries its receipt and a full status
trail (รออนุมัติ → อนุมัติแล้ว/ปฏิเสธ → เคลียร์แล้ว).

---

## Part C — Bank reconciliation

**Screen:** `/reconciliation` · **Required permission:** `recon_prep` to prepare;
`approvals` to certify.

> **Note — separation of duties:** The person who **prepares** a reconciliation
> must **not** be the one who **certifies** it (rule R06).

> **A newly created bank account needs a second person's OK before it can take
> money.** When you set up a **new bank account** (its account number, the GL
> account it maps to, and any opening balance), it starts **inactive / รออนุมัติ
> (PendingApproval)** and **cannot receive a deposit** — banking cash into it is
> refused with **BANK_NOT_APPROVED** — until a **different** person with approval
> authority (**Approvals** or **Exec**) activates it (`POST
> /api/bank/accounts/:id/approve`; **Reject** discards it). The person who created
> the account **cannot approve their own** (the system blocks it with
> **SOD_VIOLATION**). This stops one person quietly standing up a bank account with a
> wrong account number, GL mapping or opening balance and banking cash through it.
> (Existing accounts are already Approved — this only affects accounts created from
> now on. Strengthens control **REC-05**.)

### To reconcile a bank account

1. Go to **Reconciliation** (`/reconciliation`).
2. **Open** a reconciliation period: choose the account (e.g. `1010` bank) and the
   month (`YYYY-MM`).
3. **Import GL** lines into the reconciliation.
4. Add any manual items (subledger entries, adjustments) with references.
5. Run **Auto-match** to pair GL entries with bank entries.
6. Review the **summary**: GL balance, statement balance, and any unmatched items.

**Expected result:** Matched items clear; the unmatched list shows what still
needs investigating.

### To certify (approver)

1. Once balanced, open the period and click **Certify** (**รับรองกระทบยอด**).

**Expected result:** The period is marked *Certified*. (You cannot certify a
reconciliation you prepared yourself.)

> **Before you certify, review the imported statement lines.** A **bank statement is
> imported by a single user** (this is fine by design — the imported lines only
> matter once they're *matched*). Your certification is the control that catches a
> wrong or unauthorised import: as the certifier, **review the matched and unmatched
> statement lines** before you sign off, and treat any adjustment (bank fees /
> interest) as a separately-approved item (**BANK-02**). Signing off on lines you
> haven't reviewed is what defeats the control. (Gap **G10** — the statement import
> is single-user by design; the certifier's evidence review is the compensating
> detective control, **REC-02**.)

## Financial health (how healthy is my working capital?)

Open **สุขภาพการเงิน (Financial health)** in the Finance menu (`/financial-health`).
It gives you a single **health score out of 100 (grade A–E)** of how comfortable your
cash position is — built from your **current cash** (from the ledger), **money owed to
you** (receivables) vs **money you owe** (payables), how much of your receivables is
**overdue**, and your **daily POS sales**. It shows the drivers behind the score —
roughly **how many days of cash** you have on hand and your **current ratio** — so you
can see *why* it's high or low. (For the week-by-week cash *projection*, use the
**Statement of Cash Flows / forecast** in the ledger reports.) You can also just ask
the **AI assistant** — *"สุขภาพการเงินเป็นยังไง?"*

---

**Next:** [General Ledger](./06-general-ledger.md) · [Tax](./07-tax.md) ·
[Procurement](./03-procurement.md)
