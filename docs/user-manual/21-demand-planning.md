# 21 — Supply Chain Planning: Demand Forecasting & Order Plans (วางแผนความต้องการและการสั่งซื้อ)

**Status: DRAFT v0.1**

**Who this is for:** Planners who decide how much of each ingredient to buy for each branch; approvers who
release those plans into purchasing; branch managers who want to know why an order looks the way it does
**Screen:** `/demand` (found under **Planning & analytics** in the sidebar) — tabs **แผนสาขา**, **แผนสั่งซื้อ**,
**จำลองสถานการณ์**, **ดีมานด์พุ่ง**
**Required permission:** `scm_plan` (settings, run planning, edit and submit a plan, convert an approved
plan) · `scm_approve` **or** `exec` (approve or reject a plan) · the `Planner` role includes `scm_plan`

This module answers one question, per branch, per day: **how much of each ingredient should we buy?**

The problem is asymmetric. Order too little and the branch stocks out — a lost sale plus a disappointed
customer. Order too much and the surplus is thrown away at its full cost. Fixed reorder points cannot
express that trade-off, so the system forecasts demand as a *range* of possible futures and picks the order
quantity that costs least across them, taking account of how long the goods keep.

> **The system proposes; a person disposes.** A planning run never places an order. It produces a **draft**
> that a planner reviews, and a **second person** must approve before it becomes a purchase requisition
> (control **SCM-01**). This is deliberate: an approved plan turns straight into committed spend.

---

## 1. What the forecast is built from

The system reads what was actually sold, per branch, per business day:

- **Retail sales** rung on the POS.
- **Dine-in orders** taken in the kitchen — including buffet dishes that ring at ฿0.

> **Why this matters:** when a dine-in check is settled, the till copies the order lines into the sales
> records. If the system simply added both sources together it would count every dine-in dish **twice** and
> order roughly double. It therefore takes retail from the till and dine-in from the kitchen, never both for
> the same dish.

Two kinds of day are deliberately ignored when learning the pattern:

- **Days the branch was closed** — a closure is not a collapse in demand.
- **Days an item was stocked out** — you sold nothing because you *had* nothing. Counting those zeros as
  real demand would teach the system to order even less next time and keep the branch short.

Thai public holidays, promotions and the pay cycle are supplied to the forecast so it anticipates the
Songkran rush rather than being surprised by it.

---

## 2. Set up planning (once per company)

**Screen:** `/demand` → **แผนสาขา** → the planning settings are maintained through the API today; ask your
administrator to set them if the values below are not right for your operation.

| Setting | What it does | Sensible default |
|---|---|---|
| Horizon | How many days ahead each run plans | 14 |
| Service level | How cautious to be; higher = more safety stock | 0.95 |
| Look-back | How much sales history to learn from | 400 days |
| **Dine-in branch** | Which outlet dine-in orders belong to | **Set this** — see below |
| Closed weekdays / closure dates | Days the branch does not trade | as applicable |
| Auto-replan | Whether a demand spike queues a fresh plan automatically | off until you trust the alerts |

> ⚠️ **Set the dine-in branch.** Kitchen orders do not record which outlet they belong to. Until you nominate
> one, all dine-in demand collects in an "untagged" bucket and **your branches will be under-planned**. The
> แผนสาขา tab shows a warning when a large share of demand landed there.

You can also record, per item (or per item *and* branch), a **shelf life**, a service level, a minimum order
quantity or pack size, and what a shortage or a spoiled unit actually costs you. The more accurate those are,
the better the order sizing. Shelf life can be **suggested from your own goods-receipt history** — the system
looks at the expiry dates you have been receiving and proposes the typical figure.

---

## 3. To run a plan

1. Open `/demand` and choose the **แผนสาขา** tab.
2. Press **วางแผนตอนนี้**.
3. Wait for the run to appear at the top of the list with status **Completed**.

The run row shows how many series were forecast, how many branches were planned, and which engine produced
it (**เครื่องพยากรณ์** = the dedicated forecasting service; **คำนวณในระบบ** = the built-in fallback, used when
the service is switched off or unreachable — planning still works, it is simply less sophisticated).

Click a run to see the forecast behind it. The chart shows expected demand per day; where the forecasting
service produced them, a p10–p90 band shows the realistic range, which is what the order sizing is actually
based on.

Runs also happen **automatically overnight** if your administrator has scheduled them. Running twice in one
day is harmless — the system plans once per day and tells you it skipped.

---

## 4. To review and submit an order plan

1. Go to the **แผนสั่งซื้อ** tab. Each run produces one draft plan per branch.
2. Click a plan to open its lines. For each ingredient you see: what is on hand, how much is **ใกล้หมดอายุ**
   (expiring), what is already **กำลังมา** (on an open purchase order), what the system suggests, and the
   estimated risk of running out.
3. Adjust **สั่งจริง** on any line if you know something the system does not (a private function booking, a
   supplier problem). Your figure is what gets ordered.
4. Press **ส่งอนุมัติ**.

The plan now appears in the approvals centre for someone else to act on. You cannot approve it yourself —
see §5.

> **Where the numbers come from.** Hover a line's **ที่มา** to see the reasoning the system recorded: the
> model used, expected fill rate, expected waste, and any cap it applied. A common one is the shelf-life cap:
> the system will not buy more of a three-day ingredient than can realistically be sold in three days, even
> if the raw arithmetic suggests otherwise.

---

## 5. To approve or reject a plan

**Required permission:** `scm_approve` or `exec` — and you must **not** be the person who submitted it.

1. Open `/demand` → **แผนสั่งซื้อ**, or reach the plan from the pending-approvals centre.
2. Review the lines and the plan's total value.
3. Press **อนุมัติ** to approve, or **ปฏิเสธ** and give a reason.

If you try to approve a plan you submitted yourself, the system refuses with
**SOD_SELF_APPROVAL** — that is control **SCM-01** working as designed, not a fault. Segregation of duties
means whoever decides what to buy is not the same person who releases the spend.

A rejected plan returns to the planner with your reason attached; editing any line re-opens it as a draft so
it can be corrected and resubmitted.

---

## 6. To turn an approved plan into a purchase requisition

1. Open the approved plan.
2. Press **แปลงเป็นใบขอซื้อ**.

The system raises a normal **purchase requisition** through the usual purchasing process — from that point
it follows the standard approval thresholds, purchase order, receiving and three-way match you already use.
The requisition number is shown on the plan.

Pressing the button twice is safe: it returns the requisition already created rather than raising a second
one.

> This module raises **no accounting entries** of its own. The financial effect happens later, when goods are
> received and invoiced, exactly as with any other purchase.

---

## 7. To try a what-if scenario

**Screen:** `/demand` → **จำลองสถานการณ์**

Use this to answer "what would we need if…" without touching anything:

1. Enter up to 25 item codes, separated by commas.
2. Optionally pick a branch.
3. Set a **ตัวคูณดีมานด์** — for example `2` for a festival weekend at double the usual trade.
4. Set the number of days, and press **คำนวณ**.

You get the quantities and estimated cost that scenario would require. **Nothing is saved** and no plan or
requisition is created — it is purely for thinking.

---

## 8. To act on a demand spike

**Screen:** `/demand` → **ดีมานด์พุ่ง**

The system watches each branch-and-item combination against *its own* normal level and flags days that are
genuinely out of character — not simply busy. Small-number noise (2 units becoming 7) is ignored.

Each alert shows what was expected, what actually happened, and how far out of normal it was. You can:

- **Investigate** — was it a one-off private booking, or the start of a trend?
- **ปิดเรื่อง (Dismiss)** — if you know the cause and no action is needed.

If automatic replanning is switched on, a spike also queues a fresh, targeted plan for that branch. That
replan is still only a **draft**: it goes through the same approval as any other plan. A spike never orders
anything by itself.

One busy evening produces **one** alert, not one per item and not one per hour — repeats are suppressed for a
cooldown period so the list stays worth reading.

---

## 9. Common questions

**The plan suggests nothing for an item.** Usually correct: you already hold enough, or enough is on its way.
Check the on-hand and in-transit columns.

**The suggested quantity looks low for a fresh item.** The shelf-life cap is probably binding — there is no
point buying eight days of a three-day ingredient. Check the item's shelf life is right; if the goods really
do keep longer, correct it (§2) and re-run.

**A run says "คำนวณในระบบ" instead of the forecasting service.** The dedicated service is switched off or was
unreachable. Planning still works using the simpler built-in method, and the shelf-life protection still
applies. Tell your administrator if you expected the service to be running.

**Everything landed in one unnamed branch.** The dine-in branch is not set — see the warning in §2.

**I cannot see the approve button.** You do not hold `scm_approve`. That is a separate duty from planning by
design; ask your administrator.

---

## 10. Related

- Process narrative: `docs/process-narratives/34-supply-chain-planning.md`
- Controls: **SCM-01** (approval), **SCM-02** (job reliability), **SCM-03** (how quantities are derived)
- Purchasing continues in chapter **03 — Procurement**
- Waste and spoilage recording: chapter **04 — Inventory**

## Revision history

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-07-21 | New chapter — docs/54 supply-chain planning: demand forecasting, order plans with maker-checker approval, purchase-requisition hand-off, scenario planning and demand-spike alerts. |
