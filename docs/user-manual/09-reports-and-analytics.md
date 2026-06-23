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

**Next:** [Approvals](./10-approvals.md) · [Administration](./11-administration.md)
