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

1. Open the **Collections** view (worklist endpoint `GET /api/finance/ar/collections`).
   The oldest / largest overdue invoices sort to the top.
2. Contact the customer, then click **Record dunning action** on the invoice: pick
   the **stage**, the **channel** (email / phone / letter / sms), and optionally a
   **promise-to-pay date** and notes.
3. **Expected result:** A dunning record (`DUN-…`) is saved and the invoice's
   **current stage** advances; the full history is kept as the collections audit
   trail. (Recording an action against an already-paid invoice returns
   `ALREADY_PAID`.)

#### Credit status & credit hold

- **Check a customer's credit** (`GET /api/finance/ar/credit-status?tenant_id=…`):
  shows their **credit limit**, current **exposure** (open AR), **overdue** amount,
  **available credit**, and an **on-hold** flag. A customer goes **on hold** when
  they are **over their limit** or have invoices **90+ days** past due.
- **Order entry** consults the same decision (`POST /api/finance/ar/credit-check`)
  before extending further credit — a held customer is declined with reason
  `CREDIT_LIMIT_EXCEEDED`, `SERIOUS_OVERDUE`, or `WOULD_EXCEED_LIMIT`.

> **Note — separation of duties:** the **credit limit** is master data maintained by
> the *Credit Manager*, kept separate from order entry, so nobody can raise a limit
> and then sell against it (rule R09).

---

## Part B — Accounts Payable (money you owe suppliers)

**Required permission:** `creditors` (held by *ApClerk*, *Admin*)

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
