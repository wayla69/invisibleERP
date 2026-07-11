# 06 · General Ledger

**Status: DRAFT v0.9 · 2026-07-10** · *v0.9 (2026-07-10): the **Fixed asset register** (`/assets` → Register
tab) gains a **Bulk import / export (Excel/CSV)** section — download the register, a blank template, or
upload assets in bulk (registry entity `assets`); gated to the `masterdata` setup duty (see §6 → Bulk
import/export).* · *v0.8: dimension filters (โครงการ/แผนก/สาขา/ศูนย์ต้นทุน) on the
trial balance, account ledger and income statement (§3 "Filter by dimension"); dropdowns fed by
`GET /api/ledger/dimensions`.*

This chapter is for **accountants** — *GlAccountant*, *FinancialController* and
*Admin*. It covers the chart of accounts, manual journal entries with
**maker-checker approval**, the trial balance and financial statements, period and
year-end close, multi-ledger reporting, and fixed assets.

**Main screen:** `/accounting` (perm: `gl_post`, `gl_close`, `approvals`, `exec`, `creditors`, `ar`) — tabs include Trial Balance, **Account Ledger (แยกประเภทรายบัญชี)**, **Sub-ledger tie-out (กระทบยอดบัญชีย่อย)**, Chart of Accounts, Journal, Pending journal entries (visible to `approvals`/`gl_close`/`exec` only — SoD R05), Income Statement, Balance Sheet, Cash Flow and Opening Balances.

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

### Dedicated Chart-of-Accounts reference

**Screen:** ผังบัญชี (`/chart-of-accounts`) · **Required permission:** `gl_coa`, `gl_post`,
`gl_close`, `approvals`, `creditors`, `ar` or `exec` (read-only).

For a full, reference-quality view of the chart, open **ผังบัญชี** from the *Ledger & GL*
menu. Unlike the quick-glance tab inside `/accounting`, this page **groups accounts by type**
(สินทรัพย์ · หนี้สิน · ส่วนของเจ้าของ · รายได้ · ค่าใช้จ่าย, in financial-statement order) and
enriches your curated chart with each account's full accounting attributes drawn from the
canonical universe:

- **ดุลปกติ (normal balance)** — เดบิต (Dr) or เครดิต (Cr).
- **บัญชีคุมยอด (control)** — flags accounts that reconcile to a subledger (AR / AP / INV / FA).
- **หัวข้อ (ห้ามลงรายการ)** — non-postable header/roll-up accounts.
- **มิติที่ต้องระบุ** — accounts that require a dimension (branch / project / department / cost
  centre) on every posting.

Use the **search box** (code or name), the **type filter** chips, and the **แสดงบัญชีทั้งหมด /
เฉพาะบัญชีของธุรกิจ** toggle (canonical universe ↔ your industry chart). **ส่งออก CSV** downloads
the currently-filtered list. The screen is also the chart's **manage surface** (GL-11):

- **เพิ่มบัญชี** (header button, platform **Admin/HQ** only) opens the create dialog — 4-digit
  code, EN/TH names, account type (normal balance is derived), optional parent, postable flag.
- Row **แก้ไข** (pencil, Admin/HQ) renames the master account or toggles its postability; row
  **ปิดใช้งาน** (power, Admin/HQ) retires a zero-balance account — history is kept and new
  postings stop (`INVALID_POSTING_ACCOUNT`); a non-zero balance is refused `ACCOUNT_HAS_BALANCE`.
- Row **ตา (แสดง/ซ่อน)** (any `gl_coa` user, shown when your company runs a curated industry
  chart) adds/removes the account on **your own** chart only — the overlay never affects posting
  or other companies. In the **แสดงบัญชีทั้งหมด** view the same eye adds a canonical account your
  industry pack didn't include.

A non-Admin `gl_coa` user sees only the overlay eye — master-account changes stay head-office
(`COA_ADMIN_ONLY`), and accounts can still be provisioned in bulk via **Onboarding → Industry
packs**.

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

**In the app.** On the **ผังบัญชี** tab of `/accounting`, a `gl_coa` user sees per-row editing
controls (a blue note reminds you these tune presentation only — they never change the master
code or a posting). Each change saves immediately and the list refreshes; a user without
`gl_coa` sees the same tab **read-only**.

| Action | How | Effect |
|---|---|---|
| **Rename (EN / TH)** | Row **pencil** → edit **ชื่อบัญชี (อังกฤษ)** / **ชื่อบัญชี (ไทย)** → **บันทึก**. Blank = fall back to the standard name. | The display name on your chart and every account picker. |
| **Set group** | Same dialog → **กลุ่ม (หัวข้อในผัง)**. Blank = use the account type. | The section heading the account is grouped under. |
| **Turn on / off** | Row **power** icon. | Off = hidden from the default chart and pickers; it stays visible here (struck through, *ปิดใช้งาน* badge) so you can turn it back on. An account with activity always stays on your reports. |
| **Re-order** | Row **↑ / ↓** arrows. | Moves the account up or down the chart order. |

Creating or removing a **master code** is not offered here — see level 2 below.

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

### Item posting accounts (GL-21)

By default, inventory and cost-of-goods-sold postings use the standard control accounts
(inventory **1200**, COGS **5000**). If you want a particular product — or a whole product
family — to post to **different** GL accounts, you can attach an **account profile** to the
item or its **item category**. Set these up under *Settings → Master data* on the
**หมวดสินค้า (Item Categories)** (`/setup/item-categories`), **รหัสภาษี (Tax Codes)**
(`/setup/tax-codes`) and **ตั้งค่าบัญชีสินค้า (Item Posting Setup)** (`/setup/items`) screens
— or bulk-import them from a spreadsheet (*Administration → Bulk import*). Account determination
across every business event is viewable/overridable on **กฎการลงบัญชี (Posting Rules)**
(`/setup/posting-rules`) — and your company's **approved override rows there now drive the
recurring system postings** (payroll `PAYROLL.*`, asset depreciation `DEPRECIATION.FA`, lease
runs `LEASE.*`/`DEPRECIATION.ROU`): each leg posts to your override account, or the standard
account when you haven't set one.

> **Changing a posting rule is a two-person action (GL-24).** A saved rule shows **รออนุมัติ**
> and has **no effect** until a *different* user presses **อนุมัติ** on the same screen — you
> cannot approve a rule you created (`SOD_VIOLATION`, even for Admin). The form also refuses,
> at save: an unknown event/role, a debit/credit side that doesn't match the role, an account
> that doesn't exist or can't be posted to (`INVALID_POSTING_ACCOUNT`), and any **บัญชีคุม**
> role (sub-ledger control accounts such as AR 1100 / AP 2000 / inventory 1200, equity, cash —
> `OVERRIDE_ROLE_PINNED`). Editing an approved rule sends it back to รออนุมัติ. Every create /
> approve / reject / deactivate is kept in an audit trail. Each item/category can carry its
own revenue, COGS, inventory and valuation account plus a VAT code and — for service/labour
categories — a withholding-tax income type.

This is **opt-in per company**: turn on **กำหนดบัญชีตามสินค้า (Item posting)** with the
status card at the top of **หมวดสินค้า** (`/setup/item-categories`) — it shows whether the
switch is on and lets an `md_config`/`exec` user flip it (the same `posting_determination`
flag is also reachable via the feature-flags API). While it's **off** (the default),
every posting behaves exactly as before. While it's **on**, each posting picks its account by
precedence — **the item's own setting → its category's setting → its warehouse's default →
the standard control account** — so anything you leave blank simply falls back to today's
behaviour. Warehouse-level defaults (a per-store inventory / adjustment account) are set on
**บัญชีตามคลังสินค้า (Warehouse Accounts)** (`/setup/warehouses`). The inventory sub-ledger
still reconciles to the GL either way.

The same item/category profile also drives a few non-account defaults when
determination is on: an item's **default stock location** (a receipt or issue with no
location goes there instead of the main warehouse), its **revenue account** (a sales
invoice's revenue follows the item, when a whole order shares one), and its **VAT / WHT
codes** (see [Tax](./07-tax.md)). Leave any of them blank to keep the standard behaviour.

| Message | Meaning | What to do |
|---------|---------|-----------|
| `INVALID_POSTING_ACCOUNT` | A posting line (manual JE, item/category profile, or a posting-rule override) points at a code that doesn't exist in the chart, or at a header/deactivated account | Fix the account (on the JE line, the item/category, or the `/setup/posting-rules` row) to a real, postable code (see the chart above) |

**ตั้งค่าบัญชีสินค้า (Item Posting Setup)** (`/setup/items`) also carries an
**ข้อมูลหลักสินค้า (Item master)** card below the posting-profile fields — barcode,
unit of measure / base UOM / conversion factor, list price, temperature type,
business unit, min/max stock, average daily usage, lead time, MRP lot-sizing
inputs (min order qty, order multiple, order/holding cost), and the "is a fixed
asset" flag + default asset category (used by the FA-10 capital-goods routing —
see [Fixed assets & depreciation](#6-fixed-assets--depreciation) below). These
columns already existed on the item record; they now have a screen.

Below the item master card, the same screen carries an **สถานะและความสัมพันธ์
(Lifecycle & relationships)** card. Set the item's **สถานะ (status)** —
**ใช้งาน (active)**, **พักใช้ (inactive)**, or **เลิกจำหน่าย (discontinued)**;
a discontinued item can name the **สินค้าทดแทน (successor)** SKU that replaces it.
Below that, link this item to another with a typed **relationship** — *substitute*
(สินค้าทดแทนกันได้), *complement* / *accessory* (สินค้าเสริม/อุปกรณ์เสริม),
*supersedes* (มาแทน), or *kit_component* (ส่วนประกอบชุด) — to drive cross-sell and
substitution suggestions. Relationships are **per company**: what you link here is
visible only to your own company, and removing a link removes it for you only.
Both status and relationships are change-audited. (You can't relate an item to
itself, and a duplicate link is rejected.)

The screen also has a **ค้นหาสินค้าซ้ำ (Find duplicate items)** button that opens
a review queue of probable duplicate items — grouped when they share a barcode or
have a very similar description. Because the item catalogue is **shared across all
companies**, actually *merging* two items (which moves every transaction and the
history from the duplicate onto the item you keep, then retires the duplicate) is
reserved for the **platform owner**; everyone else sees the review queue but not
the merge button. A merge cannot be undone, and if the two items own conflicting
records it is refused so you can resolve them first.

The lifecycle card also lets you **schedule a future-dated change** to an
item's price or status: pick the field, the new value and an **effective
date**, and the change is parked until that date, when a daily job applies
it automatically (nothing changes before then; you can cancel a pending
one any time). The same mechanism governs a customer's **credit limit** —
but because a credit-limit change is sensitive, a scheduled one is held for
a **second person to approve** before it can take effect, and you can never
approve your own request.

Similarly, **บัญชีตามคลังสินค้า (Warehouse Accounts)** (`/setup/warehouses`)'s
**แก้ไข (Edit)** action now opens a full warehouse-detail dialog — name, zone,
type, capacity, temperature, and active status, in addition to the two GL
accounts — instead of only the inventory/adjustment account fields.

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
> is rejected (`UNBALANCED`). Every line must also name a **real, postable** account
> from the chart — a code that doesn't exist (or a header / deactivated account) is
> rejected `INVALID_POSTING_ACCOUNT`, so a typo can never post silently and then
> disappear from your reports.
>
> **The form checks this for you before you save.** When you press save, any problem
> is shown **in place**: a line that has no account, no amount, or both a debit and a
> credit gets a red hint; and if the entry doesn't balance, a message says **which
> side is over and by how much** (e.g. *เครดิตเกิน ฿50.00*) instead of just an
> "unbalanced" badge. Fix the highlighted item and save again. The same checks apply
> to **Recurring** and **Prepaid** schedules.

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
- **Someone other than the preparer must reverse (maker-checker).** You **cannot reverse a journal entry
  you prepared** — the system blocks it as a segregation-of-duties violation (`SOD_VIOLATION`, message
  *"Maker-checker: you cannot reverse a journal entry you prepared"*). This stops the preparer from quietly
  undoing an entry that a second person had independently approved (which would defeat the GL-05 check). Ask
  a colleague to reverse it. (Automated system reversals — e.g. period-end FX revaluation — are not affected.)
- You can only reverse a **Posted** entry (`NOT_POSTED` otherwise) and only **once**
  (`ALREADY_REVERSED` on a second attempt).
- A reversal still respects the period rules — if its date falls in a **locked** or
  **closed** period it is blocked (`PERIOD_LOCKED` / `PERIOD_CLOSED`); choose an open
  date or reopen the period (soft close) first.
- Every post, approval, reversal and blocked edit attempt is written to the **GL audit
  trail** for review.

### Recurring / template journal entries

**Screen:** รายการบัญชีตั้งเวลา (`/gl-schedules` → **รายการตั้งเวลา** tab, ERP nav → *Ledger & GL*) ·
**Required permission:** `gl_post`, `gl_close` or `exec`.

For entries you post every period — **monthly rent or insurance accruals**,
**prepaid amortization**, standing inter-company charges — set up a **template**
once instead of re-keying it each time.

1. Open **รายการบัญชีตั้งเวลา** → **รายการตั้งเวลา** and fill in the **create** form
   (`POST /api/ledger/recurring`). Give it a **name**, pick a **cadence**
   (**daily / weekly / monthly**), an optional memo, and enter the journal
   **lines** (the same Dr/Cr lines as a manual entry). Use **ลงรายการที่ถึงกำหนด** to post
   due templates now.
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

**Screen:** รายการบัญชีตั้งเวลา (`/gl-schedules` → **ค่าใช้จ่ายจ่ายล่วงหน้า** tab) ·
**Required permission:** `gl_post`, `gl_close` or `exec`.

When you pay for something **up front** that covers several months (annual
insurance, rent), set up a **prepaid schedule** so the cost is spread over its term
instead of hitting one month. The tab shows each schedule's **progress bar**
(amortized vs remaining, periods posted / total).

1. **รายการบัญชีตั้งเวลา → ค่าใช้จ่ายจ่ายล่วงหน้า → create** (`POST /api/ledger/prepaid`): enter
   the **total**, the **number of months**, and the **expense account**. Tick **capitalize** if you
   also want to record the up-front payment now (**Dr Prepaid 1280 / Cr Cash**). Use **ตัดจ่ายงวดที่ถึงกำหนด**
   to amortize due schedules now.
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

**Lessor-side leases (IFRS 16 lessor, LSE-02).** When your company is the **lessor**
(you lease an asset *out*), use the lessor register (`POST /api/lessor-leases`;
**required permission** `exec` / `gl_post`). The system first **classifies** the lease
as a **finance lease** or an **operating lease** from the IFRS 16 lessor criteria — you
supply the **asset cost**, the asset's **fair value** and **economic life**, and any
**transfer-of-ownership** / **bargain-purchase** flags; a finance lease is one that
transfers substantially all the risks and rewards (transfer of ownership, a bargain
purchase option, a term ≥ **75%** of the economic life, or a PV of the payments ≥ **90%**
of fair value). `POST /api/lessor-leases/classify` previews the classification without
saving. Classification is **maker-checker**: the lease is saved **pending** with no GL,
and a **different** colleague approves it (`POST /api/lessor-leases/{leaseNo}/approve`) —
you **cannot** approve your own lease (rejected `SOD_SELF_APPROVAL`).

- **Finance lease:** on approval the underlying **asset is derecognised** (Cr 1500) and a
  **net investment in lease / lease receivable** is booked at the present value (Dr 1610),
  with any selling profit/loss to 1510. Press **run** (`POST /api/lessor-leases/run`) to
  recognise each period's **interest income** (Cr 4600) and collect the cash (Dr 1000);
  the receivable winds down to zero over the term.
- **Operating lease:** the asset **stays on your books**; the run recognises **straight-line
  rental income** (Dr 1000 / Cr 4610) and **continues depreciating** the asset
  (Dr 5200 / Cr 1590).

The **net-investment reconciliation** (`GET /api/lessor-leases/receivable-reconciliation`)
ties the GL **1610** control account to the sum of the finance-lease receivable balances on
the schedule (`reconciled`, `difference`) — review it at close.

---

### GL allocation cycles — cost allocation (GL-23)

**Where:** `POST /api/ledger/allocation` (+ `/allocation/:id/active`, `/allocation/run`);
scheduled job **`gl_allocation_run`** under **Reports → Scheduled reports** ·
**Required permission:** `gl_post` / `exec`.

Use an **allocation cycle** to spread a **shared / overhead cost** across the
cost-centers or departments that consume it — instead of an ad-hoc, unbalanced,
hard-to-audit spreadsheet. Typical uses: IT / facilities / HR overhead split to
operating departments; a rent pool split by floor area.

1. **Create a cycle** (`POST /api/ledger/allocation`): give it a **name**, the
   **source account** (the pool that is relieved) and optional **source cost-center**,
   the **pool amount** to distribute each run, an allocation **method**, a **cadence**
   (`daily`/`weekly`/`monthly`) and a first-run date, and one or more **targets**.
   - **method `ratio`** — you enter each target's fixed proportion as its **basis**
     (e.g. 3 and 1 → 75% / 25%).
   - **method `driver`** — the basis is a **measured driver** (machine hours, kWh).
   - **method `statistical`** — the basis is a **statistical key** (headcount, sqm).

   All three split the pool proportionally by the target **basis** weights; each
   target may name its own **target account** (leave blank to keep the source
   account and only move the **cost-center**) and its consuming **cost-center**.
2. Leave it to run automatically (schedule **`gl_allocation_run`**), or post due
   cycles on demand with `POST /api/ledger/allocation/run`.
3. **Pause / resume** a cycle with `POST /api/ledger/allocation/:id/active` without
   losing its history.

**Expected result:** each due cycle posts **one balanced Draft journal entry** —
**Cr the source pool** and **Dr each target its share** (`pool × basis ÷ Σbasis`, the
**last target absorbing any rounding remainder** so debits equal the pool exactly).
Like every recurring entry it posts as a **Draft** and a **different** user must
**approve** it (§2, maker-checker GL-05) before it affects balances. Running a cycle
twice in the same period posts nothing extra (idempotent).

**Common messages.** A cycle with **no targets** → `NO_TARGETS`; a **zero total
basis** (nothing to divide by) → `NO_BASIS`; a **non-positive pool** → `BAD_AMOUNT`;
an unknown **method / cadence** → `BAD_METHOD` / `BAD_FREQUENCY`.

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

> **Note — opening balances need a second person's approval (maker-checker, GL-05).** Posting the batch
> now creates it as a **Draft** (`status: Draft`, pending) that **does not yet affect** the trial balance —
> exactly like a manual journal entry. A **different** authorised user must **approve** it (on the
> **รออนุมัติ (JE)** tab, or `POST /api/ledger/journal/{entryNo}/approve`) before it flows into the ledger.
> Because opening balances set the entire starting position of the books, this second-person check is
> deliberate. **You cannot approve your own opening batch** — the system blocks it as a
> segregation-of-duties violation (`SOD_VIOLATION`).

> **Loading a lot of accounts — วางจาก Excel/CSV.** Rather than keying every account,
> click **วางจาก Excel/CSV**, then copy the rows from your prior-system **trial
> balance** (Excel / Google Sheets) and paste them in. The columns are **account
> code · debit · credit** (an account-name column in between is fine, and a header
> row is skipped automatically); a single signed-amount column also works (a negative
> value is read as a credit). The pasted rows drop straight into the table for you to
> review before posting. Any row that can't post (unknown account, no amount) is
> reported back with its **row number** — nothing is silently dropped (**ONB-04**).

**Expected result:** A balanced opening journal is created as a **Draft** (pending approval) — it shows on
the trial balance **only after a second authorised user approves it**. Once approved, reconcile it to your
prior-system closing trial balance before you rely on the new books.

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

### Filter by dimension (โครงการ / แผนก / สาขา / ศูนย์ต้นทุน)

The **Trial Balance**, **Account Ledger** and **Income Statement** can be sliced by the accounting
dimensions carried on each journal line. Pick a **โครงการ (project)**, **แผนก (department)**, **สาขา
(branch)** and/or **ศูนย์ต้นทุน (cost centre)** from the dropdowns above the report — the dropdowns
list only values actually in use in the ledger (`GET /api/ledger/dimensions`). The report then shows
**only the journal lines tagged with that dimension** (API: `?project_id=&dept_id=&branch_id=`
alongside the existing `?cost_center=`); a filtered trial balance still balances within its slice.
Leave every dropdown on **ทั้งหมด (All)** for the normal, unfiltered report — its figures are
unchanged. Lines posted **without** a dimension tag do not appear in any dimension slice (for cost
centres the *unassigned* slice remains available via `cost_center=__UNASSIGNED__`).

### Account ledger (GL detail — แยกประเภทรายบัญชี)

**Screen:** บัญชีแยกประเภท (`/accounting`) → **แยกประเภทรายบัญชี** tab · **Required permission:**
`gl_post`, `gl_close`, `exec`, `creditors`, `ar` or `fin_report`.

To see the individual postings behind a trial-balance figure, open the **แยกประเภทรายบัญชี** tab,
pick an **account** and a **date range** (`GET /api/ledger/account-ledger?account=&from=&to=`). It
lists the **opening balance** (everything posted before the *from* date), then every posted line in
date order — date, entry no., source, memo, debit, credit — with a **running balance**, and the
**closing balance**. The closing balance equals that account's trial-balance balance (Σ debit − credit),
so the drill-down always reconciles to the trial balance. The **โครงการ / แผนก / สาขา** dropdowns narrow
the drill-down to one dimension slice (`?project_id=&dept_id=&branch_id=`) — opening, lines and closing
then belong to that slice alone and tie to the dimension-filtered trial balance.

### Sub-ledger tie-out (กระทบยอดบัญชีย่อย — GL-14)

**Screen:** บัญชีแยกประเภท (`/accounting`) → **กระทบยอดบัญชีย่อย** tab · **Run:** `gl_post`/`gl_close`;
**Certify:** `gl_close` (certifier ≠ runner — SoD).

Reconciles each **control account** to its sub-ledger of record. Pick a sub-ledger — **AR** (1100 ↔ open
customer invoices), **AP** (2000 ↔ open vendor bills), **INV** (1200 ↔ perpetual inventory valuation) or
**FA** (fixed-asset net book value) — and press **กระทบยอด** (`POST /api/ledger/tie-out/run`). The run
records the GL balance, the sub-ledger balance, the **variance** and a **Matched / Variance** status. A
**different** user then presses **รับรอง** (`POST /api/ledger/tie-out/:id/certify`) to certify it (a
variance may be certified with a note explaining the reconciling items); certifying your own run is blocked
(`SELF_CERTIFY`).

### Dedicated Financial Statements screen

**Screen:** งบการเงิน (`/financial-statements`) · **Required permission:** `fin_report`,
`exec`, `creditors` or `ar` (read-only).

For a **full, statement-formatted** view — account-level line items with section subtotals,
not just the summary KPIs on the `/accounting` tabs — open **งบการเงิน** from the *Financial
Reports* menu. It has three tabs (deep-linkable via `?tab=`):

- **งบดุล (Balance Sheet)** — pick an **as-of date**; assets, liabilities and equity are listed
  per account with section subtotals, the current-period profit/loss shown under equity, and an
  Assets = Liabilities + Equity **balance check**.
- **งบกำไรขาดทุน (Income Statement)** — pick a **from / to** range (or *ตั้งแต่ต้นปี*); revenue and
  expense lines with subtotals and net profit. **แยกตามสาขา** switches to a per-branch breakdown, and
  the **โครงการ / แผนก / สาขา / ศูนย์ต้นทุน** dropdowns slice the statement to one dimension
  (see *Filter by dimension* above).
- **งบกระแสเงินสด (Cash Flow)** — toggle **ทางอ้อม (indirect)** / **ทางตรง (direct)** / **พยากรณ์
  (8-week forecast from open AR/AP)**.

A **multi-GAAP ledger** selector (TFRS / TAX / IFRS) in the header re-runs every statement against
the chosen ledger, and **ส่งออก CSV** exports the balance sheet or income statement. All figures are
read straight from **posted** GL entries (drafts and year-end CLOSE reclassifications excluded).

### Statutory financial-statement pack (notes · changes in equity · DBD e-Filing)

**API:** `GET/POST/DELETE /api/reports/fs/*` · **Required permission:** `fin_report` or `exec`
to read; `gl_close` or `exec` to maintain layout definitions.

Beyond the primary statements above, the **statutory FS pack** produces the *audit pack* a Thai
company files. Everything here is **read-only** and pulled from the same posted GL the primary
statements use, so the pack can never disagree with your audited books.

- **Financial-report builder (your own row-groups).** Define a named **layout** of subtotals /
  row groups for a P&L or balance sheet: each group either selects accounts (by explicit code,
  code prefix, or account type) or computes a subtotal from other groups (e.g. *Net profit =
  Revenue − Expenses*). `POST /api/reports/fs/definitions`, then
  `GET /api/reports/fs/render/:code?as_of=&from=`. Add `prior_as_of` (and `prior_from` for a
  P&L) and every row gains a **comparative (prior-year / budget) column** beside the current one.
- **Statement of changes in equity (SOCE).** `GET /api/reports/fs/changes-in-equity?from=&to=` —
  a roll-forward per equity component: **opening + movements** (share issues, dividends) **+
  profit for the period** (to retained earnings) **= closing**. The response's
  `ties_to_balance_sheet` flag confirms the total closing equity reconciles to the balance sheet.
- **Note schedules.** For a `notes`-type layout, `GET /api/reports/fs/notes/:code?as_of=&prior_as_of=`
  maps accounts to each note, totals them, adds a comparative column, and renders your
  **accounting-policy text** blocks.
- **DBD e-Filing export (งบการเงิน — XBRL / S-form).** `GET /api/reports/fs/dbd-export?fiscal_year=&taxpayer_name=&taxpayer_id=`
  packages the annual FS (current + prior year) as the standard S-form concepts (สินทรัพย์รวม /
  หนี้สินรวม / ส่วนของผู้ถือหุ้น / รายได้รวม / ค่าใช้จ่ายรวม / กำไรสุทธิ) plus a ready-to-file **XBRL
  instance**, with an `Assets = Liabilities + Equity` `balanced` self-check.

**Error codes:** `FS_DEF_NOT_FOUND` (unknown layout), `FS_NOT_RENDERABLE` (render called on a
`soce`/`notes` layout — use the dedicated endpoint), `FS_NOT_NOTES` (notes called on a non-notes
layout), `FS_ASOF_REQUIRED` / `FS_FROM_REQUIRED` / `FS_RANGE_REQUIRED` (missing dates),
`FS_BAD_STATEMENT_TYPE` / `FS_BAD_FISCAL_YEAR` (bad input).

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

Tabs: Register, **ตั้งทรัพย์สินจาก GR (Capitalize from GR)**, QR Tags, **ตรวจนับทรัพย์สิน (Asset audit)**, **อนุมัติย้ายทรัพย์สิน (Custody approvals)**, Categories, Depreciation Runs.

The **Register** table shows each asset's **สถานที่ (location)**, **แผนก
(department)**, **เลขที่ซีเรียล (serial no.)** and **ผู้ถือครอง (assigned to)**
alongside cost/depreciation/status — set at acquisition (or via **QR Tags** →
scan-to-update for `assigned_to`/location changes, which route through custody
approval below).

### Acquire an asset

1. Go to **Assets** (`/assets`) → **Register**.
2. Click **Add asset**: name, category, **cost**, acquisition date, **useful life
   (months)**.
3. Save.

**Expected result:** The asset is registered and the purchase posts to the ledger
(Dr Fixed Assets / Cr Cash).

### Bulk import/export (Excel/CSV)

At the bottom of the **Register** tab a **Bulk import / export (Excel/CSV)** section lets you
**export** the whole asset register, download a blank **template**, and **import** many assets at
once (validate-then-commit, with a per-row error preview and an optional skip-errors mode). It reuses
the shared master-data import engine (registry entity `assets`) and is shown only to users holding the
`masterdata` setup duty. Required columns: `Asset_No`, `Name`, `Acquire_Date`, `Acquire_Cost`,
`Useful_Life_Months`.

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
3. Click **ตั้งทรัพย์สิน (Register)** on a line, give the asset a **name**, **useful
   life (months)**, and optionally its **สถานที่ (location)**, **แผนก (department)**
   and **เลขที่ซีเรียล (serial no.)** — then **ส่งคำขอ (Submit request)**.

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

### Parallel tax depreciation book (FIN-6)

Thai tax lets you depreciate an asset **faster** than the accounting (book) rate —
a shorter tax life plus a **first-year initial allowance**. You can keep this
**separate tax basis** on the asset without any manual GAAP adjustment:

1. When you acquire an asset, optionally set the tax parameters — **tax useful life
   (months)**, **tax salvage value**, **tax initial-allowance %**. The asset then
   keeps a parallel **tax book** alongside the accounting book.
2. Run **tax depreciation** for a period (`POST /api/assets/tax-depreciation/run`,
   `YYYY-MM`). This is a **memo calculation** — it posts **nothing** to the ledger
   (tax depreciation isn't a bookkeeping entry). It applies the initial allowance in
   the first period, then straight-line over the tax life. Re-running the same period
   is safe (idempotent).

**Why it matters:** the difference between the book and tax net book value is a
**temporary difference**. The **Deferred tax** run (§ TAX / see *07-tax.md*) now reads
each asset's **actual tax NBV** and posts the resulting deferred-tax charge/benefit
(**Dr Deferred Tax Expense 5950 / Cr Deferred Tax Asset 1700**, or the reverse) — so
book-vs-tax depreciation flows straight into deferred tax instead of a hand-keyed
adjustment. Assets with no tax book fall back to the documented approximation.

### Construction-in-progress (CIP / AUC)

An asset you build over time (a warehouse, a fit-out) accumulates cost before it is
ready for use. Keep it in a **construction-in-progress** record so it is **not
depreciated** until finished:

1. **Open a CIP** (`POST /api/assets/cip`): name, optional category/location. It starts
   with zero cost.
2. **Add cost lines** (`…/cip/:cipNo/cost`) as they arrive — from a goods receipt, a
   project, or manual entry. Each posts **Dr Construction in Progress 1520 / Cr Accounts
   Payable 2000** (or **Cr Cash 1000**) and rolls up the accumulated cost. Only an **Open**
   CIP accepts cost (else `CIP_NOT_OPEN`).
3. **Settle (capitalize)** when complete (`…/cip/:cipNo/settle`): give the finished
   asset's **useful life** (or a category) and a **mandatory reason**. A CIP with no
   cost can't be settled (`CIP_NO_COST`). The request posts **nothing** yet.

#### Approval (required before it counts) — two people

Settlement uses **maker-checker** (deciding *when* construction is "complete" and at
what value it enters service moves PPE and starts depreciation). A **different** person
approves (`…/cip/:cipNo/settle/approve`) — only then is the fixed asset created and the
**reclassification entry posts: Dr Fixed Assets 1500 / Cr Construction in Progress 1520**
(moving the accumulated cost out of CIP), and depreciation begins. **You cannot approve
your own settlement** (`SOD_VIOLATION`, binds **everyone, including Admin**). **Reject**
re-opens the CIP for more cost or a corrected request. The created asset shows its
**source CIP** on the register.

> **Note — QR asset tags & scanning:** Print **QR labels** from the **QR Tags** tab
> (single tag or the full A4 sheet) and use **scan-update** to record an asset's
> location or assigned holder during a physical asset count. On the QR Tags tab's
> scan box you can capture a tag by **camera** (tap **สแกน QR / Scan QR** — works on
> any modern browser with a camera, including iPhone/Safari and Firefox), a
> **hardware wedge scanner**, or by typing/pasting the code. If your
> deployment sets a public web address, the printed QR also opens from a phone's
> **native camera**: it lands on a resolver page (`/q`) that identifies the asset
> and links into the register. The scan box accepts either the raw `ASSET_ID:…`
> code or the resolver URL.

> **Note — moving an asset needs approval (FA-11).** Scanning to **confirm** an
> asset is where the register says just records a verification. But **changing** an
> asset's location or holder is now a **request that a different person approves**
> (segregation of duties): the register does **not** move until an approver acts.
> Requests appear on the **อนุมัติย้ายทรัพย์สิน (Custody approvals)** tab — approve or
> reject them there. You **cannot approve your own** request (the system blocks it).

> **Asset audit (ตรวจนับทรัพย์สิน).** To do a physical count: open the **Asset audit**
> tab, **Start audit** for a location (leave blank for the whole company), then scan
> each tag you find (camera / wedge / manual — continuous scanning stays open). The
> screen tallies **Found / Missing / Misplaced / Unknown** live and lists the missing
> and misplaced assets. Scanning works **offline** (each scan is queued and syncs when
> you're back online — a badge shows the pending count). **Close & reconcile** raises a
> custody-change request (for approval on the Custody approvals tab) for every asset
> found in the wrong place, proposing to move it to where you counted it.

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

## Revenue recognition (TFRS 15 / IFRS 15) — control REV-19

**Where:** **Ledger & GL → รับรู้รายได้** (`/revenue`).
**Who:** `exec` / `ar` (`fin_report` may read).

The Revenue Recognition screen has three tabs: **สัญญา TFRS 15** (the five-step contract
engine), **รายได้รอตัดบัญชี** (deferred-revenue balance + run recognition), and **ตารางรับรู้**
(the straight-line DEFREV schedules).

### The five-step contract (สัญญา TFRS 15)

For service / subscription / project contracts that bundle several deliverables, TFRS 15
recognises revenue **as each obligation is satisfied**, not when cash arrives. Work a
contract top-to-bottom on the **สัญญา TFRS 15** tab:

1. **Create the contract (สร้างสัญญา TFRS 15).** Enter the **contract price**, date, and one
   or more **performance obligations** — each a name, its **standalone selling price (SSP)**,
   and a recognition **method**: **ณ จุดเวลา (point in time)** recognises in a single period,
   **ตลอดช่วงเวลา (over time)** straight-lines across a start→end range (required for over-time
   lines). Add/remove obligation rows with **เพิ่มภาระ / ลบ**. The contract opens as **Draft**.
2. **จัดสรรตาม SSP (Allocate).** Click a contract row to open its panel, then **จัดสรรตาม SSP** —
   the transaction price is split across the obligations in proportion to SSP (Σ allocated is
   held exactly equal to the contract price; rounding lands on the largest line).
3. **สร้างตารางรับรู้ (Build schedule).** Generates the recognition rows — one per month for
   over-time lines, a single row for point-in-time lines. Already-recognised rows are never
   rebuilt (safe to re-run).
4. **เปิดใช้ (Activate).** Raises the contract liability for the full price
   (**Dr 1100 AR / Cr 2410 Deferred revenue**) and flips the contract to **Active**. You can't
   activate twice (`ALREADY_ACTIVE`).
5. **Recognise.** Use the **รายได้รอตัดบัญชี** tab's **รับรู้รายได้งวดนี้** button for a period —
   every due, unrecognised row releases deferred revenue to income (**Dr 2410 / Cr 4300**). The
   obligation's **% ที่ปฏิบัติแล้ว** and the contract status advance automatically; when all
   obligations are satisfied the contract becomes **Completed**.

*(APIs: `POST /api/revenue/contracts`, `…/{id}/allocate`, `…/{id}/schedule`, `…/{id}/activate`,
`POST /api/revenue/recognize`; the panel reads `GET /api/revenue/contracts` + `…/{id}`.)*

**Errors:** `INVALID_ALLOCATION` (no obligation, non-positive price/SSP, or an over-time line
missing its dates), `ALREADY_ACTIVE`, `CONTRACT_NOT_FOUND`, `TENANT_REQUIRED` (HQ/Admin must
pass a tenant to recognise).

## Deferred tax (TAS 12) — control TAX-06

**Where:** **Ledger & GL → ภาษีเงินได้รอตัดบัญชี** (`/deferred-tax`).
**Who:** Tax / Financial Controller (`gl_close`/`gl_post`/`exec`); a *different* user posts.

Recognise **deferred tax** on book-vs-tax **temporary** differences (the AR allowance
and accelerated depreciation) at the Thai CIT rate (20%).

1. **Run** — on the **คำนวณงวดใหม่** tab, enter the period (`YYYY-MM`; optionally an
   as-of date, tax rate, and tax-depreciation factor) and press **คำนวณ**. It computes a
   deferred tax **asset** from the posted AR allowance and a deferred tax **liability**
   from accelerated depreciation, nets them, and shows the **delta** vs the last posted
   run, with the temporary-difference breakdown. This stages an **Open** run.
2. **Post** — on the **รายการที่คำนวณ / โพสต์** tab, a *different* user presses **โพสต์เข้า GL**
   on the Open run. An increase in the net asset posts **Dr 1700 Deferred Tax Asset /
   Cr 5950 Deferred Tax Expense** (a deferred tax benefit). You **cannot post a run you
   ran** (segregation of duties). *(APIs: `POST /api/ledger/deferred-tax/run` and
   `POST /api/ledger/deferred-tax/{id}/post`.)*

**Expected result:** 1700 (and 5950) move by the period delta; income tax expense
reflects the deferred portion. Re-posting a posted period is blocked (`ALREADY_POSTED`).

**Errors:** `SELF_POST`, `ALREADY_POSTED`, `DT_RUN_NOT_FOUND`.

## Cost centres & dimensional P&L

**Where:** **Ledger & GL → ศูนย์ต้นทุน & กำไรตามมิติ** (`/cost-centers`).
**Who:** `exec` / `masterdata`.

Cost centres are a reporting **dimension** (department, branch, or project) you can attach
to journal lines to see profit & loss *sliced* by that dimension — without opening a
separate ledger book.

1. **Create a cost centre** — on the **ศูนย์ต้นทุน (Master)** tab, enter a **code** and
   **name**, pick the **type** (department / branch / project), and optionally a parent
   code, then press **เพิ่มศูนย์ต้นทุน**. Codes are unique per company.
2. **View a dimensional P&L** — on the **กำไร-ขาดทุนตามมิติ** tab, pick a cost centre and a
   **from/to** date range. The screen shows **revenue**, **expense**, and **net income**
   plus a per-account breakdown for lines tagged with that cost centre.

*(APIs: `POST` / `GET /api/ledger/cost-centers`, and
`GET /api/ledger/cost-centers/{code}/pl?from=&to=`; the income-statement endpoint also
accepts `?cost_center=` for the same filter.)* This is a **read/compute** view — it posts
nothing and carries no control of its own.

---

## Consolidation — eliminations & segment reporting (controls CON-03 / CON-04 / CON-05)

**Who:** Group / Financial Controller. All consolidation actions are **HQ (Admin) only**
(`CONSOL_HQ_ONLY` for any other tenant). The run uses the `approvals` permission; group,
rule, segment and report endpoints use `exec`.

Consolidation combines several **entities** (tenants) into a group view, eliminates the
**intercompany (IC)** balances they owe each other, and reports results **by segment**.

### Run a consolidation (CON-03)

**In the app:** everything below is on the **การรวมงบการเงิน (`/consolidation`)** screen. The
**กลุ่มบริษัท (Groups)** tab has a **สร้างกลุ่มบริษัท (Create group)** form and, when you select a
group, an **เพิ่มบริษัทในกลุ่ม (Add entity)** form + a **นำออก (Remove)** action per entity. The
**รวมงบ (Runs)** tab runs a period and shows a **โพสต์เข้า GL (Post to GL)** button on a completed
(**Final**) run. (The API paths cited below are what those controls invoke.)

1. **Set up the group** — create a group (`POST /api/consolidation/groups`) and add member
   entities with ownership % and currency (`POST /api/consolidation/groups/{id}/entities`) — from
   the **Groups** tab's create-group + add-entity forms.
2. **Run** — `POST /api/consolidation/groups/{id}/run` with the period (`YYYY-MM`). The run:
   - **combines** each member's trial balance (FX-translated, ownership-weighted),
   - **eliminates** in-group IC: for each IC transaction it cancels **1150 Due-From**
     against **2150 Due-To** (the reciprocal receivable/payable),
   - records **NCI** (account 3300) for entities owned < 100%,
   - and **asserts the consolidated trial balance still balances**. If eliminations don't
     net to zero the run is rejected with **`CONSOL_UNBALANCED`** and rolled back.
   Eliminations live at the **group** layer — they are **not** posted into any operating
   entity's books.
3. **Post** — a **different** user presses **โพสต์เข้า GL** on the Final run (`POST
   /api/consolidation/runs/{runId}/post`) to freeze it as the official group result for the
   period. You **cannot post a run you ran** (`SELF_POST`), and a posted period cannot be re-run
   (`ALREADY_POSTED`).

Optional: define configurable elimination rules (`POST /api/consolidation/rules`,
`GET /api/consolidation/rules?group_id=`).

**Expected result:** consolidated TB = Σ entity TBs − IC eliminations, balanced (Σ Dr = Σ Cr);
1150/2150 net to ~0; the run shows `balanced: true`.

### Foreign-currency translation — CTA / OCI (CON-05, IAS 21 / TAS 21)

When a member entity's **currency is not THB**, the run translates it at **two** rates instead of one:

- its **income statement** (revenue / expense) at the **period average** rate, and
- its **balance sheet** at the **closing** (period-end) rate.

The difference between the two is the **cumulative translation adjustment (CTA)**, which the run
parks in a **CTA / OCI translation-reserve** equity line — **account 3400**, line type `FX_CTA`.
This is standard IFRS/TFRS practice (an auditor expects to see it); a THB entity produces no CTA.
Each run line shows the `fx_rate` and `rate_type` (`average` / `closing` / `cta`) it used, and the
run response includes `cta_total`. Rates come from the **Approved** FX rates only (see FX-04); to
get an average rate, enter one or more approved rates dated within the period month.

**Expected result:** P&L accounts are translated at the average rate, balance-sheet accounts at the
closing rate, the 3400 CTA/OCI line equals the translation difference, and the consolidated TB still
balances (`balanced: true`).

### Consolidated statement of cash flows (CON-05, IAS 7)

`GET /api/consolidation/runs/{runId}/cash-flow` produces a **group-level, post-elimination** cash-flow
statement (indirect method) from the consolidated run: **operating** (net income + add-backs +
working-capital movements), **investing**, **financing**, and a dedicated **effect of exchange-rate
changes on cash** section (the CTA). It **reconciles** to the change in the consolidated cash accounts
(`reconciled: true`). HQ (Admin) only, `exec`.

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
