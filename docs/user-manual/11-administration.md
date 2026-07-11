# 11 · Administration

**Status: DRAFT v0.16 · 2026-07-07** · *v0.16 (2026-07-07): §13 — added a **fax** field to the Company
info form (`/setup`); it prints alongside phone in the full tax invoice (ม.86/4) header. Saves immediately
like phone (not a maker-checker field).* · *v0.15 (2026-07-06): §13 — documented **where the G15 company-profile approval queue lives in the app**: a **"Financial-profile changes pending approval"** card on the **Company Setup** screen (`/setup`), where a **different** exec/approvals user approves/rejects the staged PromptPay/tax-ID change. UI surfacing of an already-shipped control — no new endpoint, no new numbered control.* · *v0.14 (2026-07-06): §13 — a change to the **PromptPay ID** or **tax ID** on the company profile is now a two-person maker-checker: it is staged **pending approval** and a **different** exec/approvals user must approve it before it takes effect (self-approval → `SOD_VIOLATION`); all other company-info fields still save immediately, and a no-op never stages (G15; strengthens SoD R02; no new numbered control).* · *v0.13 (2026-07-05): §8 — a bulk master-data import that **sets** a financially-sensitive field (customer/vendor credit limit, vendor payment term, price-list price, promotion discount) is now a two-person maker-checker: it is staged **pending approval** and a **different** exec/approvals user must approve before anything is written (self-approval → `SOD_VIOLATION`); ordinary imports are unaffected (audit gaps G5+G8; strengthens SoD R02/R09/R10/R13).* · *v0.12 (2026-07-05): §2.2 — granting an SoD-conflicting set with a justified override is now a two-person maker-checker; it stages a **Pending SoD-exception** request that a **different** admin (≠ requester, ≠ the affected user) must approve/reject (self-approval → `SOD_VIOLATION`), with the who/why/rules recorded in the audit trail (audit gap G11, part b).* · *v0.11 (2026-07-05): §2.1 role definitions (in-app Role guide); §1/§2 only the platform owner may grant the **Admin** role (`ADMIN_GRANT_DENIED`); §14 company creation is god-only in prod (public signup → request-access); FAQ entries added.* · *v0.10 (2026-07-05): §14.3 — platform notification inbox (god event feed with read state).* · *v0.9 (2026-07-04): §14.3 — read-only act-as toggle (safe inspection).* · *v0.8 (2026-07-04): §14.3 — bulk company actions + company tags/segments with tag filter.* · *v0.7 (2026-07-04): §14.3 — switcher search+recents, Overview system-health + AI-spend + setup-incomplete, and the Activity god-only (impersonation) lens.* · *v0.6 (2026-07-04): §14.3 — Platform Console **จัดการผู้ใช้** act-as shortcut + auto-refresh with new-request toast.* · *v0.5 (2026-07-04): §14.3 — Platform Console **กิจกรรม** (cross-company audit feed + hash-chain verify + CSV) and the **company detail drawer** with subscription controls.* · *v0.4 (2026-07-04): §14.3 — Platform Console **ภาพรวม** tab (cross-company KPIs + needs-attention) and the god **scope banner**.* · *v0.3 (2026-07-04): §14.3 — the **Platform Console** (`/platform`): companies table with act-as/suspend/provision + onboarding queue/invites.* · *v0.2 (2026-07-04): §14.3 — the platform-owner **company switcher** (act-as-one-company + current-company badge).*

This chapter is for **Administrators** — *Admin*, *AccessAdmin* and
*MasterDataAdmin*. It covers managing users, assigning roles and permissions,
turning modules on or off, the periodic **User Access Review**, the **Segregation
of Duties (SoD) conflict report**, the MFA policy, and multi-branch setup.

---

## 1. Managing users

**Screen:** `/admin/users` · **Required permission:** `users`

### To add a user

1. Go to **Users** (`/admin/users`).
2. Click **Add user**.
3. Enter the **username**, a starter **password**, the **role**, and (optionally)
   any individual permission overrides.
4. Save.

**Expected result:** The user is created. On their first login they will be forced
to change the password (see [Getting Started](./00-getting-started.md)), and — if
their role requires it — to enrol in MFA.

> **Only the platform owner can grant the *Admin* role.** As a company Admin you can
> create and manage users in **every other role** — but you **cannot** create a new
> *Admin* or promote anyone to *Admin*. The **Admin** option is hidden in the role
> dropdown for you, and the API rejects the attempt with **`ADMIN_GRANT_DENIED`**
> ("Only the platform owner may grant the Admin role"). This is deliberate: the Admin
> role carries cross-company visibility, so adding an Admin is a platform-level
> privileged-access decision reserved to the platform owner (see §14.3). Ask the
> platform owner if a new Admin is genuinely needed.

> **Finding a user.** The user list has a **search** box (username, role, or
> company/tenant) with a live **match count**, so you can locate an account quickly
> in a large org before changing its role or resetting its password.

> **Note — usernames are not case-sensitive.** The username is stored in lowercase
> with surrounding spaces removed, so `JohnD`, `johnd` and `  johnd ` are the same
> account. Tell the user they can sign in regardless of capitalisation. (The
> **password**, by contrast, *is* case-sensitive and is never trimmed.)

### Other user actions

| Task | How |
|------|-----|
| Change role / permissions | Open the user and edit |
| Reset password | **Reset password** — forces a change at next login |
| Delete a user | **Delete** |
| Force-logout everywhere (compromised account) | `POST /api/auth/users/{username}/revoke-sessions` — immediately invalidates **all** of that user's existing sessions/tokens |

[screenshot: user management list]

> **Session security (ITGC-AC-15).** Signing out (**Logout**) immediately revokes the
> token used — it can't be replayed even if copied. **Deactivating** an account takes
> effect at once: any token the person still holds stops working on the next request
> (no waiting for it to expire). For a suspected compromise, use **revoke-sessions**
> above to log the user out of every device instantly.

---

## 2. Assigning roles & permissions

- Choose a **role** to give a sensible default set of permissions (see
  [Getting Started](./00-getting-started.md) for the full role list).
- Fine-tune with **per-user permission overrides** when someone needs a little
  more or less than their role.

### 2.1 Role definitions (what each role can do)

Every role now carries a **plain-language name and description** in both Thai and
English, so you don't have to memorise permission codes to pick the right one. On the
**Users** screen (`/admin/users`):

- A collapsible **Role guide** lists every role with its definition — expand it to
  read what access each role grants before you assign it.
- The **create-user** form shows the **description of the role you've selected** right
  under the picker.
- Role **dropdowns show the friendly label**, not the raw code.

The roles are grouped so you can find the right fit quickly:

| Group | What it's for | Examples |
|---|---|---|
| **Administration** | Full or access/master-data administration | *Admin*, *AccessAdmin*, *MasterDataAdmin* |
| **Single-duty (SoD-clean)** | One clean duty each — designed to produce **zero** SoD conflicts; prefer these where strict separation matters | *Cashier*, *ApClerk*, *StockCounter*, *PricingManager*, *PosSupervisor* … |
| **Broad transition** | Wider, convenience roles for smaller teams or migration | *Sales*, *Warehouse*, *Finance* … |
| **Customer portal** | External customer/supplier self-service | *Customer*, *SupplierPortal* … |

> This is a **usability aid only** — the definitions describe access, they do not
> change anyone's permissions. What a role actually grants is unchanged.

> **Note — conflicting permissions are blocked.** If you try to grant a
> combination that creates a conflict of interest (e.g. both *record sale* and
> *issue refund*, or both *raise PO* and *pay supplier*), the system warns or
> blocks with `SOD_CONFLICT`. Resolve it by removing one of the conflicting
> duties or assigning it to a different person. See the SoD report below.

### 2.2 Granting a conflicting set anyway — needs a second admin (SoD exception)

Sometimes a small team genuinely needs one person to hold two conflicting duties,
with a compensating control. You can request this by supplying a **justification**
(the *allow SoD override* option with a reason) when you save the user — **but you
can no longer authorize your own exception.** The request is **staged for approval**,
not applied:

- The user is **not** created (or, on an edit, **not** changed) yet. Instead the
  system files a **pending SoD-exception request** and tells you it is awaiting
  approval (status *PendingApproval*, with a request number and the rule(s) it
  breaches). Saving **without** a reason is still blocked outright with
  `SOD_CONFLICT`.
- A **different** administrator must approve it on the **Pending SoD-exception
  approvals** queue on the Users screen (**Approve** / **Reject**). The approver has
  to be someone **other than the person who requested it *and* other than the user the
  access is for** — if you try to approve your own request (or approve access to your
  own account) the system refuses with **`SOD_VIOLATION`**. Only on approval is the
  user actually created / the permission granted.
- Who requested, who approved, the justification, and which rule(s) were overridden
  are all written to the tamper-proof [Audit trail](#11-audit-trail-who-changed-what-and-when)
  as the evidence for the exception.

> This is the two-person rule ("maker–checker") applied to SoD exceptions: no single
> administrator can both request and grant an override. Prefer removing the conflict
> (single-duty roles) over raising an exception wherever strict separation matters.

---

## 3. Menus & modules — hide menus / turn modules on or off

**Screen:** `/settings` → **Modules** tab (**จัดการเมนู & โมดูล**) · **Required permission:** `users`

The tab gives you **two independent controls**. Both are **per company (tenant)** — what you hide, order,
or turn off here applies to **every user in your organisation**, and **never** affects any other company on
the platform.

### 3.1 Hide menus (**จัดการเมนู — แสดง/ซ่อน**)

A tree that **mirrors your left sidebar** — category (หมวด) → sub-section (หมวดย่อย)
→ individual menu (เมนู) — with a **Show / Hide** button at every level. Menu names
match the sidebar exactly. Use the **ทั้งหมด / ERP / POS** filter at the top-right to
view one surface at a time; **ERP** and **POS** use the same split as the sidebar
switcher, so the list lines up one-to-one with what staff see on that surface (in
**ทั้งหมด** each category carries an ERP/POS/ทั้งสอง chip).

1. Expand a category and click **ซ่อน** on a whole category, a sub-section, or a
   single menu; or **แสดง** to bring it back. Hiding a category/sub-section hides all
   the menus currently inside it in one click.
2. Hidden menus disappear from **everyone's** sidebar, command palette (⌘K) and
   favourites, and the page redirects to the workspace home if opened directly.
3. **Reorder categories and menus** by dragging the **⋮⋮ handle** or using the
   **▲ / ▼** buttons — on a category header to move the whole category, or on a menu
   row to move it within its category/sub-section. Put what your team uses most at the
   top. The order is **system-wide** (applies to every user's sidebar **and** the ⌘K
   search palette) and is saved instantly. New categories/menus shipped in a later
   release appear at the bottom until you place them.
4. **Find a menu fast** with the **ค้นหาเมนู** box — the tree filters as you type
   (reordering is paused while a search is active).
5. **Reset the arrangement** with **รีเซ็ตการจัดเมนู** (top-right) to show every menu
   again and restore the default category **and** menu order. This affects **menu
   arrangement only** — it does **not** re-enable any module you turned off in §3.2.

> **Hiding a menu is presentation only** — it declutters the sidebar but does **not**
> change anyone's permissions. To actually *block access* to a capability (including
> its API), turn off its **module** (§3.2). The **Settings** and **Users** menus can
> never be hidden, so an administrator can always return here.

### 3.2 Turn modules on or off (**โมดูลระบบ — สิทธิ์การใช้งาน**)

The system-wide feature flags, now **grouped by category and named in Thai**. Each
module shows its technical **code** (e.g. `pos`, `pr_raise`) and, under **“คุมเมนู”**,
exactly **which menus that module controls** — so you can see the link between a code
and the sidebar. Use the per-module **ปิด/เปิด** button, or **ปิดทั้งหมวด/เปิดทั้งหมวด**
to switch a whole category at once.

**Expected result:** A module turned **off** disappears from every user's menu **and
is blocked at the API** (`403 MODULE_DISABLED`). Core access (the **Users &
Permissions** module) is *always-on* and can never be turned off.

**Menu-hide vs module-off — which to use:**

| Goal | Use |
|---|---|
| Simplify the sidebar; the feature is still allowed | **Hide menu** (§3.1) |
| Stop the feature entirely, including its API | **Turn module off** (§3.2) |

---

## 4. User Access Review (UAR)

A periodic review where you confirm that every user's access is still appropriate.

**Screen:** `/admin/users` (Access Review area) · **Required permission:** `users`

### To run and certify a review

1. Go to **Users** (`/admin/users`) → **Access Review**.
2. Review the list of users, their roles, permissions and any **SoD conflicts**.
3. **Export** the review to CSV (access list + SoD conflicts) for your records or
   auditors.
4. After confirming each user's access is correct (adjusting any that aren't),
   click **Certify** to sign off the review period.

**Expected result:** The review is certified and recorded; past certifications are
listed for audit history.

[screenshot: User Access Review with certify button]

### 4.1 Access Recertification Campaign — keep/revoke each user in-app (ITGC-AC-21)

For an auditor-grade review, use a **recertification campaign** instead of the blanket
sign-off. Here you decide **keep or revoke for every user individually**, and a **revoke**
decision actually removes that user's granted permissions when you certify (closed loop).

**Screen:** `/admin/access-recert` · **Required permission:** `users`

1. Go to **Access Recertification** (`/admin/access-recert`) → **Open campaign** and
   enter the period (e.g. `2026-Q3`). The system snapshots every user's current access as
   a keep/revoke worklist.
2. For each user, click **Keep** (access still appropriate) or **Revoke** (remove their
   granted access). Every user must be decided.
3. Click **Certify**. If any line is still undecided you get **ITEMS_PENDING** — finish
   the worklist first. On certification, each **Revoke** user's permission grants are
   removed immediately and the line is marked *Revoked*.

**Expected result:** The campaign is certified and frozen (it can no longer be edited);
each user's keep/revoke decision, reviewer and revocation outcome are retained as
line-item audit evidence. A revoked user loses their granted access at once.

> The blanket **Certify review** (§4) and CSV export still work for back-compat; the
> campaign is the stronger, closed-loop control.

---

## 5. Segregation of Duties (SoD) conflict report

**Screen:** `/sod` · **Required permission:** administrator

The SoD report lists the **rules** (conflicting duty pairs), which **roles** would
breach them, and any **live users** who currently hold conflicting duties.

1. Go to **SoD** (`/sod`).
2. Review the tabs: **Rules**, **Role Conflicts**, and **Live User Conflicts**.
3. For each live conflict, remove one side of the duty or reassign it.

**Expected result:** A clear picture of where one person holds incompatible
duties, so you can remediate. Examples of rules enforced:

| Rule | Conflict | Severity |
|------|----------|----------|
| R02 | Maintain vendor master **and** pay vendors | High |
| R03 | Raise purchase **and** approve / pay AP | High |
| R04 | Purchase ordering **and** goods receipt | High |
| R05 | Post journal entries **and** close the period | High |
| R07 | Initiate a transaction **and** approve it | High |
| R08 | Record a sale **and** refund / reconcile the till | High |
| R11 | Adjust inventory **and** count stock | Medium |

> **Note:** The single-duty roles (e.g. *Cashier*, *ApClerk*, *StockCounter*)
> were designed to produce **zero** SoD conflicts. Prefer them over the broad
> roles where strict separation matters.

[screenshot: SoD live user conflicts]

---

## 6. MFA policy

**Screen:** `/settings` → **MFA Policy** tab.

Two-factor authentication (MFA) is **required** for any user whose permissions
include sensitive duties — user administration, journal posting / period close,
AR / AP, approvals, or sensitive master data — and for all Admins.

- Affected users are prompted to enrol on login (see
  [Getting Started](./00-getting-started.md)).
- If a user loses their device, an administrator can reset their MFA so they can
  re-enrol.

---

## 7. Multi-branch

**Screen:** `/branches` · **Required permission:** `branch`

1. Go to **Branches** (`/branches`).
2. **Add** each outlet with its details.
3. Use **Consolidated Sales** to view sales across all branches for a date range.
4. Use the **master bundle** to prepare offline data for branch POS terminals.

**Expected result:** Multiple outlets are managed centrally, with consolidated
reporting at HQ.

[screenshot: branches list and consolidated sales]

---

## 8. Master data

**Screen:** `/master-data` (and `/bom-master`) · **Required permission:**
`masterdata` / `bom_master` (held by *MasterDataAdmin*).

Maintain the shared reference data the whole system relies on — items, vendors,
configuration and bills of materials.

> **Note — separation of duties:** Maintaining master data is kept separate from
> transacting on it (rules R02, R09, R10, R13). For example, the person who sets
> prices should not also be the one selling at those prices.

### Bulk import / export (validate before you commit)

**Screen:** `/master-data` · **Required permission:** `masterdata`.

> **On the setup screens too.** **หมวดสินค้า (Item Categories)** (`/setup/item-categories`)
> and **รหัสภาษี (Tax Codes — VAT / WHT)** (`/setup/tax-codes`) now carry the **same
> Export / Template / Import panel** at the bottom of their own page — so you can bulk-load
> or download those two lists without leaving for the Master Data screen. There it needs
> only the setup permission for that page (`md_item` / `md_config` / `masterdata` / `exec`),
> not the broad `masterdata` duty.

You can load many records at once from a spreadsheet — items, customers, vendors,
locations, prices, promotions, BoMs, **menu items (POS)**, assets, and the item-posting
setup records **หมวดสินค้า (Item Categories)** and **รหัสภาษี (Tax Codes — VAT / WHT)**.
The last two let you pre-load each item family's default GL accounts (revenue / COGS /
inventory / valuation) plus its VAT code and, for service/labour categories, a
withholding-tax income type — the foundation for linking item posting to accounts and
tax (see *docs/33*; the posting behavior that consumes them ships in a later phase).
Loading your
whole **menu** this way is the fastest way to set up a new restaurant: export the
template for **เมนูอาหาร (Menu Items)**, fill in **SKU**, **Name** and **Price** (the
only required columns), and import. Optional columns — **Type** (food / drink / retail
/ combo), **Tax_Type** (standard / exempt / zero), **Cost**, **Station_Code**,
**Prep_Minutes**, **Track_Stock**, **Category_ID**, **Sort** — can be left blank and
fall back to sensible defaults (Type = *food*, Tax_Type = *standard*, station = *main*).
Re-importing the same file is safe: rows whose **SKU** already exists are skipped, not
duplicated.

1. **Download the template** (or **export** the current data) for the record type,
   and fill it in. Keep it as **Excel (.xlsx)** or save as **CSV** — the importer
   accepts **both**, so the file you just downloaded goes straight back in with no
   “Save As CSV” step.
2. **Choose a file** — the system **checks every row first** (a dry run that
   changes nothing) and shows a **preview**: how many rows are valid, and a table
   of any problems (missing required value, a number/date that won't parse, or a
   key repeated in the file), each with its **row and column**.
3. **Confirm the import.** If every row is valid it imports them all. If some rows
   have errors, you can either fix the file and try again, or tick **“ข้ามแถวที่ผิด
   (skip bad rows)”** to import only the valid ones. Rows whose key already exists
   are skipped and reported (in *append* mode).

**Expected result:** No more guessing — you see exactly what will (and won't) import
before committing, and bad rows never silently corrupt your data.

> **Append vs Replace:** *Append* adds new records and skips existing keys.
> *Replace* (only where allowed) wipes the current data first — use with care.

> **Sensitive money fields need a second person to approve (maker-checker).** If your
> import **sets** a financially-sensitive field — a **customer or vendor credit limit**,
> a **vendor payment term**, a **price-list price**, or a **promotion discount** — the
> import is **not written straight away.** Instead it is **submitted for approval**: you'll
> see a message that it's *pending* (with a request number and which sensitive field(s) it
> changes), and **no data changes until a second authorised person approves it.** That
> approver must have the **exec / approvals** permission and must be **someone other than
> you** — if you try to approve your own import the system refuses with **`SOD_VIOLATION`**.
> Once approved, the rows are written to your company's data; the request can also be
> **rejected**, which discards the batch. Ordinary imports that don't touch those money
> fields — items, contacts, tax codes, plain menu prices — are **unaffected** and still
> import immediately. This is the two-person rule that stops one person bulk-changing
> fraud-relevant figures on their own (SoD rules R02 / R09 / R10 / R13).

---

## 9. Custom fields (extend records without code)

**Screen:** `/custom-fields` (**ฟิลด์กำหนดเอง**) · **Required permission:**
`masterdata` / `users` / `exec` (to define fields).

Add your own fields to any record type — customers, items, orders, vendors,
journals and more — without a developer.

1. **Pick the record type** (entity) at the top.
2. **Add a field:** give it a name, a **type** (text, number, date, yes/no, or a
   dropdown **list** of choices), and tick **required** if it must be filled.
3. The field then appears on that record type's screens (a *Custom fields* panel),
   where staff fill in values.

The system **validates** entries against the field's type — a number field only
accepts numbers, a date only accepts dates, and a list field only accepts one of
its choices; a required field can't be left blank. Fields and their values are
**private to your company** and every change is recorded in the audit log.

**Expected result:** Your team captures the extra information your business needs,
consistently and validated — no custom development required.

> **Troubleshooting:** “REQUIRED_FIELD” — a required custom field was left blank;
> “BAD_OPTION” — the value isn't one of the dropdown's choices.

---

## 10. Alert rules (get notified when something needs attention)

**Screen:** `/alerts` (**การแจ้งเตือน**) · **Required permission:** `masterdata` /
`users` / `exec` / `dashboard`.

Set up rules that watch your live data and notify the right people when a
threshold is crossed — no code.

1. **Pick a metric** — e.g. *items below reorder point*, *overdue approvals*,
   *open purchase requisitions*. The current value is shown beside each.
2. **Set the condition** — an operator (≥, >, ≤, <, =) and a number.
3. **Choose how to notify** — an **in-app notification** to a role, or **LINE /
   SMS / email** to a recipient — with a severity and a **cooldown** (so you're
   not spammed).
4. Save. The **ตรวจสอบเดี๋ยวนี้** button (and a scheduled sweep) evaluates the
   rules; each time one fires, it shows in **ประวัติการแจ้งเตือน**.

**Expected result:** The right people are alerted automatically — low stock,
stalled approvals, and other conditions you care about — through the channel you
choose.

> **Troubleshooting:** “BAD_METRIC” — the metric isn't in the catalog;
> “NO_TARGET” — a LINE/SMS/email rule needs a recipient.

---

## 11. Audit trail (who changed what, and when)

**Screen:** `/audit` (**ร่องรอยการตรวจสอบ**) · **Required permission:** `users`.

Every change in the system is recorded in a **tamper-proof** log — it can be read
and exported, but never edited or deleted (a database guard enforces this). Use it
to investigate an issue or to give an auditor evidence of activity.

1. Go to **Audit trail** (`/audit`).
2. **Filter** by user (actor), action (e.g. a route like `/api/orders`), status
   (success / fail), and a **date range**, then **ค้นหา (Search)**.
3. Page through the results; each row shows the time, user, action, status, IP and
   request id.
4. Click the **download** button to **export the filtered set to CSV** for your
   records or an auditor.

**Expected result:** A searchable, exportable history of changes. You only ever see
your **own company's** events (entries are private to your tenant); HQ/Admin sees
across the group.

> **Note:** The log is **append-only** — entries can't be altered or removed, which
> is what makes it acceptable as audit evidence.

---

## 11a. PDPA — data-subject requests (privacy)

**API:** `/api/pdpa/dsar` · **Required permission:** `users` (the DPO / access-admin duty).

Under Thailand's PDPA, a person can ask what data you hold about them, ask for a copy,
or ask you to erase it — this covers loyalty members **and employees** (an employee's access bundle includes their citizen ID/bank details and payslip history; erasure redacts their master record while payroll/withholding records stay per Thai statutory retention, noted in the request result). Use the DSAR (Data Subject Access Request) register to track and
fulfil these on time.

1. **Log the request.** Record the subject (e.g. a loyalty member by code/id) and the
   request type — **access**, **rectification**, **erasure**, **portability**, or
   **objection**. The system stamps a **due date 30 days out** (the statutory deadline)
   and tracks status (received → completed/rejected).
2. **Fulfil access / portability.** **Export** assembles everything held about the subject
   — profile, the per-purpose consents they granted, and their points history — as a single
   bundle to hand over.
3. **Fulfil erasure ("right to be forgotten").** **Erase** removes the person's personal
   details (name, phone, email, card, LINE) and withdraws their marketing consent. Their
   transaction history is kept for accounting/legal reasons but their identity is replaced
   everywhere it would otherwise show — **including in the audit trail**, where their details
   are automatically masked from then on. (The audit records themselves stay intact for
   integrity; the personal data is simply never displayed again.)
4. **Reject** with a reason if the request isn't valid (e.g. the person isn't your customer).

> You only ever see your **own company's** requests (tenant-isolated). Erasure cannot be
> undone — confirm the subject's identity first.

### RoPA — Records of Processing Activities (มาตรา 39 / GDPR Art.30)

**API:** `/api/pdpa/ropa` · **Required permission:** `users` (DPO / access-admin).

PDPA requires you to keep a **record of every way you process personal data** — the register a regulator or
auditor will ask to see. Maintain one entry per processing activity:

1. **Add an activity** with its **purpose**, **legal basis** (consent / contract / legal obligation /
   legitimate interest / vital interest / public task), the **data categories** and **data subjects** involved,
   who **receives** the data, your **sub-processors** (e.g. Anthropic, Stripe, Sentry), the **retention period**,
   the **cross-border transfer basis** (if data leaves Thailand), and your **security measures**.
2. **Keep it current** — edit an activity as processing changes; mark it **inactive** when a processing
   activity ends (retired entries stay on record but drop out of the active register). Review the register
   periodically.

> Like DSARs, the RoPA register is **tenant-isolated** — you only see your own company's activities. An
> invalid legal basis is rejected so every entry is complete and consistent.

### Automatic retention (anonymize inactive members) — opt-in

**API:** `/api/pdpa/retention` · **Required permission:** `users` (DPO / access-admin) · **Off by default**

PDPA's data-minimization principle says you shouldn't keep personal data longer than needed. If you want the
system to enforce that automatically for **loyalty members**:

1. **Set a policy** (`PUT /api/pdpa/retention`): how many months of **inactivity** before a member's personal
   details are anonymized (minimum **12 months** — a shorter window is rejected so a typo can't mass-anonymize),
   and switch it **on**. With no policy (or switched off) nothing is ever swept.
2. **Preview first** — run the sweep with **dry-run** (`POST /api/pdpa/retention/sweep` `{dry_run: true}`) to
   see which members would be affected without touching anything.
3. **Run or schedule it** — run on demand, or schedule the **"ลบล้างข้อมูลส่วนบุคคลที่พ้นระยะเก็บรักษา (PDPA)"**
   report type monthly from the BI scheduler. Anonymization works exactly like a PDPA erasure request:
   details are redacted, consents withdrawn, receipt photos deleted, and the audit trail masks the person from
   then on — while their purchase/points history stays for the accounts.

> A member is "inactive" from their **last points activity** (or last profile update). Already-anonymized
> members are skipped, so re-running is safe. Each run handles up to 500 members per policy and continues on
> the next run.

---

## 12. Webhooks (push events to other systems)

**Screen:** `/webhooks` (**เว็บฮุค**) · **Required permission:** `users`.

Connect the ERP to other software: when something happens here — a **purchase
order is approved/rejected**, or an **alert fires** — we send a signed message to a
URL you choose, so the other system can react instantly.

1. **Register an endpoint** — paste the receiving **URL** and (optionally) pick which
   **events** to receive (pick none to receive all).
2. **Copy the signing secret** shown **once** at registration. The receiver uses it
   to verify each message is genuinely from us:
   `HMAC-SHA256(secret, "<timestamp>.<body>")` must equal the `X-IERP-Signature`
   header (reject anything older than 5 minutes).
3. **Watch deliveries** on the **ประวัติการส่ง** tab — each attempt shows its status,
   attempt count and any error. **ส่งซ้ำ** re-sends one, and **Dispatch** retries all
   the failed-but-not-exhausted ones.

**Expected result:** Real-time, tamper-evident integration with your other tools.
Endpoints and their delivery history are **private to your company**; a slow or
down receiver is bounded (10s) and never blocks the ERP — failed deliveries are
logged and retried.

> **Security:** the signing secret is stored **encrypted** and shown only once —
> if you lose it, delete the endpoint and register a new one.

---

## 13. Company profile & branding

**Screen:** `/setup` (**ตั้งค่ากิจการ**) · **Required permission:** `users`.

This is where you keep your company's official details — used on tax invoices and
receipts — and where you **brand** your customer-facing documents.

- **Company info & address:** legal name, tax ID, branch, VAT registration/rate,
  address, phone, **fax**, PromptPay ID, and the default language for receipts.
  Phone/fax print on the full tax invoice (ม.86/4) header.
  - **The form checks formats as you go.** Fields that print on official documents
    are validated inline before you can save — **tax ID** (13 digits), **branch
    code** (5 digits), **postal code** (5 digits), **PromptPay** (10-digit mobile
    or 13-digit ID), **email**, and **VAT rate** (between 0 and 1, e.g. `0.07`).
    A wrong entry shows a red hint under the field; **Save** is blocked until it is
    fixed, and a green toast confirms a successful save.
- **Branding (ตราสินค้า):**
  - **Logo** — paste an **`https://` image URL** (or a small image *data URI*). A
    preview shows what you entered.
  - **Tagline** — a short line shown beneath your company name.
  - **Show logo on receipt** — turn the logo on or off for printed/emailed
    receipts (the tagline always shows when set).

**Expected result:** Your receipts (and other customer-facing documents) carry your
**logo and tagline**. These settings are **private to your company** — each tenant
brands its own documents independently.

> **Changing the PromptPay ID or tax ID needs a second person to approve
> (maker-checker).** These two fields carry money and legal-identity risk — the
> **PromptPay ID** is the account that **receives your customers' QR payments**, and the
> **tax ID** is the legal identity printed on your tax invoices. So a change to **either**
> is **not applied immediately**: it is **submitted for approval** (you'll see it is
> *pending*, with a request number) and takes effect only when a **different** authorised
> user — one with the **Exec / Approvals** permission — approves it. You **cannot approve
> your own** change (the system refuses with **`SOD_VIOLATION`**); the request can also be
> **rejected**, which discards it. Until it is approved the old value stays in force (for
> example, PromptPay QR codes keep using the old ID). **All other company-info fields**
> (address, phone, fax, branding, VAT registration/rate, default language) **save immediately**
> as before, and re-saving a field to the **same value** never triggers an approval.
>
> **Where to find it in the app.** After you save a PromptPay/tax-ID change you'll see the
> *pending* message on the **Company Setup** screen (`/setup`). The staged change then appears in
> a **"Financial-profile changes pending approval"** card on that same screen, where a **different**
> user with **Exec / Approvals** permission clicks **Approve** (or **Reject**).

> **Note:** there's no file upload — paste a public image URL or a small data URI.
> An invalid logo address (not `https://` or an image data URI) is rejected.

---

**Next:** [Approvals](./10-approvals.md) ·
[Troubleshooting & FAQ](./99-troubleshooting-faq.md)

---

## 14. Onboarding a new company (platform owner)

Each **company is one account (tenant)**; its branches live inside it. Companies are isolated from each
other (a company's Admin never sees another company's data) when the platform runs in `multi-company` mode.

**To add a new company (recommended — no config toggling):** an operator listed in the
`PLATFORM_ADMIN_USERNAMES` setting can create a company from an authenticated session by calling
**`POST /api/admin/tenants`** with the company name, a unique tenant code, the first Admin's username +
password, email, and (optionally) the industry template. The new company is provisioned end-to-end — its
own org (so it's isolated by default), an Admin login, a trial subscription, the fiscal-year periods, and
the industry Chart of Accounts — and the action is recorded in the [Audit trail](#11-audit-trail-who-changed-what-and-when).
Anyone not on the platform-owner list gets **`403 PLATFORM_ADMIN_REQUIRED`**; if the list is empty, nobody
can (secure default) — set `PLATFORM_ADMIN_USERNAMES` first.

**Invite a company to sign up themselves (optional).** If you'd rather the new company fill in their own
details, issue a **single-use invite link** instead: `POST /api/admin/signup-invites` (returns a token +
expiry once; review them at `GET /api/admin/signup-invites`). Send the invitee the link; they complete
signup with the token — which works **even while public signup is disabled**. The token is single-use and
expires; a reused/expired/wrong token is rejected (`400 INVALID_INVITE`).

**Let people request an account, then approve them (queue).** For inbound interest, keep a public
"request access" form (`POST /api/auth/signup-requests`) — it creates a **pending request**, it does **not**
create a company. Review the queue at `GET /api/admin/signup-requests` and **approve** (provisions the
company using the details they submitted) or **reject** each one. No account exists until you approve, so
nobody self-provisions.

**Public self-service signup is disabled in production — there is no company created without the platform
owner.** The public sign-up page no longer creates a company: it is now a **"request access" form** that
files a pending request (see the request queue above) and waits for your approval. The old
`PUBLIC_SIGNUP_ENABLED` setting **no longer does anything** (it is a no-op) — a company can be opened **only**
by the platform owner, via the platform-owner endpoint, an invite, or approving a request. See
`docs/ops/tenancy-model.md`.

---

### 14.2 Suspend or reactivate a company

A platform owner can **suspend** a company — `POST /api/admin/tenants/:id/suspend` (with an optional
`reason`). Its users are then blocked everywhere with **`403 TENANT_SUSPENDED`** until you **reactivate** it
(`POST /api/admin/tenants/:id/reactivate`). Platform owners themselves are never blocked (so you can always
reactivate). Both actions are recorded in the [Audit trail](#11-audit-trail-who-changed-what-and-when).

### 14.3 Who can see across all companies (the platform-owner super-user)

In `multi-company` mode a company's **Admin sees only its own organization** — that's the isolation that keeps
customers apart. So no ordinary Admin sees everything. The one operator who **can** see and act across **all**
companies is the **platform owner** — any username you list in **`PLATFORM_ADMIN_USERNAMES`**. That user gets a
cross-company view **everywhere in the app** (not just the company-management screens above), while every
per-company Admin stays confined to its own org.

- Make the platform owner a normal **Admin** user (so it has every permission), then add its username to
  `PLATFORM_ADMIN_USERNAMES`. The env membership grants the cross-company *visibility*; the Admin role grants
  the *permissions*.
- This is intentionally an **operator/deployment setting, not a role you assign in the app** — so a company
  Admin can never promote someone (or themselves) to see other companies' data.
- Treat it like a **break-glass account:** keep the list to a few named people, require MFA on that login,
  and remove the username when they no longer need cross-company access. Everything a platform owner does
  across companies is recorded in the [Audit trail](#11-audit-trail-who-changed-what-and-when). See
  `docs/ops/tenancy-model.md` §2bis.

**Knowing which company you're looking at (the company switcher).** Because a platform owner sees every
company's data at once, the lists you open would otherwise mix rows from all companies with no cue to which
is which. To handle that, the sidebar shows a **company switcher** — visible **only** to a platform owner —
just under the workspace tabs. It doubles as a **current-company badge**:

- It opens with **"ทุกบริษัท (รวม)"** selected — the combined cross-company view described above.
- Pick a company from the list and the whole app **scopes to just that company** — every screen, list, and
  export now shows only its data, exactly as that company's own Admin would see it. The badge shows the
  company name so you always know whose data is on screen. Choose **"ทุกบริษัท (รวม)"** again to go back to the
  combined view.
- The choice is remembered on that device and the page reloads so everything refreshes under the new scope.
  It only ever **narrows** what you see (you can always switch back); it never grants a normal Admin any
  cross-company access. Actions you take while scoped to a company are still recorded in the audit trail with
  the company you were acting as.

**The Platform Console (`/platform`).** A platform owner also gets a dedicated **ศูนย์ควบคุมแพลตฟอร์ม** entry in
the sidebar (visible only to platform owners) — one place to run the whole fleet:

- **บริษัท** — a table of every company with its status (ใช้งาน/ทดลอง/ระงับ/ค้างชำระ), plan, number of users, trial
  end and creation date. Per row you can **เข้าดู** (jump into that company — this sets the switcher above and
  reloads into its dashboard) or **ระงับ/คืนสถานะ** it. The **เปิดบริษัทใหม่** button provisions a brand-new
  company (tenant + its Admin + industry chart of accounts) in one step.
- **Onboarding** — the queue of pending **คำขอเปิดบริษัท** to **อนุมัติ/ปฏิเสธ**, and **ออกลิงก์เชิญ** to issue a
  single-use, expiring invite link (the token is shown once — copy it then).
- **กิจกรรม** — a fleet-wide activity log (ทุกบริษัทรวมกัน) พร้อมกรองราย**บริษัท**/ผลลัพธ์ + ค้นหาผู้ทำ/การกระทำ,
  ปุ่ม **ตรวจ hash-chain** (พิสูจน์ว่า audit ไม่ถูกแก้), และ **ส่งออก CSV** — ไว้ตรวจสอบ/สืบสวนเหตุการณ์ข้ามบริษัท.
- **ภาพรวม** — business KPIs across all companies (MRR/ARR, จำนวนบริษัทที่จ่ายเงิน, ผู้ใช้ active, churn, สัดส่วน
  แพ็กเกจ) and a **ต้องดูแล** panel that surfaces what needs action now: คำขอรออนุมัติ, บริษัททดลองใกล้หมดอายุ (7
  วัน), ค้างชำระ, และถูกระงับ.
- **รายละเอียดบริษัท** — คลิกชื่อบริษัทในตารางเพื่อเปิดแผงด้านข้างที่รวมข้อมูลบริษัทนั้นครบ (subscription, จำนวน
  ผู้ใช้/สาขา, การใช้ AI, กิจกรรมล่าสุด) พร้อม **เปลี่ยนแพ็กเกจ** และ **ต่อระยะทดลอง** ได้จากตรงนั้นเลย (ไม่ต้อง
  สลับเข้าไปในบริษัท), ปุ่ม **เข้าดูบริษัทนี้**, และ **จัดการผู้ใช้** (พาเข้าไปที่หน้าจัดการผู้ใช้ของบริษัทนั้นเพื่อ
  รีเซ็ตรหัส/เตะ session/ปิดบัญชี).

> **อัปเดตอัตโนมัติ.** ศูนย์ควบคุมจะรีเฟรชรายชื่อบริษัท/คิวคำขอให้เองเป็นระยะ และเด้งแจ้งเตือนเมื่อมี **คำขอเปิด
> บริษัทใหม่เข้ามา** — ไม่ต้องคอยกดรีโหลดเอง.

> **เครื่องมือเพิ่มเติมบนศูนย์ควบคุม.** สลับบริษัทมี **ช่องค้นหา + รายการเพิ่งดู**; หน้า **ภาพรวม** เพิ่มแถบ
> **สุขภาพระบบ** (DB pool/คิวงาน/งานล้มเหลว/แคช) และตาราง **การใช้ AI ข้ามบริษัท** (ผู้ใช้มากสุด + overage);
> การ์ด **ตั้งค่ายังไม่เสร็จ** ชี้บริษัทที่ข้อมูลภาษี/ที่อยู่ยังไม่ครบ; และแท็บ **กิจกรรม** มีตัวกรอง **เฉพาะการข้าม
> บริษัท (god)** สำหรับสอบทานการสวมรอย.

> **จัดการหลายบริษัทพร้อมกัน & แท็ก.** ในตารางบริษัทเลือกหลายรายการเพื่อ **ระงับ/คืนสถานะ/ต่อ trial/เปลี่ยน
> แพ็กเกจ** พร้อมกันได้ และติด **แท็ก/กลุ่ม** (เช่น enterprise, trial-risk) จากแผงรายละเอียดบริษัท แล้วกรองตาราง
> ตามแท็กได้.

> **เข้าดูแบบอ่านอย่างเดียว.** เมื่อสวมรอยเข้าดูบริษัท แถบด้านบนมีปุ่มสลับ **อ่านอย่างเดียว ⇄ เปิดให้แก้ไข** —
> โหมดอ่านอย่างเดียวจะบล็อกการบันทึก/แก้ไขทุกอย่าง (ปลอดภัยสำหรับการตรวจสอบ/ซัพพอร์ต โดยไม่เผลอเปลี่ยนข้อมูลลูกค้า).

> **กล่องแจ้งเตือนแพลตฟอร์ม.** แท็บ **แจ้งเตือน** ในศูนย์ควบคุมรวมเหตุการณ์ที่ต้องรู้ (คำขอเปิดบริษัทใหม่,
> การเปิด/ระงับ/คืนสถานะบริษัท) เป็นรายการมีสถานะอ่าน/ยังไม่อ่าน — ตัวเลขยังไม่อ่านโชว์บนหัวแท็บ กด **อ่านทั้งหมด**
> หรืออ่านทีละรายการได้ (ต่างจากการ์ด “ต้องดูแล” ที่โชว์สถานะปัจจุบัน — อันนี้เก็บประวัติเหตุการณ์ไว้).

Everything here is restricted to platform owners by the server, so the menu simply won't appear for a normal
company Admin.

**Knowing your scope at all times.** As a platform owner you'll see a thin **banner under the top bar**: in
the combined view it reminds you that the figures on screen add up **all** companies; once you enter a company
(via the switcher or **เข้าดู**) it names that company and gives you a one-click **ออกเป็นมุมมองรวม** to return —
so a dashboard total is never mistaken for a single company's number.

### 14.1 First-run setup checklist & starter

A brand-new company can see exactly what's left to set up: **`GET /api/tenant/onboarding-status`** returns a
short checklist — **company/tax profile**, **a branch (HQ)**, **staff users**, and **a menu/catalog** — each
marked done/not-done, with an overall percentage and the **next** step to do. A setup wizard can read this to
guide the new admin to a productive state.

To avoid starting from an empty shell, **`POST /api/tenant/starter-pack`** gives the company a **head-office
branch** in one click (idempotent — safe to run again; it skips anything already there). More per-industry
sample data can be layered on later.

---

## 15. Governance — entity-level controls (ELC)

**Where:** the **การกำกับดูแล (Governance)** screen (`/governance`, nav → **Controls**), for the
compliance / admin function (`exec` or `users`). It's the operating surface for the board-level
"entity-level controls" (ELC-01…05) — the same runbooks are in `docs/governance/elc-operating-manual.md`.

Six tabs:
- **ภาพรวม (Overview)** — a readiness dashboard: code-of-conduct acknowledgement coverage %, open
  whistleblower cases (with SLA ageing), and the last/next audit-committee oversight review, plus a
  **needs-attention** list. Green when nothing is outstanding.
- **จรรยาบรรณ (Ethics, ELC-01)** — tap **ยอมรับจรรยาบรรณเวอร์ชันนี้** to record your own acknowledgement
  of the current code-of-conduct version, and review the **acknowledgement register** (who has / hasn't).
- **สายด่วนแจ้งเบาะแส (Hotline, ELC-04)** — file a report (optionally **anonymous**), and from the case
  log **ดำเนินการ (Advance)** a case through *received → investigating → resolved / dismissed* with a
  resolution note. Anyone may file; only compliance sees the log and can advance.
- **ตารางมอบอำนาจ (DoA, ELC-03)** — the delegation-of-authority matrix: who may approve which authority
  area, up to which limit.
- **ความเสี่ยงทุจริต (Fraud risk, ELC-05)** — the fraud-risk register: log a risk (likelihood × impact +
  mitigating controls + owner) and **ทบทวน (Review)** its status (*open → mitigated / accepted / closed*).
- **การกำกับดูแล (Oversight, ELC-02)** — record each audit-committee / board oversight meeting (date,
  topics, whether ICFR was reviewed, attendees, minutes reference, sign-off) — the ELC-02 evidence log.

**Expected result:** the ELC evidence that used to require raw API calls is now captured and reviewed from
one screen; the Overview tab's alerts mirror the weekly `governance_readiness` monitor.

---

## 16. Control Console — RCM + test-of-effectiveness evidence (ITGC-MON-01)

**Where:** the **คอนโซลการควบคุม — RCM (Control Console)** screen (`/controls/rcm`, nav → **Controls**), for
the compliance / audit / exec function (`exec` or `users`). This is the single auditor-facing view of the
whole control environment — the ~240-control Risk & Control Matrix (RCM), each control's status, and its
test-of-effectiveness (ToE) results — that a NASDAQ audit team asks for. The catalogue is the *same* source
as `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx` (both are generated from `compliance/build_rcm.py`), so what you
see in-app can never drift from the spreadsheet.

**Browse the catalogue.** The top cards show the census (total / Implemented / Partial / Gap). The table lists
every control with its ID, family, category, risk, owner and status. Filter by **สายงาน (family)** and
**สถานะ (status)**, or search by control ID / risk / description.

**Open a control.** Click any row to open the detail drawer. It shows all 17 RCM fields — risk, assertion(s),
control description, prevent/detect, nature, frequency, owner, COSO principle, FSLI, the system / code
reference, the Test of Design (TOD), the Test of Operating Effectiveness (TOE), and the key evidence — plus:
- **ประวัติการทดสอบ ToE (ToE test-run history)** — every recorded test-run for this control (result, harness,
  checks passed/total, evidence reference, who recorded it, when).
- **สิ่งที่ตรวจพบจากการเฝ้าระวัง (CCM findings)** — for monitoring controls, any open continuous-controls
  findings.
- **หลักฐานจากบันทึกตรวจสอบ (audit-log evidence)** — recent tamper-evident audit-log rows tied to the control.

**Record a ToE run.** In the drawer's **บันทึกผลการทดสอบ ToE** form, pick a result (**ผ่าน / ไม่ผ่าน /
ไม่เกี่ยวข้อง** = pass / fail / na), the harness or method used (e.g. `compliance`, `basics`, `manual`), the
checks passed / total, an evidence reference (a CI-run link or document id), and notes — then **บันทึกผลการ
ทดสอบ (Record test-run)**. The run appears immediately as the control's **latest ToE**.

**Isolation & gating:** the console is gated to `exec` / `users`; a role without them cannot open it or record
a run (**403**). Recorded test-runs are **tenant-isolated** — one company can never see another's ToE evidence.

**Expected result:** an auditor can browse the entire control inventory, see which controls have passing ToE
and pull the underlying evidence, and management can record its ongoing self-monitoring of control operating
effectiveness — all in-product.

---

## LINE chat channel governance (LC-3)

Staff can link their LINE accounts to raise requisitions, expenses, and leave from the
shop's LINE OA (see [Procurement — LINE chat](./03-procurement.md)). Administration owns
the governance of that channel:

- **Link registry** — `GET /api/line/links` (permission `users`) lists every linked staff
  account (username, role, tenant, LINE id **masked**). Review it as part of access
  recertification.
- **Force-unlink on offboarding** — `DELETE /api/line/links/<username>` clears the LINE
  binding and any pending chat state immediately and writes an audit row; do this alongside
  deactivating the account so a departed employee's phone loses the channel at once.
- **Rate limiting** — each LINE account gets a command budget (default 30 commands / 5
  minutes). The first excess command gets one "slow down" reply; further excess is dropped
  silently and audit-logged.

## LINE OA go-live (LP-1)

Connect the shop's own LINE Official Account in **Settings → ผู้ให้บริการข้อความ** — the LINE card
now carries a go-live panel (full runbook: `docs/ops/line-oa-golive.md`):

1. **Save both credentials.** Channel access token **and Channel secret** are required together —
   the system refuses token-only creds (error `MISSING_FIELD`), because the chat webhook cannot be
   authenticated (and fail-closes in production) without the secret.
2. **Copy the webhook URL** shown in the panel (`…/api/line/webhook/<shop-code>`) into the LINE
   Developers console (Messaging API → Webhook URL → Verify → Use webhook on).
3. **Read the receipt health.** The panel shows whether LINE has ever reached the webhook and how
   the last delivery verified: 🟢 verified · 🔴 ลายเซ็นไม่ถูกต้อง (saved secret doesn't match the
   channel — re-copy it) · never received (check the URL / Verify).
4. **[ส่งข้อความทดสอบถึง LINE ของฉัน]** pushes a test message to *your own* linked LINE
   (permission `users`/`exec`; audit campaign `line_test`). If you get "ยังไม่ได้เชื่อม LINE"
   (`NOT_LINKED`), link first on the Requisitions page — that's your account, not the channel.
