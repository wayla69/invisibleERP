# 09 · Reports & Analytics

**Status: DRAFT v0.6** _(2026-07-13: audience export can now push DIRECTLY to Meta Custom Audiences / Google Customer Match — set the env creds (see .env.example); each platform gets its own register row; 2026-07-12: audience export — `audience_export_sync` pushes SHA-256-hashed, consent-filtered audiences (fail-closed without the DPO's ROPA entry; preview at CRM audience-export); 2026-07-12: menu affinity — คู่เมนูขายด้วยกัน tab (co-purchase support/confidence/lift, per daypart) + schedulable `menu_affinity` report; 2026-07-10: menu engineering — branch picker + quantity-weighted average-margin threshold + on-screen thresholds; 2026-07-09: added the company-level AI opt-out (PDPA) note in the AI-assistant section)_

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

## 1b. CFO Command Center (financial KPIs & ratios)

**Screen:** `/finance/command-center` (**ศูนย์บัญชาการ CFO**, Finance → Financial
reports) · **API:** `GET /api/finance/metrics/pack` · **Required permission:**
`exec` / `fin_report` / `dashboard` (also `ar` / `creditors`).

The **CFO Command Center** shows your finance KPIs as a **red/amber/green
scorecard** grouped by family. A summary strip counts how many KPIs need action /
are on watch / are healthy, with a **Live** badge that turns the board real-time
(it re-pulls whenever the ops dashboard refreshes). Each tile shows the value, its
RAG chip, and the change **vs prior period / prior year / budget**; click **12-month
trend** to expand a sparkline, or **View detail →** to drill to the statements.

The finance KPI engine turns your ledger into a **CFO scorecard** — one call
returns ~31 financial KPIs, each with **RAG** (🟢 green / 🟡 amber / 🔴 red) and
**comparatives**, computed straight from the posted GL and sub-ledgers:

- **สภาพคล่อง (Liquidity):** current / quick / cash ratio, working capital,
  days-cash-on-hand, cash-conversion-cycle.
- **ประสิทธิภาพเงินทุนหมุนเวียน (Efficiency):** DSO, DPO, DIO, AR/AP/inventory turnover.
- **ความสามารถทำกำไร (Profitability):** gross / operating / net margin, EBITDA + margin, ROA, ROE.
- **โครงสร้างหนี้สิน (Leverage):** debt-to-equity, interest coverage, net debt.
- **การเติบโตและกระแสเงินสด (Growth & cash):** revenue growth MoM/YoY, operating & free cash flow, cash runway.
- **สุขภาพลูกหนี้/เจ้าหนี้ (AR/AP health):** overdue-AR/AP %, AR-over-90-days, allowance coverage.

Each KPI carries its **prior-period, prior-year and budget** comparative and a
RAG rating against a defined threshold. Margins reflect the period you pick; the
**efficiency KPIs (turnover, DSO/DPO/DIO, ROA, ROE, days-cash, runway) are always
on a trailing-12-month basis**, so they read the same whether you open the board on
the 1st or the 28th. Two companion endpoints let you *explain* a number, not just
read it:

- `GET /api/finance/metrics/{id}/drill` — the GL account rows behind a KPI (e.g.
  why the current ratio moved). Drill through a 🔴 KPI straight to the ledger.
- `GET /api/finance/metrics/{id}/trend?periods=12` — the KPI's month-by-month
  trend (for a sparkline / line chart).

**Optional filters on the pack:** `period=YYYY-MM` (a specific month), `from`/`to`
(a custom window), `group=<family>` (one KPI family), `as_of=YYYY-MM-DD`.

The Command Center also shows a **“What changed”** panel — a plain-language
summary (an MD&A-style narrative) of the headline movement plus the KPIs that need
action or moved the most, generated automatically from the numbers.

You can have the scorecard, the cash position and the close cockpit **emailed /
LINE-delivered on a schedule** — on `/scheduled-reports` (§7) add a subscription of
type **CFO KPI pack**, **Cash position + 13-week forecast** or **Period-close
readiness**, pick daily / weekly / monthly, and the delivered summary carries the
headline figures (the CFO pack includes the “what changed” line).

> **This is the analytical-review control (ELC-07):** the same KPI definitions
> also feed the executive scorecard and the scheduled KPI pack, so the number you
> review is the number everywhere. Read-only — it never posts to the ledger.
>
> **Troubleshooting:** “UNKNOWN_METRIC” — the metric id isn't recognised; use an
> id returned by `…/metrics/pack`.

---

## 1c. Close Cockpit (period-close readiness)

**Screen:** `/finance/close-cockpit` (**ศูนย์ปิดงวดบัญชี**, Finance → Financial
reports) · **API:** `GET /api/finance/metrics/close/status` · **Required
permission:** `exec` / `fin_report` / `gl_close` (also `dashboard`).

The **Close Cockpit** answers one question — *is this period ready to lock?* — on a
single red/amber/green board, so the controller doesn't have to check four screens.
A banner shows the **overall status** and **days-to-close**; below it, four pillars,
each with its own RAG:

- **Sub-ledger tie-out** — AR / AP / inventory / gift-cards / deferred-revenue vs
  their GL control accounts, with the variance on any that don't match (REC-04).
- **Pre-lock readiness** — no unposted drafts, entries balance, the period-balance
  snapshot reconciles to the raw ledger (GL-19 / GL-20).
- **Pending approvals** — everything still awaiting a maker-checker sign-off, with
  ageing and an overdue count (GOV-01).
- **Close checklist** — the required close steps and what's done (appears once a
  close run is started).

The **overall status turns red** if any control account is out of balance or a hard
readiness check fails — the controller's cue not to lock yet. Read-only; it posts
nothing and drives no lock (the lock stays on the period-close screen).

---

## 1d. Treasury / Cash Command (cash position & forecast)

**Screen:** `/finance/treasury` (**ศูนย์บริหารเงินสด**, Finance → Financial
reports) · **API:** `GET /api/finance/metrics/cash/position` · **Required
permission:** `exec` / `fin_report` / `ar` (also `dashboard`).

**Treasury / Cash Command** is the forward view of cash on one screen:

- **Headline** — total cash now, the **projected closing** balance, and the
  **liquidity trough** (the lowest point cash reaches over the next 13 weeks, and
  which week that is).
- **13-week cash forecast** — a curve of the projected cash balance, built from
  open receivables (inflows) and payables (outflows) by due date; the trough week
  is marked, and a table breaks out inflow / outflow / projected balance per week.
- **Cash & bank accounts** — the GL cash/bank balances (which tie to the trial
  balance) plus your configured bank accounts.
- **Liquidity** — the current / quick / cash ratios, working capital and days-cash
  (the same figures as the CFO scorecard).
- **FX exposure** — open receivables/payables in each non-THB currency, with the
  net position to watch.

Read-only; it posts nothing. It complements the working-capital **score**
(*Financial Health*) and the raw GL **forecast** by bringing the bank position,
the trough and FX into one treasury review.

---

## 1e. Segment Profitability (P&L by dimension)

**Screen:** `/finance/profitability` (**กำไร-ขาดทุนตามมิติ**, Finance → Financial
reports) · **API:** `GET /api/finance/metrics/profitability` · **Required
permission:** `exec` / `fin_report` / `dashboard`.

**Segment Profitability** breaks the P&L down by an accounting **dimension** — pick
**by branch / cost centre / project** with the switcher at the top. For each
segment you see revenue → COGS → gross profit → opex → **net**, its **net margin**
and its **contribution %** of total net; a net-contribution bar chart ranks the
segments, and a matrix shows the full breakdown with a total row.

A **✓ badge** confirms the segment totals **tie to the consolidated P&L** (nothing
falls through the cracks — postings with no dimension roll up to an *Unassigned*
segment). It's built straight from the multi-dimensional GL, so it's always
consistent with the statements; read-only, it posts nothing.

> *Customer- and product-level profitability draw on the sub-ledgers rather than a
> GL dimension and are a planned follow-up.*

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
(สถิติ + backtest)** · **Required permission:** `planner` (also `exec` / `warehouse`).

> ℹ️ **Honest labeling:** these are **classical statistical models** (moving average, exponential
> smoothing, Holt, seasonal-naive, Croston) chosen deliberately for auditability — measured by
> walk-forward backtesting, not machine learning. Anything described as *AI* in this product refers to
> the LLM copilot features, which are advisory and never post transactions.

For items with enough sales history, the system forecasts future demand using
several classic models (moving average, exponential smoothing, Holt trend,
seasonal-naive, Croston and Croston-SBA for sporadic items, a
**day-of-week seasonal** model for weekly patterns like weekend-heavy
restaurant demand, and a **Thai-calendar holiday** model that learns each
item's uplift on fixed public holidays — ปีใหม่, สงกรานต์, วันแม่/วันพ่อ — and
applies it to future dates that land on one) and **automatically picks the
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
3. **ควบคุมงบ (Budget control)** tab — control **BUD-02** — make the budget
   *enforced* on purchasing rather than report-only:
   - **Policy** (`off` — default, report-only · `advise` — approve + annotate ·
     `warn` — the approver must confirm an overage · `block` — an over-budget
     PR/PO approval is rejected unless an **exec** overrides it with a reason).
     Changing the policy requires `exec` / `gl_close` (change control).
   - **Default budget account** — used for a line whose item resolves no
     `cogs_account` of its own (item → item category → this default).
   - **ตรวจงบคงเหลือ** — check an account/period's availability:
     **budget (YTD) − actuals (YTD) − open commitments = available**.
   - **ภาระผูกพันงบประมาณ** — the encumbrance audit list: every approved PR/PO's
     commitment with its status (`open` / `consumed` / `released`) and, for an
     over-budget approval, **who overrode it and why**.
   Only accounts **with an approved budget** for the year are enforced; project
   (BoQ) purchases and capital lines are governed by their own controls
   (PROJ-12/13, FA-10) and are excluded here.

**Expected result:** A management view of where actual performance is running
ahead of or behind budget, by account — and, when the policy is on, over-budget
purchases are flagged, confirmed or blocked at the point of approval.

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

> **LINE copilot governance (LP-2):** the chat copilot (`บอท …` in the shop's LINE OA)
> uses a cost-routed model dedicated to chat drafting (`chat_copilot`), validates every
> AI answer against a strict schema (a malformed answer becomes an honest "ยังไม่เข้าใจ"),
> and is capped per shop per day (`LINE_COPILOT_DAILY_CAP`, default 200 calls — excess
> falls back to the deterministic rules). In production the model is never called until
> the Data Processing Addendum is acknowledged (`AI_DPA_ACKNOWLEDGED`); without a key the
> copilot still works on its built-in Thai rules. Drafts execute only after your confirm tap.

> **Company-level AI opt-out (PDPA):** an administrator can turn off **"AI ภายนอก: อนุญาตส่งข้อมูล
> ให้ผู้ให้บริการ AI"** at **Settings › Labs & AI** (`/settings/labs`, requires `md_config`/`exec`).
> While it is off, no AI feature sends this company's data to the external AI provider: the AI
> assistant answers `AI_TENANT_OPTED_OUT`, and NL analytics / document reading / insights / the LINE
> copilot silently use their built-in (non-AI) processing instead. The switch text on that page is
> the PDPA disclosure of what is shared when it is on. Turning it back on restores AI immediately.

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
   **Supplier performance scorecard**, **Project governance / status pack**) or a
   scheduled **action job** (e.g. AR dunning, recurring journals, **project health
   snapshots**). The *Executive scorecard* rolls finance, CRM, project-portfolio and
   supply-chain health into one board; *Budget vs actual* and *Supplier scorecard*
   deliver the existing variance/scorecard figures on a schedule; the *Project
   governance / status pack* delivers the RAG-ranked portfolio status roll-up (red
   projects, unmitigated-high risks, overdue milestones, pending change orders).
   **Audience export (hashed, consent-gated)** pushes your marketing audience to an ads platform /
   CDP — but only members with a live marketing consent, only as SHA-256 hashes (never raw phone/email),
   and only after the DPO records the `audience_export` processing activity (otherwise the run blocks
   with `ROPA_MISSING`). Every run lands in the export register (`GET /api/crm/audience-export/register`).
   Destinations: a generic webhook/CDP (`AUDIENCE_EXPORT_URL`) and/or **direct Meta Custom Audiences +
   Google Customer Match** (set the `META_*` / `GOOGLE_ADS_*` creds; each configured platform gets its own
   register row). Nothing configured = a safe mock run.
   **Marketing ROI (spend → lift → margin)** is the one-board marketing view: coupon
   discount actually given (the true marketing spend — never dressed up as revenue),
   the redeemed bills' real revenue and recipe-costed margin, organic holdout lift,
   voucher-code redemptions, and the B2B source-ROI leg — with an honest note on what
   each number is. Optional filters: `days` (window, default 90), `months` (B2B),
   `fiscal_year`/`cost_center` (adds the budget-vs-actual leg).
   For **fixed assets**, two report types surface the physical-custody controls:
   *Asset audit results* (recent counts with found/missing/misplaced/unknown plus the
   pending custody-change queue) and **Assets not verified in N days** — a monthly
   **existence exception** listing every active asset that hasn't been scan-verified
   within N days (default 90), oldest first, so stale/never-confirmed assets are
   surfaced for a physical count before period-end.
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
≥ 70% of an equal share, i.e. mix % ≥ 0.7 × 1/N); profitability compares each dish's
unit contribution margin (average price − recipe COGS) to the **quantity-weighted
average margin** of the menu (total contribution ÷ total units sold — the classic
Kasavana–Smith bar, so one slow premium dish can't skew it). The screen shows the
exact thresholds used above the table, and the API returns them (`thresholds`).
Items with no recipe/cost are listed separately as *uncosted* — they appear in the
list but are never classified.

**Per-branch view:** if your company runs several outlets (and you hold the `branch`
or `exec` duty), a **สาขา (Branch)** picker appears on the Menu engineering tab —
pick an outlet to re-derive the whole matrix from that branch's sales only
(`?branch_id=` on the API). "ทุกสาขา" (all branches) is the default.

### Menu affinity / co-purchase (คู่เมนูขายด้วยกัน)

Which dishes sell **together** on the same bill. Each pair shows how many bills carried both
(**count**), the share of all bills (**support**), how often buying one side means the other is on the
bill too (**confidence**, shown A→B / B→A), and **lift** — the load-bearing number: lift > 1 means the
pair co-occurs *more than chance*, so it's a genuine set-menu / cross-sell candidate rather than two
independently popular dishes. Sliced per daypart (breakfast … late) on the business clock so a lunch
pairing isn't diluted by dinner traffic; bills without a captured payment time count in the overall
view only. Rare pairs are hidden below a minimum count (default 2). Also schedulable as the
**Menu affinity** report type (default: trailing 30 days).

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

---

## Get reports and alerts on LINE (LC-4)

If you've linked your LINE account (see [Procurement — LINE chat](./03-procurement.md)):

- **Daily digest** — type `subscribe digest` in the shop's LINE OA chat to get a morning
  summary card. Requires `dashboard`, `fin_report`, or `exec` — the same rule as viewing
  those numbers on screen. `unsubscribe digest` stops it.
  - **Pick your KPIs (LP-3):** `subscribe digest sales_yesterday,cash_position` chooses what
    your card shows; bare `subscribe digest` keeps the default trio (pending approvals ·
    open PRs · alerts 24 h). `digest kpis` lists the keys **you** are allowed to pick —
    financial KPIs (yesterday's sales, cash position, overdue AR, low-stock count) each
    require their own permission, and the filter re-applies **every morning at send time**:
    lose the permission and that KPI silently disappears from your card (nobody else's
    card changes). A KPI with no data shows `—`, never a made-up zero.
- **Scheduled reports** — an admin can add you as a report-subscription recipient with
  `{line_user: "<username>"}`; you'll receive the run's summary in LINE with a pointer to
  the full report on `/bi` (the raw data never goes to chat).
- **Alerts** — an alert rule can target `user:<username>` instead of a hand-typed LINE id;
  the notification follows your linked account, and an admin force-unlink silences it
  immediately.
- **Ask in chat** — `ask ยอดขายตามสาขา` answers from the same governed query engine as
  `/query` (same permissions, top-5 summary only). The bot never invents numbers: no data
  → "ไม่มีข้อมูล".
