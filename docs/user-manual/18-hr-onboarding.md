# 18 · HR — Onboarding & Offboarding

**Status: DRAFT v0.1**

This chapter is for **HR / People Ops**. It covers the employee joiner-mover-leaver
lifecycle: reusable **checklist templates** (onboarding and offboarding), starting a
checklist for an employee, working the tasks, and the **access-revocation completeness**
control that governs terminations.

**Screen:** `/hcm/onboarding` · **Required permission:** `hr` or `hr_admin`
(`exec` may view; **skipping an access-revocation task** requires `hr_admin` or `exec`).

Tabs: **Templates** · **Employee lifecycles** · **Exceptions**.

---

## 1. Build a checklist template

1. Go to **Onboarding / Offboarding** (`/hcm/onboarding`) → **Templates** tab.
2. Enter a **code** and **name**, choose the **kind** (Onboarding or Offboarding),
   and click **Save**.
3. On the template card, add each task: a **title**, a **category**
   (IT access, Payroll, Equipment, Documents, Training), and — for offboarding —
   tick **Access revocation** on any task that removes system access
   (email/SSO, VPN, production, etc.). Tasks are numbered in the order you add them.

## 2. Start a lifecycle for an employee

1. Open the **Employee lifecycles** tab.
2. Enter the employee's **emp code** and pick a **template**, then click **Start**.
   The template's tasks are copied onto the employee as a fresh checklist (all
   **pending**). An unknown emp code is rejected with **EMP_NOT_FOUND**.

## 3. Work the checklist

1. On the lifecycle card, click **Mark done** on each task as it is completed.
2. Click **Complete** when the checklist is finished.
   - **Onboarding** completes once you choose to close it.
   - **Offboarding** cannot be completed while any **access-revocation** task is
     still pending — see the control below.

## 4. Control callout — HR-05 (offboarding access-revocation completeness)

This is the SOX joiner-mover-leaver access control. When an employee leaves, their
system access **must be provably removed** before the offboarding is signed off:

- **Completion is blocked** with **ACCESS_REVOCATION_INCOMPLETE** while any task
  flagged *Access revocation* is still pending.
- A task can only be **skipped** by an `hr_admin`/`exec` user
  (**SKIP_REQUIRES_HR_ADMIN** otherwise) and **a reason is mandatory**
  (**SKIP_REASON_REQUIRED** otherwise). The skip is recorded on the audit trail
  (`EMPLIFECYCLE` / `ACCESS_REVOCATION_SKIP`).
- The **Exceptions** tab lists open offboardings whose access-revocation tasks are
  still pending past *N* days (oldest first) so stale terminations with live access
  are followed up.

## 5. Troubleshooting

| Message | Meaning | Fix |
|---|---|---|
| `ACCESS_REVOCATION_INCOMPLETE` | Tried to complete an offboarding with an access-revocation task still pending | Mark every access-revocation task done, or have an `hr_admin`/`exec` skip it with a reason |
| `SKIP_REQUIRES_HR_ADMIN` | An `hr`-only user tried to skip an access-revocation task | Ask an `hr_admin`/`exec` to skip it |
| `SKIP_REASON_REQUIRED` | Skipped an access-revocation task without a reason | Provide a reason when skipping |
| `TEMPLATE_EXISTS` | A template with that code already exists | Use a different code |
| `TEMPLATE_EMPTY` | Started a template that has no tasks | Add at least one task before starting |
| `EMP_NOT_FOUND` | The emp code does not exist | Check the employee code on the payroll master |
