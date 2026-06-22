# 06 · General Ledger

**Status: DRAFT v0.1**

This chapter is for **accountants** — *GlAccountant*, *FinancialController* and
*Admin*. It covers the chart of accounts, manual journal entries with
**maker-checker approval**, the trial balance and financial statements, period and
year-end close, multi-ledger reporting, and fixed assets.

**Main screen:** `/accounting` — tabs include Trial Balance, Journal, Pending
journal entries, Income Statement, Balance Sheet and Opening Balances.

---

## 1. Chart of accounts

**Required permission:** any signed-in finance user (read).

The chart of accounts (COA) is the list of all ledger accounts, for example:

| Code | Account |
|------|---------|
| 1000 | Cash |
| 1010 / 1020 | Bank accounts |
| 1100 | Accounts Receivable |
| 1200 | Inventory |
| 1500 / 1590 | Fixed Assets / Accumulated Depreciation |
| 2000 | Accounts Payable |
| 2100 | Tax Payable |
| 3100 | Retained Earnings |
| 4000 | Sales Revenue |
| 5000 / 5100 / 5200 | COGS / Operating Expense / Depreciation |

View the full list on the **Trial Balance** / accounts view.

---

## 2. Manual journal entries with maker-checker approval

A manual journal entry (JE) is a direct accounting entry. To prevent error and
fraud, **every manual JE must be approved by a different person** before it
affects the books.

> **Note — maker-checker (the key control):**
> - The **preparer** (permission `gl_post`, e.g. *GlAccountant*) creates the JE.
>   It is saved as a **Draft** and **does not yet affect** the trial balance or
>   financial statements.
> - A **different** approver (permission `gl_close` or `approvals`, e.g.
>   *FinancialController*) must approve it.
> - **You cannot approve your own journal entry** — the system blocks this as a
>   segregation-of-duties violation (rule R05, `SOD_VIOLATION`).

### To create a journal entry (preparer)

1. Go to **Accounting** (`/accounting`) → **Journal** tab.
2. Click **New journal entry**.
3. Add lines: for each, choose the account and enter a **Debit** *or* **Credit**
   amount. Add a memo / description.
4. Make sure **total debits = total credits**.
5. Save / submit.

**Expected result:** The entry is created as **Draft** (e.g. `JE-…`), awaiting
approval. Drafts are excluded from balances.

> **Note:** If debits and credits don't balance (or there are no lines) the entry
> is rejected (`UNBALANCED`).

### To approve or reject a journal entry (approver)

1. Go to **Accounting** → **Pending** tab (pending journal entries).
2. Open a draft entry and review the lines.
3. Click **Approve** (**✓ อนุมัติ**) to post it, or **Reject** (**✗ ไม่อนุมัติ**)
   with a reason.

**Expected result:** On approve, the entry posts (Draft → **Posted**) and now
affects the trial balance and statements. On reject, it is voided and the reason
is recorded.

> **Note:** The period must be **open** when you approve. Approving into a closed
> period is blocked (`PERIOD_CLOSED`).

[screenshot: pending journal entry approval screen]

---

## 3. Trial balance & financial statements

**Required permission:** finance read (e.g. `fin_report`).

| Report | Screen tab | Shows |
|--------|-----------|-------|
| **Trial Balance** (**งบทดลอง**) | Trial Balance | Every account's debit/credit balance |
| **Income Statement / P&L** (**งบกำไรขาดทุน**) | Income Statement | Revenue − Expense = Net Income, for a date range |
| **Balance Sheet** (**งบดุล**) | Balance Sheet | Assets = Liabilities + Equity, as of a date |

To run a report: open the relevant tab, set the **period / date range** (and cost
centre or ledger if needed), and view or export it.

**Expected result:** The statement is produced from all **posted** entries (drafts
are excluded).

---

## 4. Period & year-end close

**Required permission:** `gl_close` (held by *FinancialController*, *Admin*).

> **Note — separation of duties:** Period close is restricted to a finance
> approver who is **distinct from** the people who prepare journal entries (rule
> R05).

### To close an accounting period

1. Go to the **Periods** view.
2. Find the period (`YYYY-MM`) and click **Close** (**ปิดงวด**).

**Expected result:** The period is closed. New postings to it are blocked with
`PERIOD_CLOSED`. (If you must post a late entry, an authorised user can **reopen**
the period, post, and close it again.)

### To run year-end close

1. Open the **Close Year** action and choose the fiscal year.
2. Confirm.

**Expected result:** Profit & loss accounts are zeroed into **Retained Earnings
(3100)** and all twelve periods are closed. The operation is safe to re-run.

---

## 5. Multi-ledger (TFRS / TAX / IFRS)

Invisible ERP keeps **parallel ledgers** so you can report under different
accounting bases:

- **TFRS** — the leading, statutory book (default). Entries with no ledger
  specified apply to all books.
- **TAX** — Thai Revenue Department basis (e.g. different depreciation / timing).
- **IFRS** — group consolidation basis.

### To post a basis-only adjustment

1. Create the adjustment against **one ledger only** (e.g. a tax-depreciation
   difference on the TAX ledger).

**Expected result:** Only that ledger diverges; shared entries stay identical
across books. Use the **GAAP comparison** view to see book-vs-tax differences (for
deferred tax).

---

## 6. Fixed assets & depreciation

**Screen:** `/assets` · **Required permission:** `exec` / `creditors` (finance).

Tabs: Register, QR Tags, Categories, Depreciation Runs.

### Acquire an asset

1. Go to **Assets** (`/assets`) → **Register**.
2. Click **Add asset**: name, category, **cost**, acquisition date, **useful life
   (months)**.
3. Save.

**Expected result:** The asset is registered and the purchase posts to the ledger
(Dr Fixed Assets / Cr Cash).

### Run monthly depreciation

1. Go to **Depreciation Runs**.
2. Click **Run depreciation** for the period.

**Expected result:** Straight-line depreciation is calculated and posted
(Dr Depreciation Expense / Cr Accumulated Depreciation). Re-running the same period
is safe.

### Dispose of an asset

1. Open the asset and click **Dispose**: enter the disposal date and any proceeds.
2. Confirm.

**Expected result:** The asset is removed from active use and any gain / loss is
posted.

> **Note:** Print **QR labels** from the QR Tags tab and use **scan-update** to
> record an asset's location or assigned holder during a physical asset count.

[screenshot: asset register with depreciation schedule]

---

**Next:** [Tax](./07-tax.md) · [Finance — AR & AP](./05-finance-ar-ap.md) ·
[Approvals](./10-approvals.md)
