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
2. Click **Add employee** and enter their details: name, employee code, salary,
   and statutory settings (Social Security, pension rate).
3. Save.

**Expected result:** The employee is added and will be included in the next
payroll run.

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

## 5. Employee self-service (ESS)

This section is for **every employee** (not just HR). The self-service screen lets
you see your own information and submit your own requests — you can never see
another employee's data.

**Screen:** `/ess` · **Required permission:** `ess` · **Where:** sidebar →
**บุคลากร & เงินเดือน → พื้นที่พนักงาน (ESS)** (available in both the ERP and POS
workspaces).

Tabs: **ข้อมูลของฉัน** (My info) · **ขอลางาน** (Request leave) · **เบิกค่าใช้จ่าย**
(Claim expense) · **ลงเวลา** (Timesheets).

### 5.1 View my info, leave balances and payslips
1. Open **ESS** (`/ess`) → **ข้อมูลของฉัน**.
2. Review your profile, your **leave balances** (entitled / used / remaining), and
   your **payslips** (gross, OT, SSO, pension, withholding tax, net).

### 5.2 Request leave
1. Go to the **ขอลางาน** tab, choose the leave type, dates, number of days and
   whether it is paid, then **ส่งคำขอลา**.
2. The request is created as **Pending** and routes to your manager for approval.

> **Control:** You can only *submit* a leave/expense request. **Approval is a
> separate manager action** (permission `approvals`) and a manager cannot approve
> their own claim — segregation of duties (SoD R07) is preserved.

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
2. Press **อนุมัติ** to approve, or **ปฏิเสธ** to reject.

**Expected result:** On **approve**, the claim becomes **Approved** and an **AP
reimbursement payable** is raised to the employee (Dr 5100 / Cr 2000) — it then
settles through the normal AP pay flow. On **reject**, the claim is closed with no
GL impact.

> **Control:** You **cannot approve your own claim** — the system blocks it with
> `SOD_SELF_APPROVAL` (segregation of duties, R07). The approver must differ from
> the claimant.

---

**Next:** [Tax](./07-tax.md) · [General Ledger](./06-general-ledger.md)
