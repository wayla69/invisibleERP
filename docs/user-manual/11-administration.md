# 11 · Administration

**Status: DRAFT v0.1**

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

### Other user actions

| Task | How |
|------|-----|
| Change role / permissions | Open the user and edit |
| Reset password | **Reset password** — forces a change at next login |
| Delete a user | **Delete** |

[screenshot: user management list]

---

## 2. Assigning roles & permissions

- Choose a **role** to give a sensible default set of permissions (see
  [Getting Started](./00-getting-started.md) for the full role list).
- Fine-tune with **per-user permission overrides** when someone needs a little
  more or less than their role.

> **Note — conflicting permissions are blocked.** If you try to grant a
> combination that creates a conflict of interest (e.g. both *record sale* and
> *issue refund*, or both *raise PO* and *pay supplier*), the system warns or
> blocks with `SOD_CONFLICT`. Resolve it by removing one of the conflicting
> duties or assigning it to a different person. See the SoD report below.

---

## 3. Turning modules on or off

**Screen:** `/settings` → **Modules** tab · **Required permission:** `users`

1. Go to **Settings** (`/settings`) → **Modules** (**เปิด / ปิด การใช้งานโมดูล**).
2. Toggle a module **on** or **off** for the whole organisation.

**Expected result:** A module turned **off** disappears from every user's menu and
is blocked in the system. (Core access — user management — can never be turned
off.)

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

You can load many records at once from a spreadsheet — items, customers, vendors,
locations, prices, promotions, BoMs and assets.

1. **Download the template** (or **export** the current data) for the record type,
   fill it in, and save as **CSV**.
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

**Next:** [Approvals](./10-approvals.md) ·
[Troubleshooting & FAQ](./99-troubleshooting-faq.md)
