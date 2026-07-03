# 06 · General Ledger

**Status: DRAFT v0.4 · 2026-07-03**

This chapter is for **accountants** — *GlAccountant*, *FinancialController* and
*Admin*. It covers the chart of accounts, manual journal entries with
**maker-checker approval**, the trial balance and financial statements, period and
year-end close, multi-ledger reporting, and fixed assets.

**Main screen:** `/accounting` (perm: `gl_post`, `gl_close`, `approvals`, `exec`, `creditors`, `ar`) — tabs include Trial Balance, Journal, Pending journal entries (visible to `approvals`/`gl_close`/`exec` only — SoD R05), Income Statement, Balance Sheet, Cash Flow and Opening Balances.

> **SoD R05 — posting vs. JE approval:** The "รออนุมัติ (JE)" tab on `/accounting` is only visible to users who hold the **approval** duty (`approvals`, `gl_close`, or `exec`). A *GlAccountant* (`gl_post` only) sees the journal/posting tabs but not the approval queue, preventing a preparer from approving their own entries. The **period close** screen (`/finance/period-close`, perm: `gl_close`) is a separate screen — a GL Accountant cannot access it.

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

### Your industry chart

**Screen:** บัญชีแยกประเภท (`/accounting`) → **ผังบัญชี** tab.

When your company was created you picked a **business type** (restaurant, retail,
distribution, services, or general — see *Getting started*). Your chart is tailored to
that industry: the relevant accounts are switched on and given industry-friendly names —
for a restaurant, **4000** reads *Food & Beverage Sales*, **1200** *Food & Beverage
Inventory*, and you also get *Tips Payable*, *Service Charge Income* and *Recipe
Ingredient COGS*; a retailer instead sees *Merchandise Inventory* and *Loyalty Points*
accounts. Accounts that don't apply to your industry are hidden from the picker to keep
data entry clean.

The **ผังบัญชี** tab shows your chart with a *ผังบัญชีตามประเภทธุรกิจ* badge and the
account count. Each journal-entry account picker uses this same curated list.

> **Nothing is ever removed.** The accounting engine always has the full set of accounts
> available, so a posting is never blocked. Press **แสดงบัญชีทั้งหมด** on the ผังบัญชี tab
> to reveal **every** account (for an unusual entry); the badge switches to *ผังบัญชีเต็ม*.
> Any account that has activity always appears on your reports even if it's hidden from the
> picker. You can switch or extend your industry chart later from **Onboarding → Industry
> packs**.

### Managing the chart (GL-11)

The chart has **two levels**, and who may change each level differs:

**1 · Curate your own chart — permission `gl_coa` (e.g. *Financial Controller*).**
You can tailor how the shared accounts appear *on your company's chart* — switch an
account **on/off**, rename it (English + Thai), change its section heading, and reorder it —
without affecting any other company. This is done per account via
`PATCH /api/ledger/accounts/<code>/overlay` (any of `active`, `display_name`,
`display_name_th`, `group_label`, `sort_order`). Your edits are **scoped to your company
only** — you can never see or change another company's chart, and curating **never blocks a
posting** (the account still exists in the engine). You may only curate an account **that
already exists** in the master chart.

**2 · Add or change a master account — permission `gl_coa` **and** the platform *Admin* (HQ) role.**
The master account list (the *code · type · normal balance*) is a **single shared list** used
by every company on the platform, so creating a brand-new code, renaming the master account,
changing its postability, or retiring it is a **head-office (Admin/HQ)** action:

| Action | Endpoint | Notes |
|--------|----------|-------|
| Create account | `POST /api/ledger/accounts` | Auto-sets normal balance (*C* for Liability/Equity/Revenue, *D* for Asset/Expense). |
| Update account | `PATCH /api/ledger/accounts/<code>` | Name, group, postability, dimension requirements, effective dates. |
| Deactivate account | `POST /api/ledger/accounts/<code>/deactivate` | Sets the account inactive + non-postable. |

> **Why the split?** A *Financial Controller* shapes their own company's chart freely, but the
> underlying master codes are shared — so **only the platform administrator** can add or alter
> them. If you try a master change without the Admin/HQ role you'll get **`COA_ADMIN_ONLY`** —
> use the curation options above (level 1) instead, or ask your platform administrator.

**Common messages**

| Message | Meaning | What to do |
|---------|---------|-----------|
| `COA_ADMIN_ONLY` | You tried a master-account change without the Admin/HQ role | Curate your own chart (level 1), or ask the platform admin |
| `DUPLICATE_ACCOUNT` | The code already exists | Use a new code, or edit the existing account |
| `ACCOUNT_HAS_BALANCE` | You tried to deactivate an account that still has a balance | Clear the balance with a correcting entry first |
| `CODE_HAS_POSTINGS` | You tried to turn off postability on an account that already has entries | Leave it postable; use an *effective-to* date instead |
| `ACCOUNT_NOT_FOUND` | You curated a code that isn't in the master chart | Use an existing code (a new code is an Admin/HQ add) |
| `TENANT_REQUIRED` | Curation attempted without a company context | Sign in to the company whose chart you're curating |

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

### Correcting a posted entry — reversal only (GL-17)

Once a journal entry is **Posted** it is **immutable**: it can never be edited or
deleted. This keeps the ledger a true, auditable record of record (a system control,
GL-17, enforced both in the database and in the application — any attempt to delete a
posted entry is refused with `GL_IMMUTABLE`).

To correct a posted entry, **reverse** it:

1. Open the posted entry and click **Reverse** (**กลับรายการ**), optionally giving a
   reason (and a reversal date — defaults to today).
2. The system posts a **new contra entry** that swaps every line's debit and credit,
   so the original and its reversal **net to zero** on every account. The original is
   marked **reversed**, and the new entry links back to it.

**Expected result:** a new Posted reversal entry; the original flagged as reversed; the
net effect on the affected accounts is zero. If you then need the corrected figures,
post a fresh entry with the right amounts.

Notes:
- You can only reverse a **Posted** entry (`NOT_POSTED` otherwise) and only **once**
  (`ALREADY_REVERSED` on a second attempt).
- A reversal still respects the period rules — if its date falls in a **locked** or
  **closed** period it is blocked (`PERIOD_LOCKED` / `PERIOD_CLOSED`); choose an open
  date or reopen the period (soft close) first.
- Every post, approval, reversal and blocked edit attempt is written to the **GL audit
  trail** for review.

### Recurring / template journal entries

For entries you post every period — **monthly rent or insurance accruals**,
**prepaid amortization**, standing inter-company charges — set up a **template**
once instead of re-keying it each time.

1. Go to **Accounting** → **Recurring** and click **New template**
   (`POST /api/ledger/recurring`). Give it a **name**, pick a **cadence**
   (**daily / weekly / monthly**), a **first run date**, and enter the journal
   **lines** (the same Dr/Cr lines as a manual entry).
2. The template must **balance** (total debits = total credits) — an unbalanced
   template is rejected (`UNBALANCED`) so it can't fail silently later.
3. Leave it to run automatically, or schedule the **Post due recurring journals**
   (`gl_recurring_journals`) job under **Reports → Scheduled reports** to run it
   daily.

**Expected result:** On each due date the template posts a journal entry **as a
Draft** and rolls its next run date forward. Because it's a Draft, it still goes
through **maker-checker** — a second person approves it on the **Pending** tab
before it affects balances (just like a manual entry). Running the job twice in a
day posts **nothing extra** (it's idempotent). Pause a template anytime with
**Activate/Pause** (`POST /api/ledger/recurring/:id/active`) without losing its
history.

### Prepaid expense amortization

When you pay for something **up front** that covers several months (annual
insurance, rent), set up a **prepaid schedule** so the cost is spread over its term
instead of hitting one month.

1. **Accounting → Prepaid → New** (`POST /api/ledger/prepaid`): enter the **total**,
   the **number of months**, and the **expense account**. Tick **capitalize** if you
   also want to record the up-front payment now (**Dr Prepaid 1280 / Cr Cash**).
2. Schedule the **Amortize due prepaid expenses** (`gl_prepaid_amortize`) job, or run
   it with `POST /api/ledger/prepaid/run`.

**Expected result:** Each period a **straight-line slice** (total ÷ months) posts as
**Dr expense / Cr Prepaid (1280)**; the **last period takes the remainder** so the
prepaid asset fully clears. Running it twice in a period posts nothing extra.

### Leases (IFRS 16 / TFRS 16)

**Screen:** `/leases` · **Where:** sidebar → **การเงิน → สมุดบัญชี & แยกประเภท →
สัญญาเช่า (IFRS 16)** · **Required permission:** `exec` / `gl_post`.

Capitalize a lease so the **right-of-use asset** and **lease liability** appear on
the balance sheet (rather than expensing rent as you pay it).

1. On the **Leases** screen fill the **สร้างสัญญาเช่าใหม่** form: the **term in
   months**, the **monthly payment**, and the **annual discount rate** (your
   incremental borrowing rate), then **สร้างสัญญาเช่า**. On save the asset +
   liability are recognised at the **present value** of the payments (**Dr
   Right-of-Use 1600 / Cr Lease Liability 2600**).
2. Press **ลงรายการงวดที่ครบกำหนดเดี๋ยวนี้** to post due periods on demand, or
   schedule the **Post due lease periods** (`lease_periodic_run`) job to run it
   automatically.

**Expected result:** Each period posts **interest** on the liability (Dr 5900), the
**cash payment** reducing the liability (Dr 2600 / Cr Cash), and **straight-line
depreciation** of the ROU asset (Dr 5210 / Cr 1690). Over the term the liability and
the ROU asset wind down to **zero**.

**Modifying a lease.** If the rent, remaining term, or rate changes, use **Modify**
(`POST /api/leases/{leaseNo}/modify`). The system **remeasures the liability** at the
present value of the revised payments and **adjusts the right-of-use asset by the
same amount**; depreciation then continues straight-line over the revised remaining
term. (A change that leaves the lease unchanged is rejected with `NO_CHANGE`.)

---

### Opening balances (cutover from a prior system)

**Screen:** บัญชีแยกประเภท (`/accounting`) → **ยอดยกมา** tab · **Required permission:**
`gl_post` (or `creditors` / `ar`).

When you switch to Invisible ERP from another system, enter your **closing balances**
from the old books as your **opening balances** here. The system posts them as **one
balanced journal entry** (source **OPENING**) so every account starts at the right
figure.

1. Set an **อ้างอิงชุด (batch ref)** — e.g. `OB-2026`. This makes the import
   **idempotent**: re-submitting the same batch ref never double-posts.
2. Enter one row per account: pick the **account** and type its **debit** *or*
   **credit** balance.
3. Any net difference between total debits and credits is **posted automatically to
   account 3000 (Opening Balance Equity)** — the badge shows how much will go there.
   Once you've entered every account it should read **สมดุล (balanced)**.
4. Click **ลงยอดยกมา**.

> **Loading a lot of accounts — วางจาก Excel/CSV.** Rather than keying every account,
> click **วางจาก Excel/CSV**, then copy the rows from your prior-system **trial
> balance** (Excel / Google Sheets) and paste them in. The columns are **account
> code · debit · credit** (an account-name column in between is fine, and a header
> row is skipped automatically); a single signed-amount column also works (a negative
> value is read as a credit). The pasted rows drop straight into the table for you to
> review before posting. Any row that can't post (unknown account, no amount) is
> reported back with its **row number** — nothing is silently dropped (**ONB-04**).

**Expected result:** A balanced opening journal, dated today, that shows on the trial
balance. Reconcile it to your prior-system closing trial balance before you rely on the
new books.

---

## 3. Trial balance & financial statements

**Required permission:** finance read (e.g. `fin_report`).

| Report | Screen tab | Shows |
|--------|-----------|-------|
| **Trial Balance** (**งบทดลอง**) | Trial Balance | Every account's debit/credit balance |
| **Income Statement / P&L** (**งบกำไรขาดทุน**) | Income Statement | Revenue − Expense = Net Income, for a date range |
| **Balance Sheet** (**งบดุล**) | Balance Sheet | Assets = Liabilities + Equity, as of a date |
| **Statement of Cash Flows** (**งบกระแสเงินสด**) | Cash Flow | How cash moved over a date range — operating, investing, financing |

To run a report: open the relevant tab, set the **period / date range** (and cost
centre or ledger if needed), and view or export it.

**Expected result:** The statement is produced from all **posted** entries (drafts
are excluded).

### Statement of Cash Flows (indirect method)

The cash flow statement is the **third primary financial statement** (alongside the
income statement and balance sheet). It explains how the cash balance changed over a
period, in three sections:

- **Operating** — starts from **net income**, then adds back non-cash charges (e.g.
  **depreciation**) and the movement in working capital (receivables, inventory,
  payables, accruals).
- **Investing** — cash spent on / received from **fixed assets**.
- **Financing** — owner **capital** contributions and **dividends**.

1. Go to **Accounting** (`/accounting`) → **Cash Flow** tab.
2. Set the **From / To** date range (and ledger if needed) and run it.

**Expected result:** The statement shows each section's subtotal, the **net change
in cash**, and the **beginning** and **ending** cash balances. It is built from the
same posted GL data as the other statements (no separate data entry), and **year-end
closing entries are excluded** so they don't distort the period.

> **Note — it always ties out:** the three sections together equal the change in the
> cash accounts (1000 / 1010 / 1020). The response carries a `reconciled` flag; if it
> ever shows `false`, an account is mis-classified — raise it with finance.

### Statement of Cash Flows (direct method)

The same operating cash flow shown by **nature of receipt/payment** rather than by
adjusting net income. Run it from **Accounting** → **Cash Flow** → **Direct**
(`GET /api/ledger/cash-flow-direct?from=&to=`). Each posted entry's net cash
movement is attributed to the line it sits against, then bucketed into:

- **Receipts from customers** (cash against AR / revenue),
- **Payments to suppliers** (cash against AP / expense / inventory),
- **Tax & payroll** (VAT, withholding, payroll liabilities),
- **Other operating**, plus **Investing** (fixed assets) and **Financing**.

**Expected result:** The receipts/payments net to the **same operating cash flow**
as the indirect statement and the whole report **reconciles to the change in cash**
(`reconciled` flag). Use whichever presentation your reviewer prefers — both are
built from the same posted GL data.

### Cash-flow forecast

A forward look at cash, projected from **open receivables (inflows)** and **open
payables (outflows)** by their due dates. Run it from **Accounting** → **Cash Flow**
→ **Forecast** (`GET /api/ledger/cash-flow-forecast?weeks=8`, 1–52 weeks, default 8).

**Expected result:** A weekly schedule starting from **today's cash balance**; each
week shows expected inflows, outflows, the net, and the **projected running
balance**. Anything already overdue / due now lands in **week 0** so you can see an
immediate shortfall. This is a planning view (not a posted statement) for treasury /
collections prioritisation.

---

## 4. Period & year-end close

**Required permission:** `gl_close` (held by *FinancialController*, *Admin*).

> **Note — separation of duties:** Period close is restricted to a finance
> approver who is **distinct from** the people who prepare journal entries (rule
> R05).

### Check the books reconcile first (control-account overview)

**Screen:** `/reconciliation` (**กระทบยอด**) → the **ภาพรวมบัญชีคุมยอด (Control
accounts)** card at the top · **Required permission:** `recon_prep`, `approvals`, `gl_close`, `exec`, `ar`, or `creditors`.

> **SoD R06 — preparer ≠ certifier:** The "รับรองงวด" (certify) button on `/reconciliation` is visible only to users who hold `approvals`, `gl_close`, or `exec`. A *GlAccountant* (`recon_prep` only) can open/import/auto-match a period but cannot certify it — a FinancialController or Admin must certify. The API already enforces this (`POST /api/recon/periods/:id/certify` requires `approvals`); the UI now matches.

Before you close a period, confirm every sub-ledger still agrees with its general-ledger
control account. The **control-account overview** ties them all in one view —
**ลูกหนี้ (AR) ↔ 1100**, **เจ้าหนี้ (AP) ↔ 2000**, **สินค้าคงเหลือ ↔ 1200**, **บัตรของขวัญ
↔ 2200**, **รายได้รอตัดบัญชี ↔ 2400** — showing each account's sub-ledger total, its GL
balance, the **ส่วนต่าง (variance)**, and a **ตรง / ไม่ตรง** status. A green **"กระทบยอดครบ
ทุกบัญชี"** banner means the books tie; otherwise the banner shows how many accounts are
**ไม่ตรง** — investigate each one (a difference means a posting is missing or mis-booked)
**before** closing the period. This is the detective check that catches a sub-ledger
drifting from the GL before the financial statements go out (control **REC-04**).

### Clear the approval backlog first (pending approvals)

**Screen:** `/approvals` (**รายการรออนุมัติ**) · **Required permission:** `exec` /
`approvals` / `creditors`.

The system holds many actions until a **second person approves** them (a manual
journal, an AP payment, a payroll run, an asset revaluation or disposal, a stock
write-off). The **Pending approvals** screen lists **all** of them in one place with
how many **days** each has been waiting. The cards show the total waiting, how many are
**ค้างเกิน N วัน (overdue)**, and the oldest age. Before you close a period, work the
list to zero — an item stuck here is either a transaction that can't take effect yet, or
a control that's being skipped because nobody chased the approval. Overdue rows are
flagged ⚠ in red so you can escalate them (control **GOV-01**).

### To close an accounting period

1. Go to the **Periods** view.
2. Find the period (`YYYY-MM`) and click **Close** (**ปิดงวด**).

**Expected result:** The period is closed. New postings to it are blocked with
`PERIOD_CLOSED`. (If you must post a late entry, an authorised user can **reopen**
the period, post, and close it again.)

### Hard period close + checklist (irreversible lock)

A *soft* close (above) can be reopened. When the books are final, run a **hard close**:
a checklist-driven, segregated, irreversible **lock**. Once a period is **Locked**, *all*
postings into it are rejected with `PERIOD_LOCKED` — there is no `allowClosedPeriod`
escape (only the system year-end closing entry is exempt).

**Required permission:** `gl_close` (start / complete steps / lock). Reading status also
allows `gl_post` and `exec`.

The lifecycle is **Open → InProgress → ReadyToLock → Locked**:

1. **Start the close** — `POST /api/ledger/close/start` `{ "period": "YYYY-MM" }`. This
   creates a *close run* (status **InProgress**) and seeds the standard checklist:
   sub-ledger tie-out, bank reconciliation, depreciation, recurring/prepaid journals, FX
   revaluation (advisory), and trial-balance review.
2. **Complete each step** — `POST /api/ledger/close/step`
   `{ "close_run_id": N, "step_key": "bank_rec" }` as you finish each procedure. When all
   **required** steps are done, the run automatically becomes **ReadyToLock**.
3. **Lock the period** — `POST /api/ledger/close/lock` `{ "close_run_id": N }`. Locking is
   **maker-checker**: the person who locks **must be different** from the person who started
   the close. The period status becomes **Locked**.

Check progress any time with `GET /api/ledger/close/status?period=YYYY-MM`, or list recent
runs with `GET /api/ledger/close`.

> **Note — separation of duties (GL-16):** you cannot lock a close you started yourself
> (`SELF_LOCK`). A second `gl_close` colleague must perform the lock. The starter, locker,
> and lock time are all recorded as audit evidence.

**Possible errors:** `STEPS_INCOMPLETE` (you tried to lock before all required steps are
done — the response lists what's pending), `SELF_LOCK` (you tried to lock your own close),
`PERIOD_LOCKED` (you tried to post into a locked period), `PERIOD_ALREADY_LOCKED` (the
period is already hard-closed), `CLOSE_RUN_NOT_FOUND`, `STEP_NOT_FOUND`.

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

Tabs: Register, **ตั้งทรัพย์สินจาก GR (Capitalize from GR)**, QR Tags, Categories, Depreciation Runs.

### Acquire an asset

1. Go to **Assets** (`/assets`) → **Register**.
2. Click **Add asset**: name, category, **cost**, acquisition date, **useful life
   (months)**.
3. Save.

**Expected result:** The asset is registered and the purchase posts to the ledger
(Dr Fixed Assets / Cr Cash).

### Register an asset from a goods receipt (Procure-to-Capitalize)

Capital goods bought through procurement become fixed assets here instead of being
typed in by hand — keeping an audit trail from **PR → PO → GR → asset**.

1. Flag the purchase as capital: either set **is_fixed_asset** on the item master, or
   tick **ทุน (capital)** on the PO line when creating the order. When the goods are
   received (GR), capital lines are **not** added to inventory stock — they wait to be
   capitalized.
2. Go to **Assets** (`/assets`) → **ตั้งทรัพย์สินจาก GR**, enter the **GR number** and
   click **ค้นหา (Search)**. Eligible capital lines are listed with their suggested cost
   (received qty × unit cost).
3. Click **ตั้งทรัพย์สิน (Register)** on a line, give the asset a **name** and **useful
   life (months)**, and **ส่งคำขอ (Submit request)**.

**Expected result:** a registration request (**FAR-…**) is created as
**"รออนุมัติ" (PendingApproval)** — nothing posts to the books yet.

#### Approval (required before it counts) — two people

Like disposal, capitalization uses **maker-checker** (the person who receives goods
must not also decide, alone, what goes on the asset register and at what value). A
**different** person opens the **"คำขอตั้งทรัพย์สินที่รออนุมัติ"** queue on the same tab and
clicks **อนุมัติ (Approve)** — only then is the fixed asset created and the acquisition
entry posts (**Dr Fixed Assets 1500 / Cr Accounts Payable 2000**). **You cannot approve
your own request** (`SOD_VIOLATION`, binds **everyone, including Admin**). **ปฏิเสธ (Reject)**
re-opens the line so it can be raised again. A GR line cannot be capitalized twice
(`ALREADY_REGISTERED`). The created asset shows its **source GR / PO** on the register.

### Run monthly depreciation

1. Go to **Depreciation Runs**.
2. Click **Run depreciation** for the period.

**Expected result:** Straight-line depreciation is calculated and posted
(Dr Depreciation Expense / Cr Accumulated Depreciation). Re-running the same period
is safe.

### Dispose of an asset

1. Open the asset (click its row) and use the **จำหน่ายสินทรัพย์ (Dispose)** panel:
   enter the **proceeds** (money received) and **ส่งคำขอจำหน่าย (Submit request)**.

**Expected result:** the gain / loss is computed, but the asset is **not disposed
yet** — the request is **"รออนุมัติจำหน่าย" (PendingApproval)** and posts nothing to the
books until approved.

#### Approval (required before it counts) — two people

Disposal uses **maker-checker** (it's how an asset leaves the books and cash comes
in, so it's a theft-sensitive step): a **different** person opens the same asset and
clicks **อนุมัติ (Approve)** — only then is the asset marked **disposed**, the accounting
entry posts, and any revaluation surplus is recycled. **You cannot approve your own
disposal request** ("ผู้บันทึกอนุมัติรายการของตนเองไม่ได้", `SOD_VIOLATION`) — this binds
**everyone, including Admin**. To cancel, click **ปฏิเสธ (Reject)**; the draft entry is
voided and the asset stays in service. While a disposal is pending, the asset is frozen
(it stops depreciating). Only **one** disposal can be pending per asset at a time.

### Revalue or impair an asset

To adjust an asset's carrying amount to a new value (a market revaluation, or an
impairment write-down), open the asset (click its row in the register) and use the
**ตีมูลค่าใหม่ / ด้อยค่า (Revalue / impair)** panel: enter the **new value (NBV)** and
a reason, then **ส่งคำขอ (Submit request)**.

**Expected result:** An **upward** revaluation credits the **revaluation surplus**
in equity (**Dr Fixed Assets 1500 / Cr Revaluation Surplus 3200**); a **downward**
revaluation (impairment) posts an **impairment loss** (**Dr Impairment Loss 5820 /
Cr 1500**). Every change is kept in the **revaluation history**. Entering the
current value (no change) is rejected (`NO_CHANGE`).

#### Approval (required before it counts) — two people

Because a revaluation moves equity or profit on a judgement call, it uses
**maker-checker**: your request is **"รออนุมัติ" (PendingApproval)** and **the asset's
value and the accounting entry do not change yet**. A **different** person opens the
same asset and clicks **อนุมัติ (Approve)** — only then does the carrying value move and
the entry post. **You cannot approve your own request** ("ผู้บันทึกอนุมัติรายการของตนเอง
ไม่ได้", `SOD_VIOLATION`) — this binds **everyone, including Admin**. To cancel a wrong
request, click **ปฏิเสธ (Reject)**; the draft entry is voided and you can request again.
Only **one** revaluation can be pending per asset at a time.

> **Note — on disposal:** if you later dispose a revalued asset, any **revaluation
> surplus** built up in equity is **transferred to retained earnings** (Dr 3200 / Cr
> 3100) automatically — it isn't recognised again in profit or loss. The disposal
> response reports the amount recycled.

> **Note:** Print **QR labels** from the QR Tags tab and use **scan-update** to
> record an asset's location or assigned holder during a physical asset count.

[screenshot: asset register with depreciation schedule]

---

## 7. Asset maintenance (EAM)

**Screen:** `/eam` · **Where:** sidebar → **การผลิต → ซ่อมบำรุงสินทรัพย์ (EAM)** ·
**Required permission:** `exec` / `warehouse` / `creditors`.

The screen has three tabs — **ใบสั่งงานซ่อม** (work orders), **แผนบำรุงรักษา (PM)**,
and **ความน่าเชื่อถือ** (reliability + meter readings).

Keep equipment running with maintenance **work orders**, **preventive-maintenance
(PM) schedules**, and **meter readings** — all tied to the fixed-asset register.

### Raise & complete a work order

1. Create a work order against an asset (`POST /api/eam/work-orders`): choose the
   **type** (corrective / preventive / inspection), priority, description, and an
   optional **vendor** and cost estimate.
2. Progress it: **open → in_progress → completed** (or **cancelled**). An
   out-of-order move is rejected (`BAD_TRANSITION`).
3. On **completion**, enter the **actual cost**, downtime and vendor.

**Expected result:** If a vendor and cost are given, the maintenance spend posts as
an **AP payable** (`Dr 5710 Repairs & Maintenance / Cr 2000`), so it shows in AP
aging and is paid through the normal AP flow. In-house work (no vendor) just records
the cost.

### Preventive maintenance & meters

1. Create a **PM schedule** (`POST /api/eam/pm-schedules`): a cadence by **time**
   (`interval_days`) and/or by **meter** (`meter_interval`).
2. Record **meter readings** as equipment is used
   (`POST /api/eam/assets/{assetNo}/meter`).
3. Run the **PM sweep** (`POST /api/eam/pm/run`) — or schedule it daily by creating a
   **Generate due preventive maintenance** (`eam_pm_generate`) job under Scheduled
   reports.

**Expected result:** The sweep raises a preventive work order for every due
schedule (time elapsed or meter overrun) and rolls the schedule forward. It is
**idempotent** — a schedule with an open generated work order isn't raised again.

### Cost lines & reliability KPIs

1. Add **cost lines** to a work order (`POST /api/eam/work-orders/{woNo}/lines`):
   a **labor** line (hours × rate) or a **part** line (quantity × unit cost). List
   them with `GET /api/eam/work-orders/{woNo}/lines`.
2. The work order's **actual cost rolls up** from its lines automatically — so when
   you complete the WO the **AP posting reflects the real labor + parts spend**, not
   just the estimate.
3. Review **per-asset reliability** (`GET /api/eam/assets/{assetNo}/reliability`):
   corrective failures, preventive count, open WOs, total **downtime hours**, **MTBF**
   (mean time between failures), and **total maintenance spend**.

**Expected result:** Cost lines give an itemised maintenance cost; the reliability
view gives the failure-rate and lifetime-cost inputs for maintenance budgeting and
**repair-vs-replace** decisions.

---

## FX revaluation (period-end) — control GL-18

**Who:** Financial Controller (`gl_close`/`gl_post`); a *different* user posts.

At period-end, open invoices/bills in a **foreign currency** must be restated to the
**closing exchange rate** so the unrealized FX gain/loss is in the books.

1. **Run** — `POST /api/ledger/fx-reval/run` with the period (`YYYY-MM`). Supply the
   closing `rates` (e.g. `{ "USD": 36 }`) or rely on the latest **approved** FX rate.
   You get the per-document gain/loss and the **net**, staged as **Open**.
2. **Review** the detail (each open AR/AP doc: booked rate → closing rate → delta).
3. **Post** — a **different** user calls `POST /api/ledger/fx-reval/{id}/post`. A net
   gain credits **5400 FX Gain/Loss**, a net loss debits it; the AR/AP control accounts
   (1100/2000) are restated. You **cannot post a run you ran** (segregation of duties).

**Expected result:** the FX line (5400) carries the net unrealized gain/loss and AR/AP
reflect the closing rate. Re-running or re-posting a posted period is blocked.

**Errors:** `MISSING_RATE` (no rate for a currency — pass it in `rates` or approve an FX
rate first), `SELF_POST` (you ran it — ask a colleague to post), `ALREADY_POSTED`.

## Deferred tax (TAS 12) — control TAX-06

**Who:** Tax / Financial Controller (`gl_close`/`gl_post`); a *different* user posts.

Recognise **deferred tax** on book-vs-tax **temporary** differences (the AR allowance
and accelerated depreciation) at the Thai CIT rate (20%).

1. **Run** — `POST /api/ledger/deferred-tax/run` with the period. It computes a deferred
   tax **asset** from the posted AR allowance and a deferred tax **liability** from
   accelerated depreciation, nets them, and shows the **delta** vs the last posted run.
2. **Post** — a **different** user calls `POST /api/ledger/deferred-tax/{id}/post`. An
   increase in the net asset posts **Dr 1700 Deferred Tax Asset / Cr 5950 Deferred Tax
   Expense** (a deferred tax benefit). You **cannot post a run you ran**.

**Expected result:** 1700 (and 5950) move by the period delta; income tax expense
reflects the deferred portion. Re-posting a posted period is blocked (`ALREADY_POSTED`).

**Errors:** `SELF_POST`, `ALREADY_POSTED`, `DT_RUN_NOT_FOUND`.

---

## Consolidation — eliminations & segment reporting (controls CON-03 / CON-04)

**Who:** Group / Financial Controller. All consolidation actions are **HQ (Admin) only**
(`CONSOL_HQ_ONLY` for any other tenant). The run uses the `approvals` permission; group,
rule, segment and report endpoints use `exec`.

Consolidation combines several **entities** (tenants) into a group view, eliminates the
**intercompany (IC)** balances they owe each other, and reports results **by segment**.

### Run a consolidation (CON-03)

1. **Set up the group** — create a group (`POST /api/consolidation/groups`) and add member
   entities with ownership % and currency (`POST /api/consolidation/groups/{id}/entities`).
2. **Run** — `POST /api/consolidation/groups/{id}/run` with the period (`YYYY-MM`). The run:
   - **combines** each member's trial balance (FX-translated, ownership-weighted),
   - **eliminates** in-group IC: for each IC transaction it cancels **1150 Due-From**
     against **2150 Due-To** (the reciprocal receivable/payable),
   - records **NCI** (account 3300) for entities owned < 100%,
   - and **asserts the consolidated trial balance still balances**. If eliminations don't
     net to zero the run is rejected with **`CONSOL_UNBALANCED`** and rolled back.
   Eliminations live at the **group** layer — they are **not** posted into any operating
   entity's books.
3. **Post** — a **different** user calls `POST /api/consolidation/runs/{runId}/post` to freeze
   the run as the official group result for the period. You **cannot post a run you ran**
   (`SELF_POST`), and a posted period cannot be re-run (`ALREADY_POSTED`).

Optional: define configurable elimination rules (`POST /api/consolidation/rules`,
`GET /api/consolidation/rules?group_id=`).

**Expected result:** consolidated TB = Σ entity TBs − IC eliminations, balanced (Σ Dr = Σ Cr);
1150/2150 net to ~0; the run shows `balanced: true`.

### Segment report (CON-04, IFRS 8)

`GET /api/consolidation/segment-report?period=YYYY-MM&dimension=branch` returns
**revenue / expense / net** grouped by reportable **segment**. Map dimension values
(`branch` / `project` / `department`) into named segments first via
`POST /api/consolidation/segments` (`member_keys` = the dimension values in that segment);
unmapped values appear as their own / an `Unassigned` bucket.

**Errors:** `CONSOL_UNBALANCED`, `SELF_POST`, `ALREADY_POSTED`, `CONSOL_RUN_NOT_FOUND`,
`GROUP_NOT_FOUND`, `NO_ENTITIES`, `CONSOL_HQ_ONLY`.

---

## Revenue recognition — contracts & deferred revenue (TFRS 15 / IFRS 15, control REV-19)

For service, subscription, and project-style contracts the system recognizes revenue under the
**TFRS 15 / IFRS 15 five-step model** — revenue is earned as you satisfy your promises, not when
you invoice. (Restaurant POS sales keep their immediate recognition; this is the deferred-revenue
engine for "real ERP" contracts.) Required permission: `exec`, `ar`, or `fin_report`.

**1. Create the contract with its performance obligations**
`POST /api/revenue/contracts` with `total_price` and an `obligations` list. Each obligation has a
name, a **standalone selling price (`ssp`)**, and a `method`:

- `over_time` — straight-line across the months between `start_date` and `end_date` (e.g. an
  implementation or support period).
- `point_in_time` — recognized in full at its `start_date` (e.g. a licence handed over once).

The contract opens in **Draft** and gets a contract number (`REVC-…`).

**2. Allocate the price by SSP** — `POST /api/revenue/contracts/{id}/allocate`. The transaction
price is split across the obligations in proportion to their SSP
(`allocated = total × ssp ÷ Σssp`); the rounding residual lands on the largest obligation so the
allocation **sums exactly to the contract price**.

**3. Activate (raise deferred revenue)** — `POST /api/revenue/contracts/{id}/activate` posts
**Dr 1100 Accounts Receivable / Cr 2410 Deferred Revenue** for the full price and moves the
contract to **Active**.

**4. Build the recognition schedule** — `POST /api/revenue/contracts/{id}/schedule` lays out the
monthly plan (one row per month for over-time obligations, a single row for point-in-time). Safe to
re-run: it rebuilds only rows not yet recognized.

**5. Recognize revenue for a period** — `POST /api/revenue/contracts/recognize` with `{ period }`
(optionally `contract_id`). Every schedule row due in or before that period posts
**Dr 2410 Deferred Revenue / Cr 4300 Recognized Revenue**, and the obligation's progress
(`satisfied_pct` / status) is updated. Re-running the same period posts nothing again
(`recognized_count: 0`). An HQ/Admin caller must add `?tenant_id=` (`TENANT_REQUIRED`).

**Provide for expected refunds** — `POST /api/revenue/contracts/{id}/refund-liability` with
`{ expected_refund_rate }` (0–1) posts **Dr 4300 Revenue (contra) / Cr 2420 Refund Liability** for
the expected return, booking only the change since the prior provision.

**Review** — `GET /api/revenue/contracts` (list) and `GET /api/revenue/contracts/{id}` (the
contract with its obligations and schedule).

**Errors:** `CONTRACT_NOT_FOUND` (404), `INVALID_ALLOCATION` (bad price/SSP/missing over-time
dates), `ALREADY_ACTIVE`, `TENANT_REQUIRED`, `PERIOD_LOCKED` (the target period is hard-closed).

---

**Next:** [Tax](./07-tax.md) · [Finance — AR & AP](./05-finance-ar-ap.md) ·
[Approvals](./10-approvals.md)
