# 18 · HR — Compensation bands + benefits

**Status: DRAFT v0.1**

This chapter is for **HR / People Ops**. It covers pay-grade bands, compensation
changes (with the within-band maker-checker control **HR-06**), benefit plans and
employee enrolments.

**Screen:** `/hcm/comp` · **Required permission:** `hr` or `hr_admin` (exec may
view; approvals require `hr_admin` or `exec`).

Tabs: **Pay grades** · **Comp changes** · **Benefit plans** · **Enrollments**.

---

## 1. Define pay-grade bands

1. Go to **Comp & Benefits** (`/hcm/comp`) → **Pay grades** tab.
2. Enter a grade code (e.g. `G5`), a name, and the band **Min / Mid / Max**
   salaries, then click **Save**. The band drives the HR-06 check on comp changes.

## 2. Request a compensation change

1. Open the **Comp changes** tab and enter the employee code, a change type
   (`Hire` / `Merit` / `Promotion` / `Adjustment`), the **new salary**, and the
   **target grade**.
2. Click **Submit request**. The change is created **pending** — nothing is written
   to the employee record yet.
3. If the new salary falls **outside** the target grade band, the request is
   blocked (`OUT_OF_BAND`). An `hr_admin`/`exec` may tick **Override band (exec)**
   to force it through; the override is recorded in the audit trail.

## 3. Approve or reject (maker-checker)

1. In the **Comp changes** table, a pending row shows **Approve** / **Reject**.
2. Approval must be done by a **different** user than the requester (`hr_admin` or
   `exec`). Self-approval is blocked (`SOD_SELF_APPROVAL`).
3. On **Approve**, the employee's monthly salary (and grade, if set) is updated.
   On **Reject**, the salary is left unchanged.

## 4. Benefit plans + enrolments

1. In **Benefit plans**, create a plan with a code, a category
   (`Health` / `Dental` / `Life` / `Provident fund` / `Allowance`) and the
   employer/employee monthly cost.
2. In **Enrollments**, enrol an employee into a plan. Ending an enrolment sets its
   status to **ended**. Employees see only their own enrolments via self-service.

## 5. Control callout — HR-06 (comp-change within band, maker-checker)

A salary change is validated against the target pay-grade band and can only be
finalised by someone other than the person who requested it, with the employee
record updated **only on approval**. This keeps the payroll base inside sanctioned
bands and stops self-approved raises.

## 6. Troubleshooting

| Message | Meaning | Fix |
|---|---|---|
| `OUT_OF_BAND` | The new salary is outside the target grade band | Choose a salary inside `[min, max]`, or have an `hr_admin`/`exec` tick **Override band** |
| `SOD_SELF_APPROVAL` | The requester tried to approve their own comp change | A different `hr_admin`/`exec` must approve |
| `GRADE_EXISTS` / `PLAN_EXISTS` | Duplicate grade or plan code | Use a unique code |
| `ALREADY_ENROLLED` | The employee is already active on that plan | End the existing enrolment first, or pick another plan |
