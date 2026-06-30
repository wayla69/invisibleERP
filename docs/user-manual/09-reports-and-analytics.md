# 09 · Reports & Analytics

**Status: DRAFT v0.1**

This chapter is for **managers, planners and executives** — and anyone who needs
reports. It covers dashboards, Excel / PDF reports, AI-driven forecasting and
replenishment, anomaly detection, and the AI assistant.

---

## 1. Dashboards

| Dashboard | Screen | Permission | Shows |
|-----------|--------|-----------|-------|
| Operational dashboard | `/dashboard` | `dashboard` | Daily KPIs, sales, stock alerts |
| Executive dashboard | `/executive` | `exec` | Company-wide performance, finance KPIs |

1. Go to the dashboard for your role.
2. Review the KPI cards and charts; drill into a figure for detail.

**Live updates (streaming analytics).** The operational dashboard streams updates in real time — when the KPI
snapshot is refreshed, the headline figures update on their own without waiting for the periodic poll. A
**สด / ออฟไลน์ (Live / Offline)** badge by the *รีเฟรช* button shows whether the live feed is connected; if it
drops, the dashboard falls back to refreshing every 60 seconds and reconnects automatically.

The operational dashboard (`/dashboard`) shows headline KPIs (sales today / this
month, low stock, AP outstanding), a **14-day sales trend**, **top sellers today**,
and **recent orders**. It **auto-refreshes every 60 seconds** so the figures stay
live; a **รีเฟรช** button in the header forces an immediate refresh (its icon spins
while loading). The role-KPI strip and charts show their own loading / "ยังไม่มี
ข้อมูล" / "โหลดข้อมูลไม่สำเร็จ" states, and the layout reflows to one column on
phones/tablets.

**Expected result:** A live summary of business performance.

> **Note on freshness:** to keep the dashboards fast, the KPI/sales/finance/pipeline
> figures are cached briefly on the server (about 30 seconds) and shared across users
> of the same company, so a number may lag a brand-new transaction by up to that
> window. Use **รีเฟรช Snapshot** (BI screen) when you need an immediate recompute.

[screenshot: operational dashboard with KPIs, 14-day trend and refresh]

---

## 1a. Role-based dashboards

The home dashboard shows a **“ตัวชี้วัดตามบทบาท (Your role KPIs)”** strip at the top:
a set of KPI tiles chosen for *your* role — today's sales, low stock, open AR/AP,
open pipeline, and more. You only ever see tiles your permissions allow.

### Designing a role's dashboard (admins)

**Screen:** `/dashboard-designer` (**แดชบอร์ดตามบทบาท**) · **Required permission:**
`users` / `exec`.

1. Pick a **role** at the top.
2. From **วิดเจ็ตที่มีให้เลือก (available widgets)**, click **เพิ่ม (Add)** to put a
   KPI on that role's dashboard; reorder with ▲▼ and remove with ✕.
3. Click **บันทึก (Save)**.

**Expected result:** Everyone with that role sees the chosen KPIs on their home
dashboard — **filtered to what each person is allowed to see** (e.g. a stock-only
role never sees finance figures, even if the widget is in the role's layout). A
role with no saved layout falls back to a sensible default set.

> **Troubleshooting:** “BAD_ROLE” — the role isn't recognised; “BAD_WIDGET” — a
> widget key isn't in the catalog (pick from the available list).

---

## 2. Standard reports (Excel & PDF)

**Required permission:** varies by report (`dashboard` / `pos` / `exec` for sales;
`creditors` / `exec` for AP).

| Report | What it is | Output |
|--------|-----------|--------|
| **Daily sales** | Sales for a day, by product / method | Excel |
| **Stock summary** | On-hand stock, low-stock highlighted | Excel |
| **Monthly P&L** | Profit & loss for a month | Excel |
| **AP aging** | What you owe suppliers, by age | Excel |
| **Thai tax invoice / receipt** | Compliant PDF documents | PDF |
| **Order export** | A single order | PDF / text |

### To export a report

1. Open the relevant module's report area (e.g. Reports / Finance / POS).
2. Set any parameters (date, month, year).
3. Click **Export** and choose the format (Excel or PDF).

**Expected result:** The file downloads to your computer.

---

## 3. AI forecasting & replenishment

**Screen:** `/replenishment` (and `/planner`) · **Required permission:** `planner`
(also `dashboard` / `warehouse`).

The system suggests what to reorder based on demand, min/max levels and lead
times.

1. Go to **Replenishment** (`/replenishment`).
2. Review the suggested items, sorted by urgency (critical items flagged).
3. Where offered, **generate a purchase requisition** directly from a suggestion.

**Expected result:** A prioritised reorder list, and optionally a draft PR ready
for [procurement](./03-procurement.md).

[screenshot: replenishment suggestions with urgency flags]

---

## 3a. Demand forecasting (multi-model + backtesting)

**Screen:** `/demand` · **Where:** sidebar → **วางแผน & BI → พยากรณ์ความต้องการ
(Demand ML)** · **Required permission:** `planner` (also `exec` / `warehouse`).

For items with enough sales history, the system forecasts future demand using
several classic models (moving average, exponential smoothing, Holt trend,
seasonal-naive, and Croston for sporadic items) and **automatically picks the
most accurate one** by back-testing each on recent history.

1. **Compare models** — the **เทียบโมเดล** tab back-tests every model for an item.
   You get each model's accuracy scored by **WAPE** (lower is better) and
   **MASE** (below 1 beats a naive guess).
2. **Forecast** — the **พยากรณ์** tab forecasts a chosen horizon (days).
   The best model is selected automatically (or pin one), and you get a
   day-by-day forecast. Each run is saved for an accuracy audit trail.
3. **Track accuracy** — the **ประวัติ & ความแม่น** tab shows the average WAPE/MASE
   of recent forecasts, overall and per model.

**Expected result:** A demand forecast you can feed into replenishment and
planning. Forecasts are **advisory** — they never post to the ledger.

> Need at least **14 days** of sales history (otherwise `INSUFFICIENT_HISTORY`).
> A misspelled model name returns `UNKNOWN_ALGORITHM` — omit it to auto-select.

---

## 4. Insights (anomalies · replenishment · AI summary)

**Screen:** `/insights` · **Where:** sidebar → **วางแผน & BI → ข้อมูลเชิงลึก
(Insights)** · **Required permission:** `exec` / `dashboard` / `planner` /
`warehouse`.

One screen that surfaces the signals the analytics engine produces, in three tabs.

### 4.1 ภาพรวม (Overview)
At-a-glance counts (items to reorder, anomalies in the last 7 days) plus an
**AI-written summary** of what needs attention and the top-3 items to reorder.

### 4.2 ความผิดปกติ (Anomalies)
Unusual activity over a chosen window (7 / 30 / 90 days), in two lists:

- **Movement anomalies** — stock movements that deviate from their norm, scored by
  **Z-score** and flagged critical / warning.
- **Stocktake variances** — counts that differ materially from the system quantity.

Press **คำแนะนำ (AI)** on a movement row to get a short, plain-language
recommendation for that anomaly.

### 4.3 เติมสต๊อก (Replenishment)
Items predicted to run out, ranked by urgency, with current stock, average daily
sales, lead time, reorder point and predicted stock-out date. Click a row for the
per-item detail and an **AI replenishment recommendation**.

**Expected result:** A single place to see what is abnormal and what to reorder —
all advisory (nothing posts to the ledger or raises an order automatically).

---

## 5. Planning & budgeting

**Screen:** `/planning` · **Required permission:** `exec` (create); `approvals`
(approve).

- Create **budget versions** and scenarios.
- Submit a version for approval; an approver activates the baseline.
- View **3-way variance**: Budget vs Forecast vs Actual.

**Expected result:** You can plan, approve and track performance against budget.

### 5a. Budget vs Actual (per GL account)

**Screen:** `/budget` · **Where:** sidebar → **วางแผน & BI → งบประมาณเทียบจริง
(Budget vs Actual)** · **Required permission:** `exec` / `planner`.

A lighter, account-level budget that compares directly against the posted ledger
(no scenario/version workflow — use **Planning** above for that).

1. **ตั้งงบประมาณ** tab — enter a budget per **GL account** (and optional cost
   centre) for a fiscal year, as an **annual** figure (split evenly across 12
   months) or a single **monthly** amount.
2. **งบเทียบจริง** tab — choose a year (and optional period) to see each account's
   **budget vs actual**, the variance and a **Favorable / Unfavorable** flag, with
   revenue / expense / net roll-ups at the top. Actuals come only from **posted**
   journal lines.

**Expected result:** A management view of where actual performance is running
ahead of or behind budget, by account.

---

## 6. AI assistant (chat)

**Screen:** `/assistant` · **Required permission:** `ai_chat` (also `dashboard`).

Ask questions in plain language and get answers drawn from your live data.

1. Go to **Assistant** (`/assistant`).
2. Type a question, or pick a quick prompt such as *"Summarise today's sales"*
   (**สรุปยอดขายวันนี้**), *"Low-stock items"* (**สินค้าที่สต๊อกต่ำ**) or
   *"Finance KPIs"* (**KPI การเงิน**).
3. Read the reply; it streams in as it is generated.

**Expected result:** A conversational answer with figures from your inventory,
sales, finance and other modules.

> **Note:** The assistant answers from your own tenant's data only and respects
> your permissions.

[screenshot: AI assistant chat with quick prompts]

---

## 7. Scheduled reports (get reports delivered automatically)

**Screen:** `/scheduled-reports` (**รายงานตามกำหนดเวลา**) · **Required permission:**
`exec`.

Set a report to be built and delivered on a schedule, so the right people get it
without anyone running it by hand.

1. **Name the report** and pick a **type** — analytics summaries (*KPI board*,
   *Sales cube*, *Finance (P&L) trend*, *Pipeline trend*, *Portfolio EVM*,
   *CRM win/loss*, **Executive cross-module scorecard**, **Budget vs actual**,
   **Supplier performance scorecard**) or a scheduled **action job** (e.g. AR
   dunning, recurring journals). The *Executive scorecard* rolls finance, CRM,
   project-portfolio and supply-chain health into one board; *Budget vs actual*
   and *Supplier scorecard* deliver the existing variance/scorecard figures on a
   schedule.
2. **Choose a frequency** — daily, weekly or monthly — and optionally an **email
   recipient**.
3. Save. The report then runs on its schedule: each run posts an **in-app
   notification** to your company and emails any recipients, and is recorded in
   **ประวัติการส่ง (History)** with its status and the figures sent.
4. Use **ส่งที่ถึงกำหนดเดี๋ยวนี้** to run everything that's due right now, or the
   **▶ (Run now)** button on a single report to send it on demand.

**Expected result:** Your KPI, sales, finance and pipeline summaries arrive on
their own cadence — same figures as the on-screen views, delivered to inbox and
notification feed.

> **Troubleshooting:** “BAD_REPORT_TYPE” — the report type isn't one of the
> built-ins; “BAD_FREQUENCY” — the frequency must be daily, weekly or monthly.

---

## 8. Saved views (reuse your filters)

**Screen:** `/saved-views` (**มุมมองที่บันทึก**) · **Required permission:** any
list-screen permission (e.g. `dashboard`, `warehouse`, `masterdata`).

Save the way you've set up a list screen — its filters and sorting — so you can
return to it in one click.

1. Pick the **screen (module)** and give the view a **name**.
2. Tick **แชร์ให้ทั้งองค์กร (Share)** to make it available to everyone in your
   company, or leave it unticked to keep it **personal**.
3. Saved views are listed per screen; delete any you own with the 🗑 button.

**Expected result:** Personal and shared presets for your common list screens.
Views are private to your company; a shared view can only be deleted by whoever
created it.

---

## Food cost & menu margins

The **ต้นทุนอาหาร (Food cost)** screen shows, for each menu item, its **cost**
(from the item's recipe, or the item's cost field if it has no recipe), the
**margin** and **margin %**, and the **food-cost %** against your target — so you
can spot low-margin dishes (menu engineering). A second tab lists **ingredient
cost-contribution** (which ingredients drive cost across your recipes). Numbers
are *theoretical* (recipe-based).

A third tab, **ส่วนต่าง (จริง vs ทฤษฎี) — variance**, closes the loop against
reality: pick a date range and it values your **EOD stock-count** variances
(actual vs theoretical usage) at each ingredient's cost. You see the **theoretical
cost**, the **net variance** (฿ and % of theoretical), how much is **unfavourable**
(used more than the recipe predicted — waste, over-portioning, shrinkage) vs
**favourable**, and the ingredients flagged as anomalies (≥ 5% Medium, ≥ 10%
High). This turns the inventory cycle-count variance into a money figure a manager
can act on. *(The underlying counts come from the inventory EOD count.)*

---

## Restaurant management analytics

Open **วิเคราะห์ร้านอาหาร (Restaurant analytics)** in the POS menu (`/restaurant-analytics`)
for all of these on one screen — pick a date range at the top and switch tabs (Menu
engineering · ช่วงเวลาขายดี · ยกเลิก/ส่วนลด · พนักงาน · แนวโน้ม · ความพร้อมเมนู). The same
data is available on the API for your own tools.

The manager reports turn the sales you've already rung into decisions. All take an
optional date window (`?from=YYYY-MM-DD&to=YYYY-MM-DD`, default = today).

### Menu engineering (`GET /api/analytics/menu-engineering`)

The classic **menu-engineering matrix** — better than a plain "best sellers" list
because it weighs **how often** a dish sells against **how much margin** it earns.
Each costed item is placed in one of four quadrants and given an action:

| Quadrant | Meaning | What to do |
|---|---|---|
| ⭐ **Star** (ดาวเด่น) | Popular **and** high-margin | Keep & feature; protect quality/price |
| 🐴 **Plowhorse** (ม้างาน) | Popular but low-margin | Raise price modestly or cut recipe cost |
| ❓ **Puzzle** (ปริศนา) | High-margin but slow | Reposition / rename / promote |
| 🐶 **Dog** (สุนัข) | Slow **and** low-margin | Consider removing or reworking |

Popularity uses the **70% rule** (a dish is "popular" when its share of units sold is
≥ 70% of an equal share); profitability compares each dish's unit contribution margin
to the menu average. Items with no recipe/cost are listed separately as *uncosted*.

### Daypart & busiest hours (`GET /api/analytics/daypart`)

Revenue, transaction count and average ticket **by hour of day** and by **daypart**
(breakfast / lunch / afternoon / dinner / late), with the **peak hour and daypart**
highlighted — for staff scheduling and promo timing. All times are on the **business
clock (Asia/Bangkok)**, so a 1 a.m. sale counts as *late* on the correct day.

### Voids & discounts — loss prevention (`GET /api/analytics/voids-discounts`)

A shrinkage view over the manager-override audit: total voids/discounts, the **void
rate** vs sales, and a breakdown **by reason code, by action, and by staff member** —
so unusual void/discount patterns surface quickly.

### Staff performance (`GET /api/analytics/staff-performance`)

Per **cashier**: number of sales, revenue, average ticket, and their **void /
discount activity** over the window — ranked by revenue. A quick read on who is
selling, and a loss-prevention cross-check (high voids on one cashier).

### Sales trend (`GET /api/analytics/sales-trend`)

This window vs the **immediately-preceding equal-length window** — revenue and
transaction **deltas** (฿ and %) plus the change in average ticket. Pick any range
(a day, a week) and instantly see "up or down vs last period".

---

## Menu availability forecast (kitchen)

The **availability forecast** (`GET /api/menu/availability/forecast?low=5`) answers
"how many more can we make?" For every dish with a recipe it computes the
**servings remaining** from current ingredient stock and names the **limiting
ingredient** (the one that runs out first), classing each dish **out** (0 — should
be 86'd), **low** (≤ your threshold) or **ok**. It also lists **low-stock
ingredients** (at or below their reorder point). This is the *proactive* layer over
auto-86: you see "only 4 Pad Thai left — prawns are short" **before** the dish sells
out, instead of discovering it at the kitchen pass.

---

## Production plan (predictive prep + auto-replenishment)

**แผนการผลิต (Production plan)** in the POS menu (`/production-plan`) plans your day
from your own sales. Pick how many days ahead to plan and how far back to learn from,
and it gives you two lists:

- **Prep list** — for each dish it works out the **average sold per day** (over your
  lookback window) and forecasts demand for the period, so the kitchen knows **how
  many to pre-make**. A dish whose ingredients can't even cover the forecast is
  flagged.
- **Buy list** — it explodes those forecasts through your recipes into a total
  ingredient requirement, compares it to current stock and your reorder points, and
  suggests **how much of each ingredient to order** (rounded up to your reorder pack
  size). Ingredients you have enough of don't appear.

The forecast uses a **self-tuning demand model** — for each dish it backtests several
classic methods (moving average, smoothing, trend, weekly-seasonal, intermittent) on
that dish's own sales history and **automatically picks the most accurate one**, so
trend and weekly seasonality (weekends ≠ weekdays) are both captured. Each row shows
the chosen model and its accuracy; a brand-new dish with little history falls back to
a simple day-of-week average until it has enough data to model.

It's advice, not an automatic order — but when the buy list has items you can press
**สร้างใบสั่งซื้อ (ร่าง)** to raise a **draft purchase order** in procurement in one
click (it goes in as *pending approval*, never auto-approved).

**Just ask.** All of these reports are also wired into the **AI assistant** — at the
till you can ask in plain Thai, e.g. *"วันนี้ควรเตรียมอะไรบ้าง?"*, *"เมนูไหนกำไรตก?"*,
*"ช่วงไหนขายดีสุด?"* — and it answers from your live data (and, for purchases, only
*proposes* an order for someone to approve).

---

**Next:** [Approvals](./10-approvals.md) · [Administration](./11-administration.md)
