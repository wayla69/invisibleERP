# 99 · Troubleshooting & FAQ

**Status: DRAFT v0.1**

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
| `OPP_NOT_WON` | You tried to turn a sales opportunity into a project before it was **won** (it's still open, or it was lost). | Move the opportunity to **won** in the CRM pipeline first (`PATCH /api/crm/pipeline/opportunities/{no}/stage {stage:"won"}`), then convert it via **Convert to project**. |
| `OPP_NOT_FOUND` | The opportunity number given to *Convert to project* doesn't exist (in your tenant). | Check the `OPP-…` number; create/locate the opportunity in the CRM pipeline first. (Re-converting a deal that already became a project simply returns the existing project — no duplicate is created.) |
| `TASK_NOT_FOUND` | You tried to update a project **WBS task** that doesn't exist. | Check the task id; add the task to the project first. |
| `MILESTONE_NOT_FOUND` | You tried to mark a project **milestone** reached that doesn't exist. | Check the milestone id; add the milestone to the project first. |
| `MILESTONE_REACHED` | The milestone was already marked reached. | No action — it's already reached. A billing milestone bills once; it can't be re-reached (that would double-bill). |
| `BAD_PERCENT` | A milestone `billing_percent` was outside the 0–100 range. | Enter a billing percent within (0, 100]. |
| `BAD_ALLOC` | A project resource `alloc_pct` (allocation %) was outside the 0–100 range. | Enter an allocation within (0, 100]. To split a person across projects, give each assignment its share. |
| `SOD_SELF_APPROVAL` (timesheet) | You tried to **approve a timesheet you submitted**. | A different person approves it (maker-checker / segregation of duties — applies even to Admin). Approving posts the labor cost to the project. |
| `TIMESHEET_NOT_FOUND` | The timesheet id given to *approve* doesn't exist. | Check the timesheet id; submit the timesheet first. |
| `BAD_DEPENDENCY` | A project **task** was set to depend on itself. | Remove the self-reference; a task's predecessors (`depends_on`) must be *other* tasks. |
| `BASELINE_REASON_REQUIRED` | You tried to **re-baseline** a project that already has an active baseline without giving a `reason`. | Re-baselining is change-controlled (PROJ-07): supply a `reason` so the variance trail records *why* the plan moved. The first baseline needs no reason. |
| `TEMPLATE_EXISTS` | You tried to create a **project template** with a `code` that's already taken. | Choose a different template code (or leave it blank to auto-generate). |
| `TEMPLATE_NOT_FOUND` | The template code given to read/apply doesn't exist. | Check the code against **Templates**; create the template first. |
| `PROJECT_HAS_TASKS` | You tried to **apply a template** to a project that already has tasks. | A template scaffolds a fresh WBS, so it only applies to a project with no tasks yet. Apply it right after creating the project (the create form's *เริ่มจากแม่แบบ* picker does this), or start a new project. |
| `RISK_NOT_FOUND` | The risk/issue id given to update (re-score or close) doesn't exist. | Check the id against the project's **ความเสี่ยง & ปัญหา** register; log the risk first. |
| `SOD_SELF_POST` | The same person who **computed** an AR allowance (provision for doubtful accounts) tried to **post** it. | A different reviewer (`gl_post` / `exec`) posts the allowance — the computer can't post their own. See [Finance — AR & AP → Allowance](./05-finance-ar-ap.md). |
| `ALLOWANCE_POSTED` / `ALREADY_POSTED` | You tried to (re)post an AR allowance that is already posted. | A given allowance posts once; to revise, **compute a fresh allowance** for a later `as_of_date`. |

### Procurement & AP

| Code | Meaning | What to do |
|------|---------|-----------|
| `MATCH_BLOCKED` | The supplier invoice failed the 3-way match (PO ↔ GR ↔ invoice), so it can't be paid. | Investigate the variance (quantity / price). Fix the document, or have an authorised user **override** the match with a reason. See [Procurement](./03-procurement.md). |
| `AP_PREPAID_BLOCKED` | You tried to create a supplier bill that is already paid. | Create the bill **Unpaid**, then request the payment so a second person can approve it (control EXP-06). |
| `AP_OVERPAY` (ยอดจ่ายเกินยอดคงค้าง) | The payment amount exceeds the bill's outstanding balance (including requests already awaiting approval). | Reduce the amount to the remaining balance. |

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
| `BAD_FREQUENCY` | A recurring journal was created with a cadence other than `daily` / `weekly` / `monthly`. | Choose one of the three supported cadences. |
| `SETTLE_MISMATCH` | When settling a petty-cash advance, the **spend + cash returned** didn't equal the amount advanced. | Re-enter so `settled_expense + returned_cash` exactly equals the advance. See [Finance — AR & AP](./05-finance-ar-ap.md). |
| `ALREADY_SETTLED` | You tried to settle a cash advance that's already settled. | No action needed — it's already accounted for. |
| `NO_CHANGE` | An asset revaluation was entered at the **current** net book value (nothing to post). | Enter a different value, or cancel. See [General Ledger → Fixed assets](./06-general-ledger.md). |
| `BAD_VALUE` / `BAD_AMOUNT` / `BAD_MONTHS` / `BAD_TERM` | A prepaid / lease / advance / revaluation was created with an invalid number (negative amount, zero/negative term or months). | Enter a positive amount and a positive whole number of months / term. |
| `SOD_VIOLATION` | Self-approval blocked — you can't approve your own document (e.g. your own journal entry, **or an AP payment you requested**). | A **different** authorised person must approve it. |
| `NOT_PENDING` | You tried to approve/reject a JE or AP payment that is no longer pending (already approved/rejected). | Refresh the queue; the item was already actioned. |
| `ALREADY_PAID` | You recorded a dunning / collections action against an invoice that's already fully paid. | No action needed — the invoice is settled; remove it from your follow-up list. |
| `INVALID_STAGE` | An unrecognised dunning stage was sent. | Use one of: `reminder`, `first_notice`, `second_notice`, `final_notice`, `legal`. |
| `CREDIT_LIMIT_EXCEEDED` / `SERIOUS_OVERDUE` / `WOULD_EXCEED_LIMIT` | A credit check **declined** further credit — the customer is over their limit, 90+ days overdue, or this order would breach the limit. | Collect on overdue invoices, reduce the order, or have a *Credit Manager* review the limit. See [Finance — AR & AP](./05-finance-ar-ap.md). |
| `NOT_ON_HOLD` | You tried to **release** a credit hold on a customer who isn't on hold. | No action needed — the account is already clear. |
| `SOD_SELF_RELEASE` | You tried to release a credit hold that **you placed**. | A **different** person (an *approver*) must lift the hold — the placer can't release their own hold. See [Finance — AR & AP](./05-finance-ar-ap.md). |
| `Cash flow shows reconciled: false` | The statement of cash flows didn't tie out to the change in cash — an account isn't classified. | Note the `unclassified_accounts` in the response and raise it with finance / engineering; the figure may be mis-stated until fixed. |
| `BAD_TRANSITION` | A maintenance work order was moved out of order (e.g. `open → completed` skipping `in_progress`, or changed after it was completed/cancelled). | Follow the lifecycle **open → in_progress → completed** (or **cancelled**). See [General Ledger → Asset maintenance](./06-general-ledger.md). |
| `ASSET_NOT_FOUND` | A work order or maintenance action referenced an asset that isn't in the register. | Capitalise the asset first (`POST /api/assets`), then raise the work order against its asset number. |

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

### Administration

| Code | Meaning | What to do |
|------|---------|-----------|
| `SOD_CONFLICT` | You tried to grant a user two conflicting duties. | Remove one duty or assign it to another person. See the SoD report at `/sod` and [Administration](./11-administration.md). |
| `ADMIN_GRANT_DENIED` | A non-Admin tried to grant the Admin role. | Only an existing Admin can grant Admin. Ask an administrator. |

### AI assistant

| Code | Meaning | What to do |
|------|---------|-----------|
| `AI_DPA_REQUIRED` | AI is turned off because the data-processing agreement with the AI provider has not been acknowledged on this deployment. | An administrator must complete and acknowledge the DPA, then set `AI_DPA_ACKNOWLEDGED`. Until then the assistant and AI-assisted tools fall back to non-AI behaviour. See [Administration](./11-administration.md). |
| `AI_BUDGET_EXCEEDED` | Your plan's daily AI token allowance is used up. | It resets at midnight (Bangkok time). Heavy users on the Enterprise tier accrue metered overage instead of a hard stop within their ceiling. Upgrade your plan for a higher daily allowance. |
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

**Can I see other shops' data?**
No. Each organisation is a separate tenant; you only ever see your own data.

**Where do I download Excel / PDF reports?**
From each module's report area — see [Reports & Analytics](./09-reports-and-analytics.md).

**Who do I contact for help?**
Your organisation's administrator first (for access, passwords, MFA, module
toggles). For issues they can't resolve, escalate to your support contact:
`<<support email / phone>>`.

---

**Back to:** [Manual index](./README.md)
