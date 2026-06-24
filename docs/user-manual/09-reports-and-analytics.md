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

**Expected result:** A live summary of business performance.

[screenshot: executive dashboard]

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

**API:** `/api/demand` · **Required permission:** `planner` (also `exec` / `warehouse`).

For items with enough sales history, the system forecasts future demand using
several classic models (moving average, exponential smoothing, Holt trend,
seasonal-naive, and Croston for sporadic items) and **automatically picks the
most accurate one** by back-testing each on recent history.

1. **Compare models** — `POST /api/demand/backtest` with `{ "item_id": "…" }`.
   You get each model's accuracy scored by **WAPE** (lower is better) and
   **MASE** (below 1 beats a naive guess).
2. **Forecast** — `POST /api/demand/forecast` with `{ "item_id": "…", "horizon": 14 }`.
   The best model is selected automatically (or pin one with `"algorithm"`), and
   you get a day-by-day forecast. Each run is saved for an accuracy audit trail.
3. **Track accuracy** — `GET /api/demand/accuracy` shows the average WAPE/MASE of
   recent forecasts, overall and per model.

**Expected result:** A demand forecast you can feed into replenishment and
planning. Forecasts are **advisory** — they never post to the ledger.

> Need at least **14 days** of sales history (otherwise `INSUFFICIENT_HISTORY`).
> A misspelled model name returns `UNKNOWN_ALGORITHM` — omit it to auto-select.

---

## 4. Anomaly detection

**Required permission:** `planner` / `dashboard`.

The analytics engine highlights unusual activity (e.g. sudden cost spikes,
unexpected stock movements) over the recent period.

1. Open the **Anomalies** view (analytics / dashboard area).
2. Review flagged items and investigate.

**Expected result:** A list of unusual events worth a closer look.

---

## 5. Planning & budgeting

**Screen:** `/planning` · **Required permission:** `exec` (create); `approvals`
(approve).

- Create **budget versions** and scenarios.
- Submit a version for approval; an approver activates the baseline.
- View **3-way variance**: Budget vs Forecast vs Actual.

**Expected result:** You can plan, approve and track performance against budget.

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

1. **Name the report** and pick a **type** — *KPI board*, *Sales cube*, *Finance
   (P&L) trend*, or *Pipeline trend*.
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

> **Troubleshooting:** “BAD_REPORT_TYPE” — the report type isn't one of the four
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

**Next:** [Approvals](./10-approvals.md) · [Administration](./11-administration.md)
