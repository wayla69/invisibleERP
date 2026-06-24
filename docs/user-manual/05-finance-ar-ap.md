# 05 · Finance — Accounts Receivable & Payable

**Status: DRAFT v0.1**

This chapter is for **AR Clerks**, **AP Clerks** and **Procurement / finance**
staff. It covers customer invoices and receipts (AR), supplier bills and payments
(AP), aging analysis, and bank reconciliation.

**Main screen:** `/finance` — the Finance dashboard shows MTD/YTD revenue,
AR outstanding (**ลูกหนี้คงค้าง**) and AP outstanding (**เจ้าหนี้คงค้าง**), with
tables and aging.

---

## Part A — Accounts Receivable (money customers owe you)

**Required permission:** `ar` (held by *ArClerk*, *Admin*)

### A1. Create invoices from orders

1. On `/finance`, run **Sync AR** (creates invoices from *Shipped* / *Completed*
   orders).
2. **Expected result:** Invoices (e.g. `INV-…`) are created and the sale, revenue
   and output VAT are posted to the ledger automatically.

### A2. Record a customer receipt (payment in)

1. On the **AR** table, find the invoice and click **Receive payment**
   (**รับชำระ**).
2. Enter the **amount**, **method** (e.g. Transfer) and a **reference number**.
3. Save.

**Expected result:** A receipt (e.g. `RCP-…`) is recorded; the invoice status
moves **Unpaid → Partial → Paid**, and the cash / AR entries post to the ledger.

[screenshot: AR receipt dialog]

### A3. AR aging

1. On `/finance`, open the **AR aging** view.
2. Review balances in buckets: **Current / 1–30 / 31–60 / 61–90 / 90+ days**.

**Expected result:** You can see which customers are overdue and by how much.

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

1. On `/finance`, scroll to **ติดตามหนี้ค้างชำระ (Collections)**. The worklist lists
   open overdue invoices (oldest first) with the **current stage** and the
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

> **Note — separation of duties:** the **credit limit** is master data maintained by
> the *Credit Manager*, kept separate from order entry, so nobody can raise a limit
> and then sell against it (rule R09).

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

1. On `/creditors` (or `/finance` → AP), click **Add bill** (creates `AP-…`).
2. Enter the supplier, amount, due date, and the **VAT treatment** (standard 7%,
   exempt or zero-rated).
3. Save.

**Expected result:** The bill is recorded; expense and input VAT post to the
ledger, with the balance owed to the supplier.

### B2. Pay a supplier

1. Find the bill in the **AP** list.
2. Click **Pay** (**จ่ายเจ้าหนี้**) and confirm the payment.

**Expected result:** The bill is settled (Unpaid → Partial → Paid) and the
payment posts to the ledger.

> **Note — payment blocked by 3-way match:** If the bill has **not passed the
> 3-way match** you'll see `MATCH_BLOCKED` and cannot pay it. Resolve the match
> first (or have an authorised user override it with a reason). See
> [Procurement](./03-procurement.md).

> **Note — separation of duties:** Whoever **raises a purchase** should not also
> **pay** the supplier (rules R02/R03). The system enforces this.

### B3. AP aging

1. On `/finance`, open the **AP aging** view.
2. Review what you owe in buckets: **Current / 1–30 / 31–60 / 61–90 / 90+ days**.

**Expected result:** You can plan payments and avoid late fees.

[screenshot: AP list with Pay action and aging]

---

## Part C — Bank reconciliation

**Screen:** `/reconciliation` · **Required permission:** `recon_prep` to prepare;
`approvals` to certify.

> **Note — separation of duties:** The person who **prepares** a reconciliation
> must **not** be the one who **certifies** it (rule R06).

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

---

**Next:** [General Ledger](./06-general-ledger.md) · [Tax](./07-tax.md) ·
[Procurement](./03-procurement.md)
