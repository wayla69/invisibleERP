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

The run posts the relevant accounting entries automatically (salary expense, the
employer's SSO contribution, and withholding tax payable).

> **Note:** Each period's run is recorded in the run history so you can see what
> was paid and when.

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

**Next:** [Tax](./07-tax.md) · [General Ledger](./06-general-ledger.md)
