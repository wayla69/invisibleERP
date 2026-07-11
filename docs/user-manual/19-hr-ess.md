# 19 · HR — Employee Self-Service (My Profile & Documents)

**Status: DRAFT v0.1**

This chapter is for **every employee**. It covers the self-service surface where you
maintain your own contact and identity details, keep your personal documents, and look
up your team — with a control that protects sensitive changes.

**Screen:** `/hcm/ess` (**My Profile & Documents**) · **Required permission:** `ess`
(HR staff with `hr`/`hr_admin` also approve sensitive changes; `exec` may view).

Tabs: **Profile & change requests** · **My documents** · **Team directory**.

---

## 1. Request a profile change

1. Go to **My Profile & Documents** (`/hcm/ess`) → **Profile & change requests** tab.
2. Pick the **field** you want to change, type the **new value**, add an optional
   **reason**, and click **Submit change request**.
3. What happens next depends on the field:
   - **Everyday fields** — *phone, address, emergency contact* — are updated
     **immediately** (status **applied**).
   - **Sensitive fields** — *name, national ID, bank account, tax ID* — are sent to
     **HR for approval** (status **pending**). Your record is **not** changed until an
     HR user approves. A banner reminds you that you cannot approve your own request.

You only ever see and change **your own** requests.

## 2. HR approves or rejects a sensitive change

*(HR staff only — `hr` / `hr_admin`.)*

On the requests list, a **pending** row shows a green **approve** and a red **reject**
button:

- **Approve** writes the new value to the employee master and marks the request
  **approved**. The approver **must be a different person** from the requester.
- **Reject** leaves the employee record unchanged and marks the request **rejected**.

Every decision is recorded on the audit trail (`ESSPROFILE`, with the before/after).

## 3. My documents

1. Open the **My documents** tab.
2. Choose a **document type** (contract, ID card, certificate, tax form, other), give it
   a **title**, and optionally a **file reference** (an object-storage key
   `objstore:<key>` or a short note), then click **Upload document**.
3. Your documents are **private to you and HR**. HR may also file documents *for* you
   that are marked **HR-only** — those do not appear in your list.

## 4. Team directory

The **Team directory** tab lists your colleagues. As an employee you see the members of
**your own department**; HR staff see the whole company. Only names, positions and
departments are shown — never anyone's personal or pay details.

## 5. Control callout — HR-08 (ESS profile-change maker-checker)

This is the SOX self-service master-data control. It stops an employee from silently
repointing their own pay or altering a statutory identifier, and stops anyone reaching a
colleague's record:

- A change to a **sensitive** field (name, national ID, bank account, tax ID) is parked
  **pending**; the employee master is written **only** when a **different** `hr`/`hr_admin`
  user approves.
- The requester **cannot approve their own** change (**SOD_SELF_APPROVAL**), and the
  approve action is reserved to HR.
- **Reject** leaves the record unchanged.
- Every read and write is **own-scoped** — you can only see and change your own requests
  and documents — and isolated per company.

## 6. Troubleshooting

| Message | Meaning | Fix |
|---|---|---|
| `SOD_SELF_APPROVAL` | You tried to approve your own sensitive change | A different `hr`/`hr_admin` user must approve it |
| `ESS_NO_EMPLOYEE` | Your login is not linked to an employee record | Ask HR to link your account to your employee (emp code) |
| `BAD_FIELD` | The field you tried to change is not self-service editable | Only the listed profile fields can be changed here |
| `BAD_VALUE` | The new value was empty | Enter a value |
| `BAD_OBJECT_KEY` | The file reference was not a safe object key | Use a plain `objstore:<key>` (no `..`, no leading `/`, no `scheme://`) or a note |
| `CHANGE_REJECTED` / `CHANGE_DECIDED` | The request was already rejected / applied | No action — the request is closed |
