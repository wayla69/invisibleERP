# 08 · Payroll

**Status: DRAFT v0.1**

This chapter is for **HR / Payroll administrators**. It covers maintaining
employees, running payroll, viewing payslips, statutory deductions, and the
withholding-tax forms.

**Screen:** `/payroll` · **Required permission:** payroll / finance access (e.g.
`exec`, `users`, `creditors`)

Tabs: **Employees** · **Run Payroll** · **PND1** (ภ.ง.ด.1, monthly) ·
**PND1A** (ภ.ง.ด.1ก, annual).

---

## 1. Maintain employees

1. Go to **Payroll** (`/payroll`) → **Employees** tab.
2. Click **Add employee** and enter their details: name, citizen ID, SSO number,
   position, department, start date, salary, hourly rate (for overtime), pension
   (PF) rate, allowances, bank account, and SSO eligibility.
3. Save.

**Expected result:** The employee is added and will be included in the next
payroll run. The employee list shows department and start date alongside
position and salary.

> Employee records can currently only be **created** here — there is no edit
> screen yet, so double-check the details before saving.

> 🔒 **PII protection:** the citizen ID (เลขบัตรประชาชน), SSO number and bank
> account you enter are **encrypted at rest** (AES-256-GCM) — a database snapshot
> never contains them in the clear. Screens and statutory forms (ภ.ง.ด.1/1ก)
> still show the real values to authorized payroll users. (Control ITGC-AC-19.)

[screenshot: employee list]

---

## 2. Run payroll

1. Go to **Payroll** → **Run Payroll** tab.
2. Choose the pay **period** (`YYYY-MM`).
3. Click **Run payroll**.

**Expected result:** Payroll is calculated for all active employees, including:

- **Gross salary**
- **Social Security (SSO)** deduction — 5%, capped at 750 THB
- **Withholding tax (PIT)** — calculated from the Thai personal-income-tax tables
- **Pension fund** — at each employee's configured rate

The run prepares the accounting entries automatically (salary expense, the
employer's SSO contribution, and withholding tax payable) — but **does not post
them yet**.

> **Which accounts?** By default the standard set (salaries 5600, employer SSO 5610,
> SSO payable 2350, WHT payable 2360, provident fund 5620/2370, net pay from cash 1000).
> If your company needs a leg on a different account, add an override row on
> **กฎการลงบัญชี** (`/setup/posting-rules`) for the matching `PAYROLL.*` event/role —
> the run then posts that leg to your account, and everything you don't override keeps
> the standard behaviour.

### 2.1 Approval (required before payroll counts) — two people

Payroll uses **maker-checker**: the run you just made is **"รออนุมัติ" (PendingApproval)**
and its accounting entry is held out of the books until **a different person approves it**.

1. A second user (e.g. Payroll Manager / Financial Controller) goes to **Run Payroll**,
   finds the pending run, and clicks **อนุมัติ (Approve)**.
2. On approval the entry becomes effective and the run shows **"ผ่านแล้ว" (Posted)** with
   who approved it.

- **You cannot approve your own run** — the system refuses it ("ผู้บันทึกอนุมัติรายการ
  ของตนเองไม่ได้", `SOD_VIOLATION`). This applies to **everyone, including Admin** — it
  is the key control that stops one person from paying themselves or a ghost employee.
- If the figures are wrong, click **ปฏิเสธ (Reject)** instead; the draft entry is voided
  and you can run the period again with the correction.

> **Note:** Each period's run is recorded in the run history with its status
> (รออนุมัติ / ผ่านแล้ว / ปฏิเสธ), who ran it, and who approved it.

> **Large runs (optional):** for a company with many employees the run can be processed
> **in the background** so the page doesn't wait. The system accepts the request
> immediately and returns a **job** you can check under *Jobs* (or by its id); when it
> finishes, the run appears in the history exactly as a normal run — still posted as a
> Draft that a different person must approve. Running the same period twice is safe (it
> won't pay anyone twice). Nothing changes for a normal-sized run.

---

## 3. Payslips

1. Go to **Payroll** → **Run Payroll** and open the run for the period.
2. View the **payslips** for that run.

**Expected result:** Each employee's payslip shows gross pay, each deduction, and
net pay. Distribute payslips to employees as needed.

**Print / email a payslip (HR/payroll).** Each slip can be printed or emailed as a
PDF (`GET /api/payroll/slips/:id/pdf`, `POST /api/payroll/slips/:id/send-email`).
This is restricted to HR/payroll (permission `exec`, `users` or `creditors`);
an ordinary employee cannot use it — they download **their own** slip through
self-service instead (see §5.1). On the printed slip the employee's **citizen ID
is masked to its last 4 digits** (privacy/PDPA), and the employer's SSO/pension
contributions are shown for information (they are not deducted from the employee).

[screenshot: payslip detail]

---

## 4. Statutory withholding-tax forms

| Form | Tab | Purpose |
|------|-----|---------|
| **PND1** (ภ.ง.ด.1) | PND1 | Monthly withholding-tax submission for salaries |
| **PND1A** (ภ.ง.ด.1ก) | PND1A | Annual withholding-tax summary |

### To produce a form

1. Open the **PND1** tab and choose the **period** (`YYYY-MM`), or the **PND1A**
   tab and choose the **year**.
2. View the form and export it for filing.

**Expected result:** The form lists each employee, income paid and tax withheld
for the chosen period / year.

---

> **Related:** Time tracking and leave (HCM) — timesheets and leave requests —
> are managed through the HCM functions. Leave requests follow an approval step
> (see [Approvals](./10-approvals.md)).

---

## 4b. Leave entitlement & accrual (HCM · HR-2)

**Route:** `/hcm` → tab **สิทธิ์การลา (สะสม)** (Leave entitlement / accrual).
**Required role:** view — `hr` / `hr_admin` / `exec` / `ess` (own); configure + run accrual — `hr_admin` / `exec`.

Leave balances are earned through an **accrual engine** rather than being fixed:

1. **Define leave types.** For each type set an **accrual method** (monthly / anniversary / none), the
   **rate per period** (e.g. 1.25 days/month), a **carryover cap** and a **max balance**.
2. **Add policy overrides (optional).** Grant a higher rate for a **job grade** and/or a **minimum tenure**
   (months of service). The highest matching policy wins; otherwise the type's default rate applies.
3. **Run the accrual.** Enter a period (`YYYY-MM`) and press **รันการสะสม**. Each active employee's balance is
   credited; at the year boundary the prior year's remaining balance rolls into **carryover** (capped), and
   the excess **expires**. Re-running the same period does nothing (idempotent). This job can also be scheduled
   monthly from Reports (report type *สะสมวันลาประจำงวด / Run monthly leave accrual*).
4. **Balances table** shows accrued / carryover / used and the **available** balance
   (`entitled + accrued + carryover − used − expired`).

> **Control HR-02:** a **paid** leave request beyond the available balance is rejected with
> `INSUFFICIENT_LEAVE_BALANCE` (unless the type allows a negative balance). Unpaid leave is not gated.
> Approval remains **maker-checker** — the requester cannot approve their own leave (`SOD_SELF_APPROVAL`).

---

## 4c. Team attendance (HCM · from the POS time-clock)

**Route:** `/hcm` → tab **เวลาเข้า-ออกทีม** (Team attendance).
**Required role:** `hr` / `hr_admin` / `exec` (the HCM screen's standard gate).

For branches that clock staff in and out on the **POS time-clock**, HR now sees the whole team's
attendance without opening the POS back-office:

1. The summary tiles show **how many employees** have punches, **how many are clocked in right now**, and
   the **team's total hours**.
2. The table rolls the punches up **per employee** — name and code, number of sessions, total hours, the
   **last clock-in**, and a live **clocked-in / clocked-out** badge.
3. Use the **date** filter to narrow the roll-up to a single business day (Asia/Bangkok).

This is a **read-only** view; clocking in and out still happens at the POS time-clock. The employee's own
version of this is in ESS (`/ess` → **เวลาเข้า-ออก**, see §5.5). The data is sourced live from the POS
time-clock; if a branch does not use it, the tab is simply empty.

---

## 4d. Schedule adherence (HCM · rostered shifts vs. actual)

**Route:** `/hcm` → tab **การเข้ากะ** (Schedule adherence).
**Required role:** `hr` / `hr_admin` / `exec`.

Once shifts are rostered on the POS side, HR can see **who actually worked their shift**. This tab compares
each employee's **scheduled** hours (from the shift roster) against the **actual** hours they clocked, over a
date range (defaults to the last 14 days):

1. Summary tiles show total **scheduled** vs **actual** hours, the number of **no-shows**, and the total
   **exceptions**.
2. The table lists each employee with scheduled hours, actual hours, the **variance** (+ over / − under), and
   a status badge:
   - **ตรงตามกะ / On track** — worked within ±10% of the roster.
   - **ไม่มาตามกะ / No-show** — rostered but never clocked in.
   - **ทำงานน้อยกว่ากะ / Under** — clocked materially fewer hours than rostered.
   - **ทำงานเกินกะ / Over** — clocked materially more.
   - **ไม่ได้จัดกะ / Unscheduled** — worked without a roster entry.
3. Use the **from / to** filter to change the window.

Read-only — it does not change pay or rosters. It is the HR workforce-management counterpart to the
labour-cost / labour-% view used in POS operations (both read the same shift roster + time-clock).

---

## 5. Employee self-service (ESS)

This section is for **every employee** (not just HR). The self-service screen lets
you see your own information and submit your own requests — you can never see
another employee's data.

**Screen:** `/ess` · **Required permission:** `ess` · **Where:** sidebar →
**บุคลากร & เงินเดือน → พื้นที่พนักงาน (ESS)** (available in both the ERP and POS
workspaces).

Tabs: **ข้อมูลของฉัน** (My info) · **ขอลางาน** (Request leave) · **เบิกค่าใช้จ่าย**
(Claim expense) · **ลงเวลา** (Timesheets) · **เวลาเข้า-ออก** (Attendance).

### 5.1 View my info, leave balances and payslips
1. Open **ESS** (`/ess`) → **ข้อมูลของฉัน**.
2. Review your profile, your **leave balances** (entitled / used / remaining), and
   your **payslips** (gross, OT, SSO, pension, withholding tax, net).
3. Click the **printer icon** on a payslip row to **download it as a PDF**
   (สลิปเงินเดือน). You can only ever open **your own** slips — the system resolves
   your employee record from your login, so a link to anyone else's slip is refused.
   Your citizen ID is masked to its last 4 digits on the PDF.

### 5.2 Request leave
1. Go to the **ขอลางาน** tab, choose the leave type, dates, number of days and
   whether it is paid, then **ส่งคำขอลา**.
2. The request is created as **Pending** and routes to your manager for approval.

> **Control:** You can only *submit* a leave/expense request. **Approval is a
> separate manager action** (permission `approvals`) and a manager cannot approve
> their own claim — segregation of duties (SoD R07) is preserved. The same
> maker-checker rule applies to **leave**: the person who submits a leave request
> cannot approve it — a *different* approver must, otherwise the approval is
> refused (`SOD_SELF_APPROVAL`).

### 5.3 Claim an expense
1. Go to the **เบิกค่าใช้จ่าย** tab, enter the date, category, amount and
   description, then **ส่งคำขอเบิก**.
2. On manager approval the reimbursement becomes an **AP payable** and settles
   through the normal AP pay flow (it appears in AP aging).

### 5.4 Approve expense claims (manager)

This is the **manager side** of §5.3 — a separate screen, so an approver does not
need the `ess` permission.

**Screen:** `/expense-approvals` · **Where:** sidebar → **บุคลากร & เงินเดือน →
อนุมัติเบิกพนักงาน** (ERP and POS) · **Required permission:** `approvals`.

1. Open **อนุมัติเบิกพนักงาน** (`/expense-approvals`). It lists every employee
   expense claim still **Pending**, with the claimant, date, category and amount.
   On a phone the queue renders as one **card per claim** (with a batch checkbox and
   inline approve/reject) instead of the wide desktop table.
2. Press **อนุมัติ** to approve, or **ปฏิเสธ** to reject.

**Expected result:** On **approve**, the claim becomes **Approved** and an **AP
reimbursement payable** is raised to the employee (Dr 5100 / Cr 2000) — it then
settles through the normal AP pay flow. On **reject**, the claim is closed with no
GL impact.

> **Control:** You **cannot approve your own claim** — the system blocks it with
> `SOD_SELF_APPROVAL` (segregation of duties, R07). The approver must differ from
> the claimant.

### 5.5 My attendance (from the POS time-clock)

If your branch uses the **POS time-clock** to clock staff in and out, your own
clock-in/out history now shows up inside self-service — no need to ask a supervisor.

1. Open **ESS** (`/ess`) → **เวลาเข้า-ออก** (Attendance).
2. The summary tiles show your **total hours**, **days worked**, and whether you are
   **currently clocked in**. The table lists each session with its date, clock-in and
   clock-out time, hours, and how the punch was made (PIN / QR / etc.).

You only ever see **your own** punches — the screen resolves your employee record
from your login, so a colleague's attendance is never shown. This is a **read-only**
view; clocking in and out still happens at the POS time-clock as before.

> **Note:** The data is sourced live from the POS time-clock (the same records the
> store register captures). If your branch does not use the time-clock, the tab is
> simply empty.

---

## 6. Organisation structure & positions (HR-1)

Model your **org chart** — departments, positions and who sits in each — on top of
the employee master. This is where the **headcount governance** control (HR-01)
lives: you cannot over-fill a position beyond its budgeted headcount without an
executive override.

**Screen:** `/hcm/org` · **Where:** sidebar → **บุคลากร (HR) → โครงสร้างองค์กร &
ตำแหน่ง** · **Required permission:** view = `hr` / `hr_admin` / `exec`; create =
`hr_admin` / `exec`.

Tabs: **ผังองค์กร** (Org chart) · **แผนก** (Departments) · **ตำแหน่ง** (Positions) ·
**การมอบหมาย** (Assignments).

### 6.1 Departments

1. Open the **แผนก** tab and fill **รหัสแผนก** (dept code, unique per company),
   **ชื่อ**, an optional **แผนกแม่** (parent department code, to build a hierarchy),
   a **ศูนย์ต้นทุน** (GL cost centre) and a **ผู้จัดการ** (manager `EMP…`).
2. Press **บันทึก**. A duplicate code is refused with `DEPT_EXISTS`.

### 6.2 Positions

1. Open the **ตำแหน่ง** tab and fill **รหัสตำแหน่ง**, **ชื่อตำแหน่ง**, the owning
   **แผนก**, an optional **ระดับ** (grade) and **รายงานต่อ** (reports-to position),
   and the **อัตราที่ตั้งไว้** (budgeted headcount).
2. Each position row shows **บรรจุ/ตั้งไว้** — the current filled headcount vs the
   budget. Set the budget to **0** for an unbudgeted seat (no cap).

### 6.3 Assignments — the HR-01 headcount control

1. Open the **การมอบหมาย** tab, enter the employee **EMP…**, the **รหัสตำแหน่ง** and
   an **วันที่มีผล** (effective date), then press **มอบหมาย**.
2. If the position still has a vacancy the assignment is saved.

> **Control (HR-01):** If the position is **already at its budgeted headcount**, the
> assignment is **blocked** with `HEADCOUNT_EXCEEDED`. Only a user with the **`exec`**
> permission can override and add the over-establishment seat — supply an **เหตุผล**
> (override reason); the override is **audit-logged** (an `HRASSIGN` /
> `HEADCOUNT_OVERRIDE` entry) so every over-plan hire is attributable.

### 6.4 Org chart

The **ผังองค์กร** tab renders the department tree with each position, its assignees
and its **vacancies**, plus roll-up totals (departments, positions, budgeted vs
filled headcount). It is read-only.

> **Troubleshooting:** `HEADCOUNT_EXCEEDED` → the position is full; either raise the
> position's budgeted headcount, end an existing assignment, or ask an `exec` to
> override. `DEPT_EXISTS` / `POSITION_EXISTS` → the code is already used in your
> company; pick another. A **403** on create means you have only the read `hr`
> permission — creating departments/positions/assignments needs `hr_admin` or `exec`.

---

**Next:** [Tax](./07-tax.md) · [General Ledger](./06-general-ledger.md)
