# Invisible ERP — User Manual

**Status: DRAFT v0.1** · Last updated: 2026-06-22

Welcome to the Invisible ERP end-user manual. This guide explains, in plain
language, how to perform everyday tasks in the system — selling at the till,
taking orders, receiving stock, paying suppliers, closing the books, running
payroll, and more.

---

## Who this manual is for

This manual is written for **end users** (shop staff, cashiers, accountants,
warehouse operators, buyers, managers and administrators) — not for developers.
You do **not** need any technical knowledge to follow it.

Each task is written as numbered steps ("To do X: 1… 2… 3…") and tells you:

- **Where** to go (the screen / web address, e.g. `/pos`)
- **Who** can do it (the role or permission required)
- **What** to expect (the result, and any error messages you might see)

---

## Before you start — important conventions

> **The screens are in Thai by default.**
> Invisible ERP is a Thai-first application. The buttons and labels you see
> on screen are normally in **Thai**. Throughout this manual we give the
> **English meaning first**, followed by the **Thai label in brackets**, e.g.
> *Confirm Order* (**ยืนยันออเดอร์**). The location of buttons and the steps are
> the same regardless of the display language.

| Convention | Meaning |
|------------|---------|
| `/pos` | A screen address (route). Your address bar shows `…/pos`. |
| **Required role / permission** | The access right you need. If you don't have it, the menu item is hidden. |
| `<<placeholder>>` | Replace with your own value, e.g. `<<customer code>>`. |
| `[screenshot: …]` | A picture would appear here in the published manual. |
| **Note:** … | An important control, rule or warning. |
| Error codes (e.g. `CREDIT_LIMIT`) | Messages the system shows when an action is blocked. See [Troubleshooting & FAQ](./99-troubleshooting-faq.md). |

---

## How this manual is organised

The manual is organised first by **getting started**, then by **module**. Find
the module that matches your job, or use [Getting Started](./00-getting-started.md)
if this is your first time logging in.

### Index / table of contents

| # | Guide | For |
|---|-------|-----|
| — | [README (this page)](./README.md) | Everyone |
| 00 | [Getting Started](./00-getting-started.md) | Everyone — first login, password, MFA, navigation |
| 01 | [Sales & POS](./01-sales-and-pos.md) | Cashier, Sales, PosSupervisor, ReturnsClerk |
| 02 | [Customer Portal](./02-customer-portal.md) | Customer (shop owners using the portal) |
| 03 | [Procurement](./03-procurement.md) | Procurement, Buyer |
| 04 | [Warehouse & Inventory](./04-warehouse-inventory.md) | Warehouse, WarehouseOperator, StockCounter, InventoryController |
| 05 | [Finance — AR & AP](./05-finance-ar-ap.md) | ArClerk, ApClerk, Procurement |
| 06 | [General Ledger](./06-general-ledger.md) | GlAccountant, FinancialController |
| 07 | [Tax](./07-tax.md) | Accountants, FinancialController |
| 08 | [Payroll](./08-payroll.md) | HR / Payroll administrators |
| 09 | [Reports & Analytics](./09-reports-and-analytics.md) | Managers, Planner, ExecutiveViewer |
| 10 | [Approvals](./10-approvals.md) | Anyone who approves documents |
| 11 | [Administration](./11-administration.md) | Admin, AccessAdmin, MasterDataAdmin |
| 12 | [Platform Customization](./12-platform-customization.md) | Admin, AccessAdmin, MasterDataAdmin, Executives |
| 13 | [Members & Points CRM](./13-loyalty-crm.md) | Sales, Marketing, Loyalty Admin, Managers |
| 14 | [Project Management](./14-project-management.md) | Planner, Project Managers, Executives |
| 15 | [Real Estate](./15-real-estate.md) | RE Sales, Executives |
| 16 | [CRM Workspace (deal board, leads, accounts)](./16-crm-workspace.md) | Sales, CRM Manager, Marketing, Executives |
| 19 | [HR — Employee Self-Service (My Profile & Documents)](./19-hr-ess.md) | Every employee; HR / HR Admin (approve) |
| 20 | [Quality — Non-Conformance (NCR) Register](./20-quality-ncr.md) | Quality (raise), Quality Approver / Executives (disposition) |
| 21 | [Supply Chain Planning — Demand Forecasting & Order Plans](./21-demand-planning.md) | Planners (`scm_plan`), Approvers (`scm_approve`/`exec`), Branch managers |
| 99 | [Troubleshooting & FAQ](./99-troubleshooting-faq.md) | Everyone |

---

## Key concepts (read once)

- **Multi-tenant.** Each shop / company is a separate **tenant**. You only ever
  see your own organisation's data. Your tenant is set when you log in.
- **Roles & permissions.** What you can see and do is controlled by your
  **role** (e.g. *Cashier*, *Sales*, *Admin*). Menu items you have no permission
  for are simply not shown. See [Getting Started](./00-getting-started.md).
- **Two-factor login (MFA).** Staff with sensitive duties (finance, approvals,
  user administration, admins) must use a **6-digit code** from an authenticator
  app each time they log in. See [Getting Started](./00-getting-started.md).
- **Maker-checker.** Sensitive actions (manual journal entries, large
  approvals) must be **approved by a different person** than the one who created
  them. You cannot approve your own work.
- **Segregation of duties (SoD).** The system prevents one person from holding
  conflicting duties (e.g. paying a supplier they also created). See
  [Administration](./11-administration.md).

---

*This is a living document. Sections marked `[screenshot: …]` and `<<placeholder>>`
are awaiting final content.*
