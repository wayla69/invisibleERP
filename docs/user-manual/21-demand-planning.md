# 21 — Supply Chain Planning: Demand Forecasting & Order Plans (วางแผนความต้องการและการสั่งซื้อ)

**Status: DRAFT v0.9**

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

> **Promotions lift the forecast automatically.** When you run a promotion, the forecast now expects the
> extra demand on the promo days and orders for it — so a 25%-off weekend does not stock out on day one. Only
> your **approved** promotions count: the system reads them from your promotions list itself, so nobody can
> inflate an order by typing in a promotion that was never approved. Each forecast records *why* a quantity
> moved (for example "+30% — weekend promo"), so a reviewer can see the promotion behind the number. A
> "what-if" you try in the scenario tool is clearly marked advisory and can never turn into a real order.

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
| **Refit cadence** | How often the planner re-fits a stable series' forecast model (see note below) | 14 days |

> ⚠️ **Set the dine-in branch.** Kitchen orders do not record which outlet they belong to. Until you nominate
> one, all dine-in demand collects in an "untagged" bucket and **your branches will be under-planned**. The
> แผนสาขา tab shows a warning when a large share of demand landed there.

You can also record, per item (or per item *and* branch), a **shelf life**, a service level, a minimum order
quantity or pack size, and what a shortage or a spoiled unit actually costs you. The more accurate those are,
the better the order sizing. Shelf life can be **suggested from your own goods-receipt history** — the system
looks at the expiry dates you have been receiving and proposes the typical figure.

> **The planner now runs faster on stable catalogs.** For an item whose recent sales history has not
> changed, re-learning its forecast model from scratch every night buys nothing — so the system now
> **remembers each item's fitted model and reuses it**, which makes a run noticeably quicker for a large,
> settled catalog. It re-fits **automatically** whenever it matters: as soon as an item's demand history
> changes (a new sales day, a promotion added, a stockout corrected) it re-learns that item, and even a
> perfectly stable item is re-fitted at least every **refit cadence** (default **14 days**) so a model can
> never drift too far from the fresh figures. You do not have to do anything — the shorter you set the
> cadence, the more often stable items are refreshed; the longer, the faster the run. This changes no order
> quantity, only how quickly the plan is produced.

### To declare a reporting hierarchy (optional)

By default the system rolls your branches up to one company total, and your items up by their category — so a
"whole chain" number is simply the sum of the branches. If your business has an **in-between tier** — regions,
zones, or a custom item grouping — you can declare it so future coherent roll-ups and reconciliation know the
shape of your organisation:

1. Decide the levels for an axis. For branches this is usually **branch → region → company**; for items it is
   **item → category → total**.
2. Ask your administrator to declare it (`PUT /api/scm-planning/hierarchy`): each node names its parent, and
   the top node has no parent. For example `BKK01 → CENTRAL → บริษัท`.
3. The system checks the structure is a valid tree — every parent must exist and there can be no loops
   (a loop is rejected as *invalid hierarchy*).

You do **not** have to declare anything: if you skip this, the system builds the obvious two-level structure
(each branch under one total, each category under one total) automatically. Declaring a hierarchy changes no
forecast number on its own — it prepares the coherent multi-level view that reconciliation will use.

> **Totals now add up.** The system reconciles the branch forecasts so a "whole chain" figure equals the sum
> of the branches it is built from — a regional or company total no longer disagrees with the branch plans
> underneath it. With the default (bottom-up) reconciliation your per-branch order quantities are unchanged;
> only the roll-up view becomes coherent.

### To declare your supply network (optional)

**Screen:** `/network` (found under **Planning & analytics** in the sidebar) — **required permission:** `scm_plan`.

If your chain stocks its branches through a **central kitchen** or **distribution centre** rather than
ordering each branch straight from suppliers, you can describe that shape so future network planning can
pool the safety stock one tier up (less total inventory for the same service level). This is **definition
only** today — describing the network changes no order quantity on its own.

1. On the **โหนด (Nodes)** tab, add each place stock sits or flows through: a **supplier**, your
   **central kitchen / DC**, and each **branch** (a branch node links to the branch it represents). The
   system tags each with its *tier*: supplier, then DC/kitchen, then branch.
2. On the **เลน (Lanes)** tab, connect them: draw a lane **supplier → DC** and a lane **DC → branch** for
   each branch, and record that lane's typical **lead time**, minimum order quantity and pack size.
3. The banner at the top tells you whether the network is **valid**. It must be a simple two-tier flow —
   supplier to DC to branch — with every branch fed from a DC. It flags problems plainly: a lane that skips
   a tier, a branch left unconnected, or a loop. Fix those and the banner turns green.

> You do **not** have to describe a network. If you skip it, planning works exactly as before, per branch.
> A node that still has lanes attached cannot be deleted — remove its lanes first.

### To run and approve a multi-echelon network plan

Once your supply network is described and **valid** (above), you can plan across it — one item at a time —
so the safety stock **pools at the DC** instead of being carried at every branch (the same service level for
less total inventory). Building a plan needs `scm_plan`; approving one needs `scm_approve` **and a different
person** — exactly like an order plan, because an approved plan turns into committed spend (control
**SCM-05**).

1. **Run the plan** — `POST /api/scm-network/plans/run` with the item code. The system reads each branch's
   demand, sizes a base-stock at every branch *and* at the DC (pooling the branch risk), and saves a
   **draft** network plan — nothing is ordered yet.
2. **Review it** — `GET /api/scm-network/plans/:id`. Each line shows the node, its base-stock, and the order
   the DC would place upstream.
3. **Submit it for approval** — `POST /api/scm-network/plans/:id/submit`. The plan moves to *pending
   approval* and appears in the approvals centre.
4. **A second person approves it** — a colleague holding `scm_approve` calls
   `POST /api/scm-network/plans/:id/approve`. You **cannot** approve a plan you submitted: the system refuses
   with **SOD_SELF_APPROVAL** — that is control **SCM-05** working as designed. To send it back instead,
   `POST /api/scm-network/plans/:id/reject` with a reason.
5. **Convert the approved plan** — `POST /api/scm-network/plans/:id/convert`. The DC's supplier order becomes
   a normal **purchase requisition** (the same purchasing flow as §6). Converting twice is safe — it returns
   the requisition already raised rather than a second one.

> If the dedicated forecasting service is switched off or unreachable, the plan still runs using a simpler
> built-in method — each branch buffered on its own, **without** the DC pooling benefit — so planning never
> stops. As with order plans, this raises **no accounting entries** of its own; the financial effect happens
> later, when the requisition becomes a purchase order and goods are received.

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

> **Try a price change too.** You can also set a **price multiplier** — for example `1.1` to ask "what if
> we raise the price 10%?". The system knows, per item, how sensitive its demand has been to price in the
> past (its *own-price elasticity*, learned from how sales moved when promotions changed the effective
> price), and lowers or raises the scenario demand accordingly. If an item has never had enough price
> movement to learn from, its demand is left unchanged — the system will not invent a sensitivity it cannot
> see. As with everything on this screen, a price what-if is advisory: nothing is saved and no order results.

> **Neighbours react too.** When you change the price of items that sit in the same category, the system
> also accounts for how they compete or complement each other — cut one dish's price and a similar dish
> beside it may sell a little less (cannibalization), while some pairings lift together (halo). So a price
> what-if that includes several items in a category shows each one's demand after both its own price effect
> and the pull of its neighbours whose price you also moved. This only applies **within a category** and
> only to items you actually included in the what-if; as ever, nothing is saved.

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
- Controls: **SCM-01** (order-plan approval), **SCM-02** (job reliability), **SCM-03** (how quantities are derived), **SCM-04** (promo-forecast governance), **SCM-05** (network-plan approval)
- Purchasing continues in chapter **03 — Procurement**
- Waste and spoilage recording: chapter **04 — Inventory**

## Revision history

| Version | Date | Change |
|---|---|---|
| 0.9 | 2026-07-23 | Added §2 note "The planner now runs faster on stable catalogs" + a **Refit cadence** settings row — docs/59 Track D · D2: the planner caches each item's fitted forecast model and reuses it when demand history is unchanged, refitting automatically when the history changes or after the refit cadence (default 14 days). Compute-only; changes no order quantity, no new control. |
| 0.8 | 2026-07-23 | Added §2 "To run and approve a multi-echelon network plan" — docs/57 Track B · B2: run a two-echelon plan (`POST /api/scm-network/plans/run`) that pools safety stock at the DC, then submit → approve (a different `scm_approve` holder; self-approval → `SOD_SELF_APPROVAL`) → convert to a purchase requisition (idempotent). New control **SCM-05**; falls back to per-branch (no pooling) when the engine is off; raises no accounting entries. |
| 0.7 | 2026-07-22 | Added §7 note "Neighbours react too" — docs/56 Track A · A3: a price what-if across same-category items now also reflects category-scoped cannibalization/halo between the items whose price moved. Advisory only. |
| 0.6 | 2026-07-22 | Added §7 note "Try a price change too" — docs/56 Track A · A2: the scenario what-if gains a price multiplier that applies each item's learned own-price elasticity (unchanged when none is on file). Advisory only. |
| 0.5 | 2026-07-22 | Added §2 "To declare your supply network (optional)" — docs/57 Track B · B1: describe the supplier→DC→branch topology on `/network` (nodes + lanes as governed master data, with a live validity banner). Definition only; changes no order quantity (the two-echelon optimizer arrives in B2). |
| 0.1 | 2026-07-21 | New chapter — docs/54 supply-chain planning: demand forecasting, order plans with maker-checker approval, purchase-requisition hand-off, scenario planning and demand-spike alerts. |
| 0.4 | 2026-07-22 | Added §2 note — branch forecasts now reconcile so chain/region totals equal the sum of their branches (docs/58 Track C · C2); default bottom-up leaves per-branch quantities unchanged. |
| 0.3 | 2026-07-22 | Added §1 note — promotions now lift the forecast automatically (docs/56 Track A · A1); server-derived from approved promotions only (a fabricated promo cannot inflate an order), with promo attribution shown per line. |
| 0.2 | 2026-07-22 | Added §2 "To declare a reporting hierarchy (optional)" — docs/58 Track C · C1: declare branch→region→company / item→category→total structures (or let the system synthesize the obvious two-level tree). Definition only; changes no forecast number. |
