# 99 · Troubleshooting & FAQ

**Status: DRAFT v0.5** _(2026-07-10: added the AR cash-application codes — `OVER_APPLIED`, `APPLY_EXCEEDS_RECEIPT`, `CUSTOMER_MISMATCH`, `INSUFFICIENT_UNAPPLIED`, `CN_OVER_APPLIED`/`CN_NOT_ISSUED`/`CN_NOT_AR_LINKED`, `REASON_REQUIRED`/`ALREADY_REVERSED`; 2026-07-10: added the POS-3 voucher/coupon checkout codes `VOUCHER_*` / `COUPON_*`; 2026-07-09: added `AI_TENANT_OPTED_OUT`; 2026-07-10: added `LINE_NOT_LINKED` / `LINE_NOT_CONFIGURED` / receipt-link `BAD_TOKEN`)_

This chapter explains the **error messages** you may run into, what they mean, and
how to resolve them — followed by frequently asked questions.

---

## Common error messages

When the system blocks an action it shows a short code (and a Thai message). Find
your code below.

### Login & access

| Code | Meaning | What to do |
|------|---------|-----------|
| *Invalid username or password* (a newly created account) | Almost always the **password**, not the username — the username is matched in lowercase with spaces trimmed, so capitalisation/spaces in the username don't matter, but the password is case-sensitive and never trimmed. | Re-type the password (watch Caps Lock and trailing spaces from copy-paste); if it still fails, ask an admin to **Reset password**. If the account was just created, confirm it appears in `/admin/users`. |
| `MFA_REQUIRED` (ต้องใส่รหัสยืนยันสองชั้น) | A two-factor code is required but wasn't entered. | Open your authenticator app and enter the current 6-digit code. |
| `MFA_INVALID` (รหัส OTP ไม่ถูกต้อง) | The 6-digit code was wrong or expired. | Wait for the next code and re-enter. Check your phone's clock. Lost device? Ask an admin to reset MFA. |
| `WEAK_PASSWORD` | New password under 8 characters. | Choose a longer password. |
| `BAD_CURRENT_PASSWORD` | Current password typed incorrectly. | Re-enter your current password. |
| `SAME_PASSWORD` | New password equals the old one. | Choose a different new password. |
| *Menu item missing* | You don't have permission for it. | Ask an admin to grant the role / permission. |

### Sales & POS

| Code | Meaning | What to do |
|------|---------|-----------|
| `CREDIT_HOLD` (ลูกค้าถูกระงับการสั่งซื้อ) | The customer is on credit hold; the order is blocked. | A manager / credit controller must lift the hold, or take payment now. |
| `CREDIT_LIMIT` (เกินวงเงินเครดิต) | The order would exceed the customer's credit limit. | Reduce the order, collect payment on overdue invoices, or have a credit manager raise the limit. |
| `CREDIT_OVERDUE` (ลูกค้ามีหนี้ค้างชำระเกินกำหนด) | The customer has an invoice **90+ days past due** (in default), so new credit orders are blocked even within their limit. | Collect/settle the overdue invoice (or arrange a promise-to-pay) before placing new credit orders; take payment now for a cash sale. |
| `OVER_RETURN` | Returning more than was originally sold. | Check the original sale quantities; return only up to what was bought. |
| `VOUCHER_NOT_FOUND` (ไม่พบคูปอง) | The voucher/coupon code entered at checkout doesn't exist (in this shop). | Re-check the code (codes are per shop); confirm it came from this shop's voucher campaign or the member's wallet. |
| `VOUCHER_NOT_ACTIVE` (แคมเปญคูปองยังไม่เปิดใช้งาน) | The code's campaign hasn't been **approved** yet (or was rejected/ended). | A **different** user than the creator must approve the campaign on `/loyalty/campaigns` (maker-checker, REV-20) before its codes redeem. |
| `VOUCHER_EXPIRED` / `VOUCHER_NOT_STARTED` (คูปองหมดอายุ / ยังไม่เริ่ม) | Today is outside the voucher campaign's validity window. | Honour only in-window vouchers; marketing can create a fresh campaign if extending. |
| `VOUCHER_MIN_SPEND` (ยอดซื้อขั้นต่ำ) | The bill is under the campaign's minimum spend. | Add items to reach the minimum, or settle without the voucher. |
| `VOUCHER_ALREADY_REDEEMED` / `ALREADY_USED` (โค้ด/คูปองถูกใช้แล้ว) | The code was already redeemed — single-use is enforced atomically (two tills racing: exactly one wins). | The code is spent; a customer disputing it can be shown the redemption report (bill no. + time). |
| `VOUCHER_VOID` (โค้ดถูกยกเลิก) | The code was voided by staff. | See the void reason on the campaign's codes list; issue a new code if warranted. |
| `VOUCHER_EXHAUSTED` (คูปองแคมเปญถูกใช้ครบจำนวน) | The campaign-wide redemption cap is reached. | Marketing can extend only via a new approved campaign. |
| `COUPON_KIND_UNSUPPORTED` (คูปองประเภทนี้ใช้เป็นส่วนลดบิลไม่ได้) | A `free_item` wallet coupon was entered as a bill discount. | Redeem free-item coupons via the rewards counter flow (`POST /api/loyalty/coupons/:code/redeem`), not as a checkout discount. |
| `COUPON_NOT_OWNER` (คูปองนี้เป็นของสมาชิกท่านอื่น) | The wallet coupon belongs to a different member than the one on the sale. | Use the coupon-owner's membership on the sale, or remove the member from the bill. |
| `BAD_PACKAGE` (แพ็กเกจบุฟเฟ่ต์ไม่ถูกต้อง) | A reservation pre-picked a buffet package that doesn't exist / is retired, or a package was set on an **à-la-carte** booking. | Switch the booking's service mode to **บุฟเฟ่ต์** before picking a tier, or pick an active package (or leave it as *เลือกที่โต๊ะ*). |
| `CONSENT_REQUIRED` (ยังไม่ได้รับความยินยอม PDPA) | You tried to save a **guest dining profile** (or companion) for a member who hasn't granted the `dining_profile` consent. | Ask the guest for consent and tick the consent checkbox on the profile card — it's recorded in the consent ledger. Without consent the system stores nothing (PDPA). See [Sales & POS → Guest dining profile](./01-sales-and-pos.md). |
| `OPP_NOT_WON` | You tried to turn a sales opportunity into a project before it was **won** (it's still open, or it was lost). | Move the opportunity to **won** in the CRM pipeline first (`PATCH /api/crm/pipeline/opportunities/{no}/stage {stage:"won"}`), then convert it via **Convert to project**. |
| `OPP_NOT_FOUND` | The opportunity number given to *Convert to project* doesn't exist (in your tenant) — also fired by a **CPQ quote** referencing an opportunity id that doesn't exist (CRM-1). | Check the `OPP-…` number / id; create/locate the opportunity in the CRM pipeline first. (Re-converting a deal that already became a project simply returns the existing project — no duplicate is created.) |
| `OPP_CLOSED` (โอกาสการขายปิดแล้ว) | You tried to move or close a deal that is already **won/lost** — closed deals are terminal on every pipeline screen (CRM-1). | A closed deal stays closed. If it genuinely re-opened, create a new opportunity (the stage-history trail keeps the old one auditable). |
| `DUPLICATE_SUSPECT` (พบข้อมูลที่อาจซ้ำ, 409) | Creating a CRM **account/contact** that matches an existing record on the normalized tax id / email / phone / company name. The response lists the matches (`error.details.matches`). | Review the matches — usually you should use (or merge into) the existing record. Resubmit with `force: true` only if it's genuinely a different party. |
| `SOD_VIOLATION` (account merge) | You tried to **merge away an account you created yourself** while it still has contacts/deals to reassign. | A different user performs the merge (maker-checker — one person can't mint a shadow account and fold its pipeline into another record). |
| `MERGE_CONFLICT` (409) | The merge hit a record both accounts own with the same key. | Resolve the collision on one side, then re-run the merge. |
| `SOD_SELF_APPROVAL` (CAPA effectiveness) | You tried to **verify or reject a CAPA you own or created** — QC-02 requires an independent verifier (R21). | Route the effectiveness sign-off to a **different** `quality_approve`/`exec` reviewer. See [Warehouse & Inventory → CAPA](./04-warehouse-inventory.md). |
| `ACTIONS_INCOMPLETE` (CAPA) | You tried to verify a CAPA while a child action is still pending. | Mark every action **done**, then verify. |
| `NO_ACTIONS` (CAPA) | You submitted a CAPA for verification with no action plan. | Add at least one action item before submitting. |
| `NOT_PENDING_VERIFICATION` (CAPA) | You verified/rejected a CAPA that isn't awaiting verification (or is already closed/cancelled). | Submit the CAPA first; a closed/cancelled CAPA is terminal. |
| `REASON_REQUIRED` (CAPA reject) | You rejected a CAPA verification without a reason. | Provide a reject reason. |
| `SOD_SELF_APPROVAL` (standard-cost roll) | You tried to **approve a standard-cost revision you prepared** — COST-02 requires a different approver. | A **different** `exec` user approves it (maker-checker — binds even Admin). Approving rolls the standard forward and posts the revaluation JE. See [Warehouse & Inventory → Standard-cost roll](./04-warehouse-inventory.md) §11a. |
| `STD_ITEM_REQUIRED` (standard-cost roll) | You proposed a new standard for an item that isn't **standard-costed** (its method is FIFO/AVG). | Only STD items carry a standard to roll — set the item's costing method to **STD** on `/costing` first. |
| `NOT_DRAFT` (standard-cost roll, 409) | You tried to approve a revision that is already **Approved**. | The revaluation already posted — no double posting. Raise a new revision to change the standard again. |
| `NO_LINES` (standard-cost roll) | You submitted a revision with no item lines. | Add at least one item + new standard before submitting. |
| `ACCOUNT_NOT_FOUND` | The `ACC-…` account number doesn't exist (in your tenant). | Check the number via `GET /api/crm/accounts?search=`. |
| `TENANT_REQUIRED` (web-to-lead, 400) | Your website's contact form posted to `POST /api/crm/web-to-lead` without a `tenant_code` on a multi-company install (CRM-2). | Ask the administrator to add the company's `tenant_code` to the embedded form. Single-company installs need none. |
| `MISSING_COLUMNS` / `ต้องระบุ 'Name'` (lead import) | The lead import file has no `Name` column, or a row's name is blank (CRM-2). | Download the template from the import dialog; `Name` is the only required column. Blank-name rows are skipped (the rest import) — the validation report lists them per row. |
| `TASK_NOT_FOUND` | You tried to update a project **WBS task** that doesn't exist. | Check the task id; add the task to the project first. |
| `MILESTONE_NOT_FOUND` | You tried to mark a project **milestone** reached that doesn't exist. | Check the milestone id; add the milestone to the project first. |
| `MILESTONE_REACHED` | The milestone was already marked reached. | No action — it's already reached. A billing milestone bills once; it can't be re-reached (that would double-bill). |
| `BAD_PERCENT` | A milestone `billing_percent` was outside the 0–100 range. | Enter a billing percent within (0, 100]. |
| `BAD_ALLOC` | A project resource `alloc_pct` (allocation %) was outside the 0–100 range. | Enter an allocation within (0, 100]. To split a person across projects, give each assignment its share. |
| `SOD_SELF_APPROVAL` (timesheet) | You tried to **approve a timesheet you submitted**. | A different person approves it (maker-checker / segregation of duties — applies even to Admin). Approving posts the labor cost to the project. |
| `SOD_SELF_APPROVAL` (leave) | You tried to **approve a leave request you submitted**. | A different person approves it (maker-checker / segregation of duties). Approving marks the leave approved and, for paid leave, updates the leave balance. |
| `INSUFFICIENT_LEAVE_BALANCE` (HR-02) | A **paid** leave request exceeds the employee's available balance (`entitled + accrued + carryover − used`) for a configured leave type. | Reduce the days, submit as **unpaid** (not gated), or run the leave **accrual** for the period so the entitlement is credited first. A leave type may be set to *allow negative* to relax the gate. |
| `TIMESHEET_NOT_FOUND` | The timesheet id given to *approve* doesn't exist. | Check the timesheet id; submit the timesheet first. |
| `BAD_DEPENDENCY` | A project **task** — or a **project** in a program — was set to depend on itself. | Remove the self-reference; a task's predecessors (`depends_on`), or a project's `depends_on_projects`, must be *other* tasks/projects. |
| `DEP_PROJECT_NOT_FOUND` | A program dependency (`depends_on_projects`) referenced a **project code that doesn't exist**. | Use existing project codes; create the predecessor project first, or correct the code. |
| `PROGRAM_NOT_FOUND` | The program critical-path view was opened for a `program_code` **no project belongs to**. | Assign at least one project to the program via `PATCH /api/projects/{code}/program` (`program_code`). |
| `BASELINE_REASON_REQUIRED` | You tried to **re-baseline** a project that already has an active baseline without giving a `reason`. | Re-baselining is change-controlled (PROJ-07): supply a `reason` so the variance trail records *why* the plan moved. The first baseline needs no reason. |
| `TEMPLATE_EXISTS` | You tried to create a **project template** with a `code` that's already taken. | Choose a different template code (or leave it blank to auto-generate). |
| `TEMPLATE_NOT_FOUND` | The template code given to read/apply doesn't exist. | Check the code against **Templates**; create the template first. |
| `PROJECT_HAS_TASKS` | You tried to **apply a template** to a project that already has tasks. | A template scaffolds a fresh WBS, so it only applies to a project with no tasks yet. Apply it right after creating the project (the create form's *เริ่มจากแม่แบบ* picker does this), or start a new project. |
| `RISK_NOT_FOUND` | The risk/issue id given to update (re-score or close) doesn't exist. | Check the id against the project's **ความเสี่ยง & ปัญหา** register; log the risk first. |
| `NOT_POC` | You tried to **recognise revenue over-time** on a project that isn't set to POC. | Over-time recognition only applies to a project created with `rev_method='poc'`. A billing-method project recognises revenue when you bill. |
| `NO_ESTIMATE` | A POC project has no **estimated total cost (EAC)**, so the cost-to-cost % can't be computed. | Set `estimated_cost` on the project (or pass it to *รับรู้รายได้*), or set a budget — the % = cost-to-date ÷ estimated total cost. |
| `EMPTY_CHANGE_ORDER` | A **change order** was raised with no contract/budget/EAC change. | Enter a non-zero delta on at least one of contract value, budget, or estimated cost. |
| `SOD_SELF_APPROVAL` (change order) | You tried to **approve a change order you requested**. | A different person approves it (maker-checker). Approval applies the contract/budget change and re-baselines the project. |
| `CHANGE_ORDER_DECIDED` | You tried to approve/reject a change order that's already **approved or rejected**. | It's already decided; raise a new change order for any further variation. |
| `LINE_NOT_LINKED` (400) | You clicked **ส่งใบเสร็จเข้า LINE สมาชิก** but the sale has **no loyalty member**, or the member has **not linked their LINE account**. | Attach the member at checkout (member_id) and have the customer link LINE via the shop's Official Account / member portal, then resend. Or use the email/SMS box instead. See [Sales & POS](./01-sales-and-pos.md). |
| `LINE_NOT_CONFIGURED` (400) | LINE e-receipt was requested but the shop's **LINE Messaging API channel token** is not configured (production refuses to fake-send). | An administrator sets the tenant LINE credentials (Settings › ช่องทางข้อความ) or the `LINE_CHANNEL_TOKEN` environment variable. |
| `BAD_TOKEN` (401, receipt link) | A **ดูใบเสร็จฉบับเต็ม** link was altered or is invalid. | Resend the LINE e-receipt to mint a fresh link — the link is a signed one-off token, not a guessable URL. |
| `SOD_SELF_POST` | The same person who **computed** an AR allowance (provision for doubtful accounts) tried to **post** it. | A different reviewer (`gl_post` / `exec`) posts the allowance — the computer can't post their own. See [Finance — AR & AP → Allowance](./05-finance-ar-ap.md). |
| `ALLOWANCE_POSTED` / `ALREADY_POSTED` | You tried to (re)post an AR allowance that is already posted. | A given allowance posts once; to revise, **compute a fresh allowance** for a later `as_of_date`. |

### Procurement & AP

| Code | Meaning | What to do |
|------|---------|-----------|
| `OVER_APPLIED` (ยอดตัดชำระเกินยอดคงค้าง) | A cash-application line is more than the invoice still owes — allocations already **awaiting approval** count too. | Reduce the line to the invoice's *available* amount shown on the worksheet. See [Finance AR/AP §A2b](./05-finance-ar-ap.md). |
| `APPLY_EXCEEDS_RECEIPT` (ยอดตัดชำระรวมเกินเงินรับ) | The invoice allocations add up to more than the receipt amount. | Lower the allocations or raise the receipt amount; leave the rest unallocated — it parks **on-account**. |
| `CUSTOMER_MISMATCH` (เอกสารของลูกค้ารายอื่น) | You tried to apply money (or a credit note) to **another customer's** invoice. | Load the right customer's worksheet; cross-customer application is always rejected. |
| `INSUFFICIENT_UNAPPLIED` (เงินรับรอตัดชำระไม่พอ) | You tried to apply more than the receipt's remaining **on-account** balance (pending batches count). | Check the receipt's *available* on-account amount on the worksheet and re-key. |
| `CN_OVER_APPLIED` / `CN_NOT_ISSUED` / `CN_NOT_AR_LINKED` | The credit note's remaining value is exhausted / the note isn't approved (Issued) yet / the note was issued over a POS sale, not an AR invoice. | Use the remaining value shown; have the note approved first; a POS credit note can't be applied to AR invoices. |
| `REASON_REQUIRED` / `ALREADY_REVERSED` (ยกเลิกตัดชำระ) | You tried to reverse a cash application without a reason — or one that was already reversed. | Enter the reversal reason (it is recorded permanently); an application can only be reversed once. |
| `MATCH_BLOCKED` | The supplier invoice failed the 3-way match (PO ↔ GR ↔ invoice), so it can't be paid. | Investigate the variance (quantity / price). Fix the document, or have an authorised user **override** the match with a reason. See [Procurement](./03-procurement.md). |
| `AP_PREPAID_BLOCKED` | You tried to create a supplier bill that is already paid. | Create the bill **Unpaid**, then request the payment so a second person can approve it (control EXP-06). |
| `AP_OVERPAY` (ยอดจ่ายเกินยอดคงค้าง) | The payment amount exceeds the bill's outstanding balance (including requests already awaiting approval). | Reduce the amount to the remaining balance. |
| `DUPLICATE_INVOICE` (409) | The scanned invoice's number was already received or booked (another intake or AP bill carries it). | Check the earlier document shown in the error. If this really is a separate bill, an accountant can post it deliberately with the *allow duplicate* option. See [Procurement — AP intake](./03-procurement.md). |
| `PO_NOT_APPROVED` (on intake map) | You tried to map a scanned invoice to a PO that is still Draft/Pending or was cancelled. | Have Procurement approve the PO first (or pick the correct approved PO). |
| `INTAKE_AMOUNT_REQUIRED` | The scan didn't yield an invoice amount, so the bill can't be booked. | Re-scan or correct the document text, then post again. For an uploaded photo with AI not configured, map the PO manually and re-key the fields via the text box. |
| `UNSUPPORTED_FILE_TYPE` | The uploaded invoice file isn't a supported type. | Upload a PNG/JPEG/WebP image or a PDF. |
| `FILE_TOO_LARGE` | The uploaded invoice file exceeds the size cap (≈5 MB image / ≈9 MB PDF). | Re-export the scan at a lower resolution or split the PDF. |
| `OVER_RECEIPT` (422) | You keyed a received quantity beyond what the PO ordered (weight items kg/g/ตัน get up to 5% headroom; everything else is capped at the ordered qty). | Recount and key the actual quantity. If the supplier genuinely delivered more, Procurement must amend/raise a PO for the excess first. See [Procurement — Receive goods](./03-procurement.md). |
| `CLAIM_WINDOW_CLOSED` (422) | You tried to open a goods-receipt claim more than 24 hours (configurable) after the receipt — the claim window auto-closed. | The system will no longer take the claim; pursue it with the supplier commercially. Going forward, check deliveries and claim from the receiving summary on the spot. |
| `PO_LINE_CLOSED` (422) | You tried to receive against a PO line that was **closed short** (the shortage decision at the dock). | The close is binding — a new delivery needs a new PO. |
| `SOD_SELF_APPROVAL` (master-data change) | You tried to **approve or reject a sensitive master-data change you requested yourself** (a vendor's bank details / credit limit / payment terms — control MDM-01). | A **different** `masterdata`/`exec` user must release the change — even an Admin can't self-approve. See [Procurement → Sensitive master-data changes](./03-procurement.md). |
| `FIELD_NOT_SENSITIVE` (400) | You submitted a **non-sensitive** field to the master-data change queue. | Non-sensitive vendor fields (contact/phone/address/category/…) edit **directly** on `/inventory/suppliers` — only bank details, credit limit and payment terms route through the maker-checker. |
| `NO_CHANGE` (400) | The value you proposed **equals the current** master value. | Nothing to approve — change the value or cancel. |
| `NO_ELIGIBLE_AP` (400) | Your payment-run proposal found no payable bill for the cutoff — everything is paid, blocked by the 3-way match, or already in another open run. | Check the `skipped` reasons shown, widen the due-date cutoff, or resolve the blocked matches first. See [Finance — B2b payment runs](./05-finance-ar-ap.md). |
| `NOT_DRAFT` (400) | You tried to edit a payment run's lines after it was submitted. | Lines lock at submission. Have the approver reject (or cancel) the run, then propose a corrected one. |
| `SOD_VIOLATION` (payment run) | You tried to approve **or execute** a payment run you proposed yourself. | A **different** person with `approvals`/`gl_close` must approve and execute the run (control EXP-13) — even an Admin can't self-approve. |
| `RUN_NOT_APPROVED` (400) | You asked for the bank transfer file on a run that isn't approved yet. | Get the run approved first — the bank file only ever reflects an approved run. |
| `VENDOR_BANK_MISSING` (400) | A vendor in the run has no bank account recorded, so the bulk-transfer file can't name the beneficiary. | Record the vendor's bank name + account on the vendor master (the change needs a second person's approval, control EXP-11), then download the file again. |
| `UNSUPPORTED_FILE_FORMAT` (400) | The bank-file format you asked for isn't recognised. | Use `generic`, `scb`, `kbank`, `bbl` or `iso20022`. |
| `SOD_VIOLATION` (discount policy) | You tried to **activate an early-payment discount policy you created yourself**. | A **different** person with `approvals`/`gl_close` must activate it (control EXP-14) — even an Admin can't self-activate. See [Finance — B2c early-payment discounts](./05-finance-ar-ap.md). |
| `INVALID_DISCOUNT_PCT` (400) | The discount rate on the policy is zero, negative, or above 30%. | Enter a rate between 0 and 0.30 (0–30%). |
| `NOT_DRAFT` / `NOT_ACTIVE` (discount policy, 400) | You tried to activate/reject a policy that isn't a Draft, or deactivate one that isn't Active. | Only a **Draft** policy can be activated or rejected; only an **Active** policy can be deactivated. |
| `BUDGET_CONFIRM_REQUIRED` (422) | The PR/PO you are approving exceeds the available budget and the company policy is **warn** (BUD-02). | Review the budget chip / availability detail; if the overage is intended, approve again and **confirm** when prompted (the web does this for you), or reject the document. |
| `BUDGET_EXCEEDED` (422) | The PR/PO you are approving exceeds the available budget and the company policy is **block** (BUD-02). | Only an **executive** (exec) can approve over budget, and must give a reason (recorded for audit). Otherwise reduce/postpone the purchase or get the budget increased (budget changes are maker-checker, BUD-01). |
| `BUDGET_OVERRIDE_DENIED` (403) | You tried the over-budget override but don't hold the **exec** duty. | Ask an executive to approve — the override is deliberately a different duty from the ordinary approver. |
| `BUDGET_OVERRIDE_REASON_REQUIRED` (400) | An exec override was sent without a reason. | Enter the business justification when prompted — it is stored on the budget-commitment audit row. |

### Tax documents

| Code | Meaning | What to do |
|---|---|---|
| `INVALID_BUYER_TAXID` (400) | The buyer's 13-digit Tax ID failed the checksum (a mis-keyed digit) when issuing/converting a full tax invoice. | Re-check the number on the customer's ภ.พ.20 / company card and key all 13 digits again. |
| `ABB_VOIDED` (400) | You tried to convert a **voided** abbreviated slip into a full tax invoice. | A voided slip cannot be converted. If the sale was real, issue the full tax invoice from the POS sale instead (`/tax/invoices` → full-invoice card). |
| `NOT_ABBREVIATED` (400) | The document number you entered for conversion is not an abbreviated tax invoice (ATV-…). | Check the slip — conversion applies only to abbreviated invoices; to change a full invoice, use a credit/debit note instead. |

### Finance & General Ledger

| Code | Meaning | What to do |
|------|---------|-----------|
| `PERIOD_CLOSED` | You tried to post to a closed (soft) accounting period. | Post to an open period, or ask a *FinancialController* to reopen the period, post, then close it again. See [General Ledger](./06-general-ledger.md). |
| `PERIOD_LOCKED` | You tried to post into a **hard-closed (Locked)** period. A locked period is irreversible — there is no reopen escape (only the system year-end close can post into it). | Post to an open period. A locked period is final; if a genuine correction is needed it is an out-of-band, audited action by Finance. See [General Ledger → Hard period close](./06-general-ledger.md). |
| `STEPS_INCOMPLETE` | You tried to **lock** a period before all required close-checklist steps were done. | Complete every required step (`POST /api/ledger/close/step`) — the error lists the pending steps — then lock. |
| `SELF_LOCK` | You tried to **lock** a period close that you started yourself (segregation of duties, GL-16). | A **different** `gl_close` colleague must perform the lock. |
| `PERIOD_ALREADY_LOCKED` | You tried to start or update a close run for a period that is already hard-locked. | No action — the period is final. |
| `CLOSE_RUN_NOT_FOUND` / `STEP_NOT_FOUND` | The close run or checklist step referenced doesn't exist. | Check the `close_run_id` / `step_key`; start the close first with `POST /api/ledger/close/start`. |
| `GL_IMMUTABLE` | You tried to edit or delete a **posted** journal entry. Posted entries are immutable (control GL-17) — the ledger is a permanent record. | Don't edit/delete — **reverse** the entry instead (it posts a contra entry that nets to zero), then post a fresh corrected entry. See [General Ledger → Correcting a posted entry](./06-general-ledger.md). |
| `ALREADY_REVERSED` | You tried to reverse a journal entry that has already been reversed. | An entry can be reversed only once. Check the existing reversal entry (linked via *reversal of*); post a new entry if a further adjustment is needed. |
| `NOT_POSTED` | You tried to reverse an entry that isn't **Posted** (e.g. a Draft or Voided entry). | Only posted entries are reversible. A Draft is rejected via the approval flow; a Voided entry needs no reversal. |
| `ENTRY_NOT_FOUND` | The journal entry id given to reverse/void doesn't exist. | Check the entry id. |
| `UNBALANCED` | A journal entry's debits don't equal its credits (or it has no lines) — also raised when saving a **recurring template** that doesn't balance. | Correct the lines so total debits = total credits. |
| `OVERRIDE_ROLE_PINNED` | You tried to re-map a posting-rule role that is a sub-ledger control / structural account (AR, AP, inventory, gift cards, deferred revenue, equity, cash…). | These legs are pinned so reconciliations can't silently break — override only the expense/income roles, or ask the platform team if a widened reconciliation is planned (docs/43 PR-7). |
| `UNKNOWN_POSTING_EVENT` / `UNKNOWN_POSTING_ROLE` / `POSTING_SIDE_MISMATCH` | A posting-rule save named an event or role that isn't in the registry, or the debit/credit side doesn't match the role. | Pick the event/role from the registry list on `/setup/posting-rules` (GET `/api/ledger/posting-rules/registry` shows every role + its side and default). |
| `SOD_VIOLATION` (posting rules) | You tried to approve a posting rule you created yourself. | A **different** user with the posting-rules duty must approve it (GL-24 maker-checker — applies to everyone, including Admin). |
| `INVALID_POSTING_ACCOUNT` | A posting line names an account that doesn't exist in the chart, or a header/deactivated account — from a manual JE line, an item/category posting profile, or a `/setup/posting-rules` override. | Correct the code to a real, postable account (check ผังบัญชี `/chart-of-accounts`); if the account was deactivated, the platform admin can reactivate or you can pick its replacement. |
| `BAD_FREQUENCY` | A recurring journal **or allocation cycle** was created with a cadence other than `daily` / `weekly` / `monthly`. | Choose one of the three supported cadences. |
| `NO_BASIS` / `NO_TARGETS` / `BAD_METHOD` | An **allocation cycle** (cost allocation) was saved with a **zero total basis** (nothing to divide the pool by), **no targets**, or an unknown method (must be `ratio` / `driver` / `statistical`). | Add at least one target with a positive basis weight, and pick a valid method. See [General Ledger → GL allocation cycles](./06-general-ledger.md). |
| `SETTLE_MISMATCH` | When settling a petty-cash advance, the **spend + cash returned** didn't equal the amount advanced. | Re-enter so `settled_expense + returned_cash` exactly equals the advance. See [Finance — AR & AP](./05-finance-ar-ap.md). |
| `ALREADY_SETTLED` | You tried to settle a cash advance that's already settled. | No action needed — it's already accounted for. |
| `OVER_FLOAT` | Establishing a petty-cash fund with an opening amount, replenishing one, **or approving that funding**, would push the fund above its float limit (วงเงิน). | Reduce the amount to within the remaining float (or raise the fund's float limit). Note fund establishment + replenishment are **maker-checked** (EXP-08): the request is checked at raise time and again on approval, and a **second** person approves before any cash posts. |
| `INSUFFICIENT_FLOAT` | A petty-cash **expense / advance draw** exceeds the fund's available balance. | Fund or replenish the fund first (this itself needs an independent approval), or reduce the draw. See [Finance — AR & AP → Petty cash funds](./05-finance-ar-ap.md). |
| `NO_CHANGE` | An asset revaluation was entered at the **current** net book value (nothing to post). | Enter a different value, or cancel. See [General Ledger → Fixed assets](./06-general-ledger.md). |
| `CIP_NOT_OPEN` | You tried to add cost to (or settle) a **construction-in-progress** asset that is no longer Open — it is already pending settlement or has been capitalized. | Open a new CIP for further cost, or act on the pending settlement. See [General Ledger → Construction-in-progress (CIP/AUC)](./06-general-ledger.md). |
| `CIP_NO_COST` | You tried to **settle (capitalize)** a construction-in-progress asset that has no accumulated cost. | Add cost lines first, then request settlement. See [General Ledger → Construction-in-progress (CIP/AUC)](./06-general-ledger.md). |
| `BAD_VALUE` / `BAD_AMOUNT` / `BAD_MONTHS` / `BAD_TERM` | A prepaid / lease / advance / revaluation was created with an invalid number (negative amount, zero/negative term or months). | Enter a positive amount and a positive whole number of months / term. |
| `SOD_VIOLATION` | Self-approval blocked — you can't approve your own document (e.g. your own journal entry, an AP payment you requested, **or a price/promotion rule you created or edited**). | A **different** authorised person must approve/activate it. For a pricing rule this is a user with the **exec** or **approvals** duty on the `/pricing` screen. See [Sales & POS → Approving a price/promotion rule](./01-sales-and-pos.md). *(Exception: a company on the **SME edition** — the "โหมด SME" banner is visible — may self-approve by giving a reason; see the next row.)* |
| `SELF_APPROVAL_REASON_REQUIRED` | Your company runs the **SME edition** (โหมด SME — single operator) and you approved your **own** item without a justification. | Enter the reason when the screen prompts for it (the web asks automatically) — the approval then proceeds. Every self-approval is logged and independently reviewed via the **Self-approval review (SME-01)** report, so write a reason an auditor can understand. |
| `PROFILE_DOWNGRADE_FORBIDDEN` | Someone tried to switch an **Enterprise** company to the SME profile. | Not possible by design — the control profile is upgrade-only (SME → Enterprise). A company that has operated under full segregation of duties cannot weaken its control environment later. |
| `NOT_PENDING` | You tried to approve/reject a JE or AP payment that is no longer pending (already approved/rejected). | Refresh the queue; the item was already actioned. |
| `ALREADY_PAID` | You recorded a dunning / collections action against an invoice that's already fully paid. | No action needed — the invoice is settled; remove it from your follow-up list. |
| `INVALID_STAGE` | An unrecognised dunning stage was sent. | Use one of: `reminder`, `first_notice`, `second_notice`, `final_notice`, `legal`. |
| `CREDIT_LIMIT_EXCEEDED` / `SERIOUS_OVERDUE` / `WOULD_EXCEED_LIMIT` | A credit check **declined** further credit — the customer is over their limit, 90+ days overdue, or this order would breach the limit. | Collect on overdue invoices, reduce the order, or have a *Credit Manager* review the limit. See [Finance — AR & AP](./05-finance-ar-ap.md). |
| `NOT_ON_HOLD` | You tried to **release** a credit hold on a customer who isn't on hold. | No action needed — the account is already clear. |
| `SOD_SELF_RELEASE` | You tried to release a credit hold that **you placed**. | A **different** person (an *approver*) must lift the hold — the placer can't release their own hold. See [Finance — AR & AP](./05-finance-ar-ap.md). |
| `Cash flow shows reconciled: false` | The statement of cash flows didn't tie out to the change in cash — an account isn't classified. | Note the `unclassified_accounts` in the response and raise it with finance / engineering; the figure may be mis-stated until fixed. |
| `BAD_TRANSITION` | A maintenance work order was moved out of order (e.g. `open → completed` skipping `in_progress`, or changed after it was completed/cancelled). | Follow the lifecycle **open → in_progress → completed** (or **cancelled**). See [General Ledger → Asset maintenance](./06-general-ledger.md). |
| `ASSET_NOT_FOUND` | A work order or maintenance action referenced an asset that isn't in the register. | Capitalise the asset first (`POST /api/assets`), then raise the work order against its asset number. |
| `COA_ADMIN_ONLY` | You tried to change a **master (canonical) account** — create / rename / deactivate — but the master chart is shared across all companies, so only the **platform administrator (HQ)** may change it. | To tailor **your own** chart (turn an account on/off, rename, reorder) use the curation options with permission `gl_coa`; for a genuinely new master code, ask your platform administrator. See [General Ledger → Managing the chart](./06-general-ledger.md). |
| `DUPLICATE_ACCOUNT` | You tried to create a master account whose code already exists. | Use a different code, or edit the existing account. |
| `ACCOUNT_HAS_BALANCE` | You tried to deactivate an account that still carries a non-zero balance. | Clear the balance with a correcting journal entry first, then deactivate. |
| `CODE_HAS_POSTINGS` | You tried to turn off postability on an account that already has posted entries. | Leave it postable; use an *effective-to* date to date-fence it instead. |
| `ACCOUNT_NOT_FOUND` | You curated a chart entry for a code that isn't in the master chart. | Curate an **existing** master code; a brand-new code is added by the platform administrator. |
| `TENANT_REQUIRED` | Chart curation was attempted without a company context (e.g. a head-office/global session). | Sign in to the specific company whose chart you're curating. |

### Consolidation

| Code | Meaning | What to do |
|------|---------|-----------|
| `CONSOL_HQ_ONLY` | A non-HQ tenant tried a consolidation action. | Consolidation is HQ (Admin) only — run it from the HQ tenant. |
| `GROUP_NOT_FOUND` | The consolidation group id doesn't exist. | Verify the group id (`GET /api/consolidation/groups`). |
| `NO_ENTITIES` | You ran a group that has no active member entities. | Add entities first (`POST /api/consolidation/groups/{id}/entities`). |
| `CONSOL_UNBALANCED` | The consolidated trial balance didn't balance after eliminations (the IC pairs don't net to zero). | The run was rolled back. Reconcile the IC balances (`GET /api/intercompany/reconciliation`) so 1150/2150 agree, then re-run. See [General Ledger → Consolidation](./06-general-ledger.md). |
| `SELF_POST` | You tried to **post** a consolidation run that **you ran**. | A **different** person must post the run (maker-checker). |
| `ALREADY_POSTED` | You re-ran or re-posted a period that's already **Posted**. | The group result for that period is frozen — no action needed. |
| `CONSOL_RUN_NOT_FOUND` | The run id passed to post doesn't exist. | Verify the run id (`GET /api/consolidation/groups/{id}/runs`). |

### Reports & Analytics

| Code | Meaning | What to do |
|------|---------|-----------|
| `BI_BAD_PERIOD` (ช่วงเวลาไม่ถูกต้อง) | The sales-cube report was asked to group by a period grain other than `day`, `week`, or `month`. | Use one of `day`, `week`, or `month` for the period. Previously an unrecognised value silently returned monthly buckets; it is now rejected so the result always matches what you asked for. See [Reports & Analytics](./09-reports-and-analytics.md). |
| `FS_DEF_NOT_FOUND` (ไม่พบรูปแบบรายงาน) | A statutory-FS layout code that does not exist was requested. | Check the code, or create it via `POST /api/reports/fs/definitions`. See [General Ledger → Statutory FS pack](./06-general-ledger.md). |
| `FS_NOT_RENDERABLE` / `FS_NOT_NOTES` | `render` was called on a `soce`/`notes` layout, or `notes` on a non-notes layout. | Use the dedicated endpoint: `render` for `pl`/`bs`, `changes-in-equity` for SOCE, `notes/:code` for notes. |
| `FS_ASOF_REQUIRED` / `FS_FROM_REQUIRED` / `FS_RANGE_REQUIRED` | A required date is missing (`as_of` for a statement, `from` for a P&L, `from`+`to` for SOCE). | Supply the missing query parameter. |
| `FS_BAD_STATEMENT_TYPE` / `FS_BAD_FISCAL_YEAR` | An invalid `statement_type` (not `bs`/`pl`/`soce`/`notes`) or a missing/invalid `fiscal_year`. | Use a valid value. |

### Administration

| Code | Meaning | What to do |
|------|---------|-----------|
| `SOD_CONFLICT` | You tried to grant a user two conflicting duties. | Remove one duty or assign it to another person. See the SoD report at `/sod` and [Administration](./11-administration.md). |
| `SOD_SELF_APPROVAL` (Certificate of Analysis) | You tried to **release an out-of-spec lot on a CoA you recorded**. | A **different** person holding **Quality approver** (`quality_approve`/`exec`) must approve the deviation release. This is the QC-03 maker-checker (SoD R21). See [Warehouse & Inventory](./04-warehouse-inventory.md) §12. |
| `DEVIATION_APPROVER_REQUIRED` / `DEVIATION_REASON_REQUIRED` / `COA_NOT_EVALUATED` / `COA_NOT_HELD` | Releasing an out-of-spec lot without the approver duty, without a deviation reason, before evaluating the CoA, or on an already-decided CoA. | Route the release to a `quality_approve`/`exec` user, enter a **deviation reason**, **evaluate** the measured results first, and only act on a CoA still **held**. See [Warehouse & Inventory](./04-warehouse-inventory.md) §12 (control **QC-03**). |
| `SOD_SELF_APPROVAL` (cycle count) | You tried to **post the variance on a cycle count you counted yourself**. | A **different** `wh_adjust` (InventoryController) user must post the variance — the counter can't approve their own count (SoD R11 / control **INV-17**/INV-04). See [Warehouse & Inventory](./04-warehouse-inventory.md) §7b. |
| `NO_ITEMS_DUE` / `TASK_CANCELLED` | You generated a cycle count with no items when nothing is due, or entered a count against a cancelled task. | **Recompute ABC** and wait for the class cadence, or pass explicit items to count; for a cancelled task, generate a new one. See [Warehouse & Inventory](./04-warehouse-inventory.md) §7b (control **INV-17**). |
| `SOD_VIOLATION` (company profile) | You tried to **approve your own** staged change to the **PromptPay ID** or **tax ID** on the company profile. | A **different** authorised user (with **Exec / Approvals**) must approve it — the person who requested the change can't release it. Until approved the old value stays in force; the request can also be rejected. See [Administration](./11-administration.md) §13. |
| `ADMIN_GRANT_DENIED` | You tried to create or promote a user to the **Admin** role, but you are not the platform owner. | **Only the platform owner may grant the Admin role** (it carries cross-company visibility). A company Admin can manage every **non-Admin** role. Ask the platform owner if a new Admin is genuinely required. See [Administration](./11-administration.md) §1. |
| `ITEMS_PENDING` | You tried to **certify an access recertification campaign** while one or more users are still undecided. | Finish the worklist — click **Keep** or **Revoke** for every user — then certify. See [Administration](./11-administration.md) §4.1 (control **ITGC-AC-21**). |
| `CAMPAIGN_CERTIFIED` | You tried to change a keep/revoke line, or re-certify, on a **campaign that is already certified**. | A certified campaign is frozen audit evidence. Open a **new** campaign for the next period. See [Administration](./11-administration.md) §4.1. |
| `SIGNUP_DISABLED` / request-access | Someone tried to self-open a company. Public self-service signup is **disabled in production**. | The public page now files a **request access** entry instead of creating a company. The platform owner reviews the queue and **approves** it (or provisions/invites directly). No company exists until the platform owner approves. See [Administration](./11-administration.md) §14. |
| `ITEM_PURGE_HQ_ONLY` (403) | A company Admin tried to run the unused-product cleanup. | The product catalogue is **shared across all companies**, so only the **platform owner** may garbage-collect unused products. Ask the platform owner. See [Administration](./11-administration.md) §8.1. |
| `CONFIRM_MISMATCH` (unused-product purge) | You called the purge without the exact confirm phrase. | Send `{ "confirm": "PURGE-UNUSED-ITEMS" }` exactly. Preview first with `GET /api/admin/item-maintenance/unused-items`. See [Administration](./11-administration.md) §8.1. |
| `RESERVED_USERNAME` | A company was being provisioned (signup / request / platform-owner create) with an admin **username that is a configured platform owner**. | Choose a different admin username. Platform-owner usernames carry a cross-company bypass and are never assigned to a company admin through the tenant provisioning path. |
| `BAD_ISSUER` | You saved an **SSO / OIDC** configuration whose **Issuer URL** isn't a valid `https://` address. | Enter the IdP's issuer as a full `https://` URL (e.g. `https://login.microsoftonline.com/…`). Internal/localhost addresses are also refused when the server contacts the IdP (`SSRF_BLOCKED`) — the issuer must be a public https endpoint. |

### AI assistant

| Code | Meaning | What to do |
|------|---------|-----------|
| `AI_DPA_REQUIRED` | AI is turned off because the data-processing agreement with the AI provider has not been acknowledged on this deployment. | An administrator must complete and acknowledge the DPA, then set `AI_DPA_ACKNOWLEDGED`. Until then the assistant and AI-assisted tools fall back to non-AI behaviour. See [Administration](./11-administration.md). |
| `AI_TENANT_OPTED_OUT` | Your company has opted out of external AI processing (PDPA right to object), so the AI assistant will not send data to the AI provider. | An administrator can re-enable it at **Settings › Labs & AI** (`/settings/labs`) — the toggle "AI ภายนอก: อนุญาตส่งข้อมูลให้ผู้ให้บริการ AI". Non-chat AI features keep working on their built-in non-AI logic while opted out. |
| `AI_BUDGET_EXCEEDED` | You reached your plan's **daily AI token ceiling** (the hard cut-off, not the included allowance). | It resets at midnight (Bangkok time). On Pro/Enterprise, usage between the included daily allowance and the ceiling is allowed and billed as **metered overage** (see the AI-usage card on the Billing page for tokens used and the projected overage charge); the ceiling is the absolute stop. Upgrade for a higher allowance/ceiling. |
| `AI_UNAVAILABLE` | The AI assistant is not configured (no API key). | Ask an administrator to configure the AI provider key. |

---

## Frequently asked questions

**The screen is in Thai — can I change it to English?**
Yes. Use the language switcher in the top bar / settings. Page addresses and steps
are the same in either language. This manual lists English wording with the Thai
label in brackets.

**Why can't I see a menu item that a colleague has?**
Menus show only what your role / permissions allow. Ask an administrator to grant
the relevant access (see [Administration](./11-administration.md)).

**I lost my phone and can't get my 2-factor code. How do I get back in?**
Contact your administrator. They can reset MFA on your account so you can enrol a
new device.

**Do I need MFA?**
If your role touches finance, approvals, user administration or sensitive master
data — or you're an Admin — yes. Cashiers, customers and view-only users are
exempt. See [Getting Started](./00-getting-started.md).

**Why was my order blocked?**
Most likely a credit check: `CREDIT_HOLD` (customer suspended) or `CREDIT_LIMIT`
(over the limit). See the Sales & POS errors above.

**Why can't I pay this supplier invoice?**
It probably hasn't passed the 3-way match (`MATCH_BLOCKED`). Resolve the match or
have it overridden. See [Procurement](./03-procurement.md).

**Why can't I approve my own document?**
By design (maker-checker). A different authorised person must approve it
(`SOD_VIOLATION`). See [Approvals](./10-approvals.md).

**My session logged me out unexpectedly.**
Sessions expire after a period of inactivity for security. Simply sign in again.

**The camera "Scan QR" button doesn't appear (or won't open the camera).**
The button shows on any modern browser **with a camera**, over **HTTPS**. If it's
missing, the device has no camera the browser can use (e.g. some desktops) — use a
hardware wedge scanner or type/paste the code. If the button appears but the camera
won't start, your browser blocked camera access: allow the camera permission for
the site and try again. The scanner reads both QR codes and common 1D barcodes
(EAN/UPC, Code-128, Code-39). You can always enter the code manually.

**I set up a petty-cash fund with an opening amount (or topped one up) but no cash posted.**
By design (EXP-08). Establishing a fund with an initial amount, and every
**replenishment**, now raise a **pending funding request** that a **different**
authorised user (`creditors` / `exec`) must approve on the petty-cash **Maker-checker**
tab — it also shows in the **Approvals** queue. Only on their approval does the cash
post (**Dr 1015 Petty Cash / Cr 1000 Cash**) and the fund balance rise; the fund holds
no cash until then. You **cannot approve your own** funding request (`SOD_VIOLATION`),
and an amount over the fund's float limit is rejected (`OVER_FLOAT`).

**I scanned an asset to move it, but the register didn't change.**
By design (FA-11). Changing an asset's location or holder is a **request** that a
**different** person must approve — it appears on the assets **Custody approvals**
(อนุมัติย้ายทรัพย์สิน) tab, and the register only moves once approved. Just
*confirming* an asset is where the register says needs no approval. You cannot
approve your own request (`SOD_VIOLATION`).

**I scanned an asset/item QR with my phone's normal camera and it opened a web page.**
That's expected when your deployment prints deep-link tags: the phone opens the
resolver page (`/q`), which shows what you scanned and links into the app (you may
be asked to log in first). If instead the phone shows raw text like
`ASSET_ID:FA-0001|…`, your tags aren't configured as deep links — scan them with
the in-app camera scanner or a hardware scanner.

**Can I see other shops' data?**
No. Each organisation is a separate tenant; you only ever see your own data.

**I reset (factory-reset / purged) a company, but its products still show in *เลือกซื้อสินค้า* (the shop).**
That's expected. The **product catalogue is shared by all companies** — products have no
company owner — so a company reset wipes its *business data* but leaves the products it
added in the **shared catalogue**, where they keep appearing in every company's shop. To
remove them, the **platform owner** runs the unused-product cleanup from **ศูนย์ควบคุมแพลตฟอร์ม**
(`/platform`) → the **ดูแลระบบ (Maintenance)** tab → **ตรวจสอบ** (preview) then **ลบ** (with a confirm
dialog). *(Same thing via the API: `GET /api/admin/item-maintenance/unused-items` then
`POST /api/admin/item-maintenance/purge-unused-items` with `{ "confirm": "PURGE-UNUSED-ITEMS" }`.)*
It removes only products **no company references** any more (one another company still has
on a PO, in stock, on a recipe/BoM, … is kept). See [Administration](./11-administration.md) §8.1.

**Where do I download Excel / PDF reports?**
From each module's report area — see [Reports & Analytics](./09-reports-and-analytics.md).

**I forgot the admin password and no one can log in.**
There is no "forgot password" email and no default credential (by design). If
another admin or an Access Admin can still sign in, they reset it from
**Admin → Users** (the user is forced to set a new password on next login). If
**nobody** can log in, an operator with server/database access runs the recovery
tool: `NEW_ADMIN_PASSWORD='…' pnpm --filter @ierp/api db:reset-password <username>`
(defaults to `admin`; the password comes from the env var, never argv or a log;
`CLEAR_MFA=1` also drops a lost TOTP device). It sets a new password
(never logged), forces a change on next login, clears any login lockout, and
revokes existing sessions.

**Who do I contact for help?**
Your organisation's administrator first (for access, passwords, MFA, module
toggles). For issues they can't resolve, escalate to your support contact:
`kittipot.c@oshinei.onmicrosoft.com`.

---

**Back to:** [Manual index](./README.md)
