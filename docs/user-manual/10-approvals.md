# 10 · Approvals

**Status: DRAFT v0.5 · 2026-07-11** · *v0.5 (2026-07-11): documented the **Continuous controls monitoring** screen (`/controls`, §4d-bis) — the six-detector exception scanner (duplicate invoice/payment, ghost/duplicate vendor, split PO, weekend manual JE, dormant-vendor reactivation) with **managed disposition** (owner + due date + root cause, tracked to closure) and the **KCI dashboard** (open / overdue / MTTR + by-detector/severity/family). New RCM control **GOV-02**, migration `0336`.* · *v0.4 (2026-07-10): documented **batch approve/reject** on the **Pending Approvals** screen (`/approvals`) — an approver can tick several queued items and clear them in one action (§4e). Each ticked item still fires its **own** maker-checker endpoint, so its control and SoD (approver ≠ requester) are enforced per item exactly as a one-by-one approval — this is a UX convenience, **no new endpoint and no new numbered control**.* · *v0.3 (2026-07-06): documented **where these controls are surfaced in the app** — the workflow readiness check now appears as a **"Control readiness"** tab on the **Workflow Approvals** screen (`/workflow`), and the two detective exception reports (**"Voids / refunds"** G14, **"Voided tax invoices"** G16) appear as read-only review cards on the **Pending Approvals** screen (`/approvals`). UI surfacing of already-shipped checks — no new endpoint, no new numbered control.* · *v0.2 (2026-07-06): added the **workflow readiness check** (`GET /api/workflow/readiness`, `masterdata`/`approvals`/`exec`) — a go-live detective/config control that reports which engine-wired document types (PR/PO/BUDGET/PMR/BQR) lack an active definition and would therefore auto-approve; clarified that a document type with no definition auto-approves. No new numbered control.*

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

> **Budget check on PR/PO approvals (BUD-02):** if your company enabled the
> budget-control policy (**/budget → ควบคุมงบ**), approving a purchase
> requisition or purchase order also checks the **available budget** (approved
> budget − actuals − open commitments). The PR/PO screens show a budget chip
> next to the decision; over-budget approvals may require a **confirmation**
> (warn policy) or an **executive override with a recorded reason** (block
> policy, error `BUDGET_EXCEEDED`). See
> [Procurement](./03-procurement.md) and the
> [troubleshooting FAQ](./99-troubleshooting-faq.md) for the exact codes.

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

> **Important — no definition means auto-approve.** If a document type has **no
> active workflow definition**, the engine lets it through **automatically** (this
> keeps a brand-new site usable out of the box). That is convenient, but it also
> means that until you build a definition, those documents have **no second-person
> approval**. Before go-live, make sure every document type that should be
> maker-checked actually has an active definition — see the readiness check below.

---

## 4c-bis. Workflow readiness check (before go-live)

To confirm your site is actually enforcing maker-checker, run the **workflow
readiness check**: `GET /api/workflow/readiness` (permission `masterdata` /
`approvals` / `exec`). For **your company**, it lists every document type wired to
the approval engine — **PR, PO, BUDGET, PMR, BQR** — and, for each, whether it has
an **active definition** (`has_active_definition`) and therefore whether it would
currently **auto-approve** (`auto_approves`). It also returns an overall **`ready`**
(true only when *all* of them have a definition) and a **`missing`** list (the
document types that would auto-approve right now).

Use it as a go-live gate: if `ready` is false, build definitions for the document
types in `missing` (see 4c above) so that PRs, POs and budgets require a real
second approver instead of sailing through. The check is **read-only** — it only
tells you what's configured, it doesn't change any behaviour. (Detective /
configuration control for gap **G-cross-cutting**.)

> **Where to find it in the app.** This readiness check is surfaced as a **"Control
> readiness"** tab on the **Workflow Approvals** screen (`/workflow`). Open it before
> go-live to see, per document type (PR/PO/BUDGET/PMR/BQR), whether it has an active
> definition or would currently **auto-approve**.

---

## 4c-ter. Exception reports (periodic detective review)

Some actions stay **single-user by design** — POS voids and small refunds (to keep
the till fast) and tax-invoice voids (a Revenue Department requirement keeps the
number sequence gapless). Those are covered by **detective** review instead of a
second signature, and the two exception reports are surfaced right here on the
**Pending Approvals** screen (`/approvals`) as read-only review cards:

- **"Voids / refunds"** — every voided payment and every refund for the window
  (gap **G14**; full detail in [Sales & POS](./01-sales-and-pos.md)).
- **"Voided tax invoices"** — every voided tax invoice for the window (gap
  **G16**; full detail in [Tax](./07-tax.md)).

Both are **read-only** — nothing is approved from these cards. A reviewer
independent of the till / invoicing scans them periodically (monthly or per shift)
to spot unusual patterns.

---

## 4d. Pending-approvals monitor (supervisory view)

A maker-checker only protects you if the **checker actually acts**. If a payment,
a payroll run, a write-off or a journal entry sits waiting for its second
signature for weeks, the segregation is defeated in practice — cash is tied up
and the books stay mis-stated, with no one watching the queue.

The **pending-approvals monitor** (`GET /api/finance/approvals/pending`,
permission `exec` / `approvals` / `creditors`) gives a Controller one supervisory
worklist across **every** maker-checker queue at once:

- every **Draft journal entry** — manual JEs (GL-05) and **bank adjustments**
  (BANK-02), which post a Draft entry that doesn't affect balances until approved;
- payroll runs (PAY-03), asset revaluations (FA-08) and disposals (FA-09);
- **inventory write-off** requests (INV-07), **vendor payment** requests
  (AP-PAY/EXP-06), **manual FX rate** changes (FX-04), and **budgets** (BUD-01) —
  which post nothing (and don't count) until approved.

Each item is **control-tagged**, attributed to **who requested it**, valued, and
shows its **age in days**. The response rolls up the `count`, the
`oldest_age_days`, and an **`overdue`** count of items past the threshold
(`?overdue_days=N`, default 3). An item stuck past the threshold is itself a
**control finding** — either a transaction stalled before it can take effect, or
a control quietly bypassed because no one chased the second sign-off.
(Control **GOV-01**, COSO *Monitoring*.)

---

## 4d-bis. Continuous controls monitoring — exceptions & KCIs (`/controls`)

Where **Pending Approvals** watches items *awaiting* a sign-off, the **Controls
monitoring** screen (`/controls`, gated `exec`/`users`/`creditors`) scans the books
after the fact for **red-flag exceptions** and tracks each one to closure.

**Run scan** upserts findings from six detectors, each tagged with the **RCM control**
it relates to:

| Detector | What it flags | RCM |
| --- | --- | --- |
| Duplicate vendor invoice | Same vendor + invoice no. booked more than once | EXP-10 |
| Possible duplicate payment | Same vendor + amount repeated (possible double-pay) | EXP-01 |
| Ghost / duplicate vendor | Two vendors sharing one tax ID (grouped on *decrypted* values) | EXP-02 |
| Split PO | ≥2 non-Draft POs to one vendor within 7 days, each below the THB 50,000 approval ceiling but summing over it | EXP-02 |
| Weekend manual JE | A manual journal entry dated on a Saturday/Sunday | GL-05 |
| Dormant-vendor reactivation | A vendor with a >180-day gap between transactions that suddenly transacts again | EXP-05 |

Re-scanning is **idempotent** (a stable fingerprint per finding), so a recurring
issue is never duplicated and an already-dispositioned finding is never reset.

**Disposition** each finding (the **Findings** tab → *Disposition*): assign an
accountable **owner**, a remediation **due date** and a documented **root cause**, and
move it through *open → investigating → remediated | accepted | false positive*. A
closing disposition stamps **who/when** closed it, so every exception is tracked to an
accountable close.

The **KCI dashboard** tab is the management scorecard: **open exceptions**, an
**overdue** count (open past their due date), the **mean time-to-remediate**, and
breakdowns **by detector**, **by severity** and **by RCM control family**. The monitor
is **read-only** — it posts nothing to the GL. (Control **GOV-02**, COSO *Monitoring*.)

---

## 4e. Clearing several items at once (batch approve / reject)

When the queue is long, an approver doesn't have to open items one by one. On the
**Pending Approvals** screen (`/approvals`):

1. **Tick** the checkbox on each item you want to act on (or **Select all** to tick
   every batch-eligible item at once). The action bar shows how many are selected.
2. Click **Approve selected** — or **Reject selected**, which prompts once for a
   **reason applied to all** the ticked items.
3. A summary reports **how many succeeded**, and — if any failed — the count and the
   first error (e.g. one item you created yourself is blocked as `SOD_VIOLATION`
   while the rest go through).

> **No new authority.** Each ticked item fires its **own** maker-checker endpoint,
> so its control and segregation of duties (approver ≠ requester) are enforced
> **per item**, server-side, exactly as if you had approved it individually.
> Batching only saves clicks — it never lets you approve something you couldn't
> approve one at a time. Items that approve via a module-specific screen (a manual
> **FX rate** or a **budget** version, which need extra keys) are **not** ticked
> here; a **—** marks them, and you clear them on their own screen.

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
