# 10 · Approvals

**Status: DRAFT v0.1**

This chapter is for **anyone who approves documents** — managers, financial
controllers, procurement leads. It covers the approvals inbox, approving and
rejecting, delegating your approvals while away, and how amount thresholds work.

**Screen:** `/approvals` (and the workflow screen at `/workflow`) ·
**Required permission:** `approvals`

---

## 1. How approvals work

Many actions (purchase requisitions, large journal entries, budgets, leave, etc.)
route to an **approver** before they take effect. The rules decide:

- **Who** approves (a role or a named user).
- **How many** approvals are needed (e.g. all of several approvers).
- **At what amount** each step kicks in (an **amount threshold** — small items may
  skip approval, large ones may need a higher approver).

> **Note — maker-checker:** The person who **creates** a document **cannot
> approve it themselves**. Attempting to do so is blocked as `SOD_VIOLATION`
> (*self-approval blocked*).

---

## 2. Approving or rejecting an item

1. Go to **Approvals** (`/approvals`) — or **Workflow** (`/workflow`) → **My
   Approvals** tab — to see your inbox.
2. Open an item to review its details and amount.
3. Click **Approve** or **Reject**.
4. If rejecting, enter a **reason**.

**Expected result:** On approve, the underlying action proceeds (e.g. the PO is
authorised, the journal entry posts). On reject, it is returned / voided with your
reason recorded.

[screenshot: My Approvals inbox with Approve / Reject]

---

## 3. Delegating your approvals

Going on leave? Delegate your approvals so work isn't held up.

1. Go to **Workflow** (`/workflow`) → delegations.
2. Click **Add delegation**: choose the colleague to act on your behalf and the
   start / end dates.
3. Save.

**Expected result:** During the delegation window, the delegate sees your
approval items in their inbox. Revoke a delegation anytime by deleting it.

> **Note:** Delegation does not bypass segregation of duties — a delegate still
> cannot approve a document they themselves created.

---

## 4. Amount thresholds (who needs to approve what)

Approval rules can be tied to **amount thresholds**. For example:

| Amount | Approval needed |
|--------|-----------------|
| Below `<<small threshold>>` | None (auto-approved) |
| `<<small>>` – `<<large threshold>>` | One manager |
| Above `<<large threshold>>` | Senior / multiple approvers |

The exact thresholds are configured by your administrator on the **Approval
Definitions** in `/workflow`. See [Administration](./11-administration.md).

---

## 5. Approvals you'll commonly see by module

| Document | Where it starts | Approved by |
|----------|----------------|-------------|
| Purchase requisition / PO | [Procurement](./03-procurement.md) | Procurement lead |
| Manual journal entry | [General Ledger](./06-general-ledger.md) | *FinancialController* (`gl_close`) |
| Bank reconciliation | [Finance — AR & AP](./05-finance-ar-ap.md) | Certifier (`approvals`) |
| Budget version | [Reports & Analytics](./09-reports-and-analytics.md) | Finance approver |
| Leave request | [Payroll](./08-payroll.md) (HCM) | Manager |

---

**Next:** [Administration](./11-administration.md) ·
[Troubleshooting & FAQ](./99-troubleshooting-faq.md)
