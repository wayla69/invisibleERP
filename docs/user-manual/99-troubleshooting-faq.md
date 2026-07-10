# 99 · Troubleshooting & FAQ

**Status: DRAFT v0.3** _(2026-07-10: added the AR cash-application codes — `OVER_APPLIED`, `APPLY_EXCEEDS_RECEIPT`, `CUSTOMER_MISMATCH`, `INSUFFICIENT_UNAPPLIED`, `CN_OVER_APPLIED`/`CN_NOT_ISSUED`/`CN_NOT_AR_LINKED`, `REASON_REQUIRED`/`ALREADY_REVERSED`)_

*v0.2 (2026-07-09): added `AI_TENANT_OPTED_OUT`.*

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
| `BAD_PACKAGE` (แพ็กเกจบุฟเฟ่ต์ไม่ถูกต้อง) | A reservation pre-picked a buffet package that doesn't exist / is retired, or a package was set on an **à-la-carte** booking. | Switch the booking's service mode to **บุฟเฟ่ต์** before picking a tier, or pick an active package (or leave it as *เลือกที่โต๊ะ*). |
| `CONSENT_REQUIRED` (ยังไม่ได้รับความยินยอม PDPA) | You tried to save a **guest dining profile** (or companion) for a member who hasn't granted the `dining_profile` consent. | Ask the guest for consent and tick the consent checkbox on the profile card — it's recorded in the consent ledger. Without consent the system stores nothing (PDPA). See [Sales & POS → Guest dining profile](./01-sales-and-pos.md). |
| `OPP_NOT_WON` | You tried to turn a sales opportunity into a project before it was **won** (it's still open, or it was lost). | Move the opportunity to **won** in the CRM pipeline first (`PATCH /api/crm/pipeline/opportunities/{no}/stage {stage:"won"}`), then convert it via **Convert to project**. |
| `OPP_NOT_FOUND` | The opportunity number given to *Convert to project* doesn't exist (in your tenant). | Check the `OPP-…` number; create/locate the opportunity in the CRM pipeline first. (Re-converting a deal that already became a project simply returns the existing project — no duplicate is created.) |
| `TASK_NOT_FOUND` | You tried to update a project **WBS task** that doesn't exist. | Check the task id; add the task to the project first. |
| `MILESTONE_NOT_FOUND` | You tried to mark a project **milestone** reached that doesn't exist. | Check the milestone id; add the milestone to the project first. |
| `MILESTONE_REACHED` | The milestone was already marked reached. | No action — it's already reached. A billing milestone bills once; it can't be re-reached (that would double-bill). |
| `BAD_PERCENT` | A milestone `billing_percent` was outside the 0–100 range. | Enter a billing percent within (0, 100]. |
| `BAD_ALLOC` | A project resource `alloc_pct` (allocation %) was outside the 0–100 range. | Enter an allocation within (0, 100]. To split a person across projects, give each assignment its share. |
| `SOD_SELF_APPROVAL` (timesheet) | You tried to **approve a timesheet you submitted**. | A different person approves it (maker-checker / segregation of duties — applies even to Admin). Approving posts the labor cost to the project. |
| `SOD_SELF_APPROVAL` (leave) | You tried to **approve a leave request you submitted**. | A different person approves it (maker-checker / segregation of duties). Approving marks the leave approved and, for paid leave, updates the leave balance. |
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
| `OVER_FLOAT` | Establishing a petty-cash fund with an opening amount, replenishing one, **or approving that funding**, would push the fund above its float limit (วงเงิน). | Reduce the amount to within the remaining float (or raise the fund's float limit). Note fund establishment + replenishment are **maker-checked** (EXP-08): the request is checked at raise time and again on approval, and a **second** person approves before any cash posts. |
| `INSUFFICIENT_FLOAT` | A petty-cash **expense / advance draw** exceeds the fund's available balance. | Fund or replenish the fund first (this itself needs an independent approval), or reduce the draw. See [Finance — AR & AP → Petty cash funds](./05-finance-ar-ap.md). |
| `NO_CHANGE` | An asset revaluation was entered at the **current** net book value (nothing to post). | Enter a different value, or cancel. See [General Ledger → Fixed assets](./06-general-ledger.md). |
| `BAD_VALUE` / `BAD_AMOUNT` / `BAD_MONTHS` / `BAD_TERM` | A prepaid / lease / advance / revaluation was created with an invalid number (negative amount, zero/negative term or months). | Enter a positive amount and a positive whole number of months / term. |
| `SOD_VIOLATION` | Self-approval blocked — you can't approve your own document (e.g. your own journal entry, an AP payment you requested, **or a price/promotion rule you created or edited**). | A **different** authorised person must approve/activate it. For a pricing rule this is a user with the **exec** or **approvals** duty on the `/pricing` screen. See [Sales & POS → Approving a price/promotion rule](./01-sales-and-pos.md). |
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

### Administration

| Code | Meaning | What to do |
|------|---------|-----------|
| `SOD_CONFLICT` | You tried to grant a user two conflicting duties. | Remove one duty or assign it to another person. See the SoD report at `/sod` and [Administration](./11-administration.md). |
| `SOD_VIOLATION` (company profile) | You tried to **approve your own** staged change to the **PromptPay ID** or **tax ID** on the company profile. | A **different** authorised user (with **Exec / Approvals**) must approve it — the person who requested the change can't release it. Until approved the old value stays in force; the request can also be rejected. See [Administration](./11-administration.md) §13. |
| `ADMIN_GRANT_DENIED` | You tried to create or promote a user to the **Admin** role, but you are not the platform owner. | **Only the platform owner may grant the Admin role** (it carries cross-company visibility). A company Admin can manage every **non-Admin** role. Ask the platform owner if a new Admin is genuinely required. See [Administration](./11-administration.md) §1. |
| `SIGNUP_DISABLED` / request-access | Someone tried to self-open a company. Public self-service signup is **disabled in production**. | The public page now files a **request access** entry instead of creating a company. The platform owner reviews the queue and **approves** it (or provisions/invites directly). No company exists until the platform owner approves. See [Administration](./11-administration.md) §14. |
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
