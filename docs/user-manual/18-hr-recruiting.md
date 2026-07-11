# 18 · HR — Recruiting / ATS

**Status: DRAFT v0.1**

This chapter is for **HR / Talent Acquisition**. It covers the full recruiting
flow: raising a job requisition, building a candidate pipeline, extending an
offer, and converting an accepted offer into a new employee (a hire).

**Screen:** `/hcm/recruiting` · **Required permission:** `hr` or `hr_admin`
(exec may view; requisition approval, offer authorization and convert-to-hire
require `hr_admin` or `exec`).

Tabs: **Requisitions** · **Pipeline** · **Offers**.

---

## 1. Raise and approve a requisition

1. Go to **Recruiting** (`/hcm/recruiting`) → **Requisitions** tab.
2. Enter a requisition number (or leave blank to auto-number), optionally a
   position code, the **headcount** to fill, and a justification. Click **Save**.
   The requisition opens in status **pending**.
3. A **different user** (not the requester) clicks **Approve** on the row. A
   requester approving their own requisition is blocked with **SOD_SELF_APPROVAL**
   (control **HR-04**). Only an approved requisition can proceed to offers/hires.

## 2. Build the candidate pipeline

1. Open the **Pipeline** tab. Add a candidate (name + optional email/source) —
   this is a talent-pool record, not yet an employee.
2. Create an **application** linking a requisition (`req_no`) to a candidate
   (`cand_no`). It starts at stage **applied**.
3. Use the **Advance** action to move the application through
   `applied → screen → interview → offer → hired`. Advancing to **offer** (or
   **hired**) requires an **approved** requisition, otherwise
   **REQUISITION_NOT_APPROVED**.

## 3. Extend, authorize and convert an offer

1. Open the **Offers** tab. Create an offer against an application ID with an
   offered salary/grade. It starts at status **pending**.
2. A **different user** (not the offer creator) clicks **Approve** — a creator
   approving their own offer is blocked with **SOD_SELF_APPROVAL**.
3. Click **Convert to hire** on an **approved** offer. This creates a
   `payroll.employees` row from the candidate. Converting an unapproved offer is
   blocked with **OFFER_NOT_APPROVED**; hiring beyond the requisition headcount is
   blocked with **HEADCOUNT_EXCEEDED**. Once the headcount is met the requisition
   flips to **filled**.

## 4. Control callout — HR-04 (recruiting maker-checker)

No one may both request headcount and authorise it, no candidate becomes an
employee without an independently authorised offer, and the number of hires never
exceeds the approved requisition establishment. This protects the payroll base and
the approved org plan from unbudgeted or un-reviewed hires.

## 5. Troubleshooting

| Message | Meaning | Fix |
|---|---|---|
| `SOD_SELF_APPROVAL` | The requester/creator tried to approve their own requisition or offer | A different `hr_admin`/`exec` user must approve |
| `REQUISITION_NOT_APPROVED` | Offer/hire attempted before the requisition is approved | Approve the requisition first (by a different user) |
| `OFFER_NOT_APPROVED` | Convert attempted before the offer is authorized | Authorize the offer first (by a different user) |
| `HEADCOUNT_EXCEEDED` | Hiring beyond the requisition headcount | Raise/approve a new requisition for the extra seat |
| `REQUISITION_EXISTS` / `CANDIDATE_EXISTS` | Duplicate `req_no` / `cand_no` for the company | Use a unique code |
