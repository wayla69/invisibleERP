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

## 4a. Routing by dimension (cost centre, department, vendor…)

Beyond amount, a step can carry a **dimension condition** — it engages only when
the document matches, e.g. *cost centre = IT* or *vendor = ACME*. This routes,
say, IT-department purchases to the IT approver and everything else to the
default approver, automatically.

## 4b. SLA, escalation & reminders

A workflow (or an individual step) can have an **SLA** in hours. When an approval
sits past its SLA it's flagged **เกินกำหนด / overdue** on the inbox, and the
**escalation approver** for that step is allowed to step in and act. Running
**ตรวจสอบงานเกินกำหนด** (the escalation sweep — also scheduled) sends the
escalation approver a **reminder notification**. This keeps work from stalling
when someone is away.

## 4c. Building a workflow (no-code)

On **Workflow → ผังการอนุมัติ**, an administrator builds a chain without code:
pick the **document type**, add **steps** (each: approver role *or* user, amount
threshold, how many must approve, optional SLA, escalation target, and a
dimension condition), and save. Toggle a definition active/inactive anytime.

---

## 4d. Pending-approvals aging monitor (supervisory view)

A maker-checker only protects you if the **checker actually acts**. If a payment,
a payroll run, a write-off or a journal entry sits waiting for its second
signature for weeks, the segregation is defeated in practice — cash is tied up
and the books stay mis-stated, with no one watching the queue.

The **pending-approvals aging monitor** (`GET /api/finance/approvals/aging`,
permission `exec` / `approvals` / `gl_close`) gives a Controller one supervisory
read across **every** maker-checker queue at once:

- every **Draft journal entry** — so it automatically covers manual JEs (GL-05),
  payroll runs (PAY-03), asset revaluations (FA-08) and disposals (FA-09), bank
  adjustments (BANK-02) and FX rate changes (FX-02);
- **inventory write-off** requests (INV-07) and **vendor payment** requests
  (AP-PAY), which post nothing until approved.

Each item is **control-tagged**, attributed to **who requested it**, valued, and
**aged** into buckets (0–3, 4–7, 8–14, 15+ days). Anything older than the **SLA**
(default **7 days**, override with `?stale_days=N`) is surfaced as an
**exception**, with an `all_clear` flag, a `stale_count`, and a per-control
roll-up. A stale pending approval is itself a **control finding** to chase down.
(Control **MON-01**.)

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
