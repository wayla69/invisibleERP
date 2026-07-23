# 09 · Reports & Analytics

**Status: DRAFT v0.17** _(2026-07-23: **Autopilot + action center (docs/62 Phase 1)** — §5g: three schedulable marketing jobs (auto-stage NBA / auto-stage save sweep / measure elapsed windows — machine prepares with an `(auto)` marker, humans keep activation/approval; one-in-flight idempotency) and the สิ่งที่รอคุณตอนนี้ action-center card on the overview + the marketing queues in the pending-approvals monitor. UAT-MA-AUTO-01/02.)_ _(2026-07-23: **Realized measurement (docs/61 loop close)** — §5g ② and ④ gain a **วัดผล** step: after the window, journeys pin a realized treatment-vs-control lift chip and save runs replace the expected P&L with a **พิสูจน์แล้ว** realized net benefit, both on real POS revenue; the proven lift feeds the ROI กลุ่ม × ช่องทาง ranking. UAT-MA-22b/24b.)_ _(2026-07-23: **Studio v2 (MKT-21 unchanged)** — §5g ①: the draft now carries an **เขียนโดย AI / แม่แบบมาตรฐาน** badge (a live AI model refines the copy when the company has not opted out of external AI processing; the deterministic template is the automatic fail-closed fallback), the fact sheet now includes the segment's top un-bought product as the concrete offer, and targeting always stays fact-driven with the producing model recorded on the model card. UAT-MA-21b.)_ _(2026-07-23: **docs/61 web** — new §5g **Marketing Activation workspace** (`/marketing-activation`): one Marketing-Studio home for the five activation tools — ③ cross-sell lookup, ⑤ segment×channel budget ranking (staged via the MKT-17 maker-checker plan), ② NBA journeys (maker-checker activation, suppression reasons shown), ① AI campaign drafts with the model-card evidence, ④ churn-save policy/preview/runs with the capped-offer chips and retention P&L. Amounts show as "THB" (no ฿ sign). UAT-UI-MA-01.)_ _(2026-07-22: **docs/60 Phase 4** — §5f **Model governance** (MKT-20): opt-in two-person approval before pushed analytics drive spend/contact, model cards, drift flag into the pending-approvals center, and a recommendation → action → outcome audit trail. UAT-RPT-063.)_ _(2026-07-22: **docs/60 Phase 3** — §5e **Incrementality** (MKT-19): A/B holdout test on a pushed segment (treatment contacted, control never contacted, fixed at start), then measure real lift + incremental revenue once the window elapses; outcomes flow back to the platform. UAT-RPT-062.)_ _(2026-07-22: **Marketing Intelligence depth (docs/60)** — §5c **Budget Planner** (Phase 1, MKT-17): optimise a budget across channels from the MMM response curves, live what-if sliders, stage → maker-checker approve; and §5d **Customer Intelligence** (Phase 2, MKT-18): per-customer CLV / churn / next-best-action drill-down per segment, sortable, one-click consent-gated campaign draft. UAT-RPT-060, UAT-RPT-061.)_ _(2026-07-16: **Close Cockpit gains the JE-exceptions pillar (GL-28, docs/50 Wave 5 B5)** — §1c: the rule-based JE anomaly sweep (duplicates, round manual amounts, backdated, after-hours, cash↔revenue pairs) surfaces as a fifth pillar with inline สแกนใหม่ + dismiss-with-reason (audit-logged); red while any HIGH exception is open; schedulable as ตรวจจับรายการบัญชีผิดปกติ. UAT-GL-202..204.)_ _(v0.9, 2026-07-16: new **Analytics Home** — a single hub at `/analytics` (sidebar →
**วางแผน & BI → ศูนย์วิเคราะห์**) that gathers every analytics surface (Insights, BI, Analytics Studio, NL
Analytics, dashboards, saved views, scheduled reports, planning) into one launcher grouped by task; the
individual sidebar links are unchanged, this just adds one front door — see §0; 2026-07-13: new §7 reputation & analytics sync — `reputation_review_sync`/
`reputation_ga4_sync` scheduled jobs + the dedicated `/reputation` screen, docs/47, control MKT-14;
2026-07-13: audience export gets a dedicated screen `/crm/audience-export` — preview + register + ROPA-status banner; demand-forecast manual-select model list corrected to match the real 9 backend algorithms (was stale, missing weather/th_holiday/dow_seasonal/etc.); 2026-07-13: audience export now also REMOVES members who withdraw marketing consent from the external audiences (Meta/Google/webhook) on every run — see the register’s rows_removed; 2026-07-13: audience export can now push DIRECTLY to Meta Custom Audiences / Google Customer Match — set the env creds (see .env.example); each platform gets its own register row; 2026-07-12: audience export — `audience_export_sync` pushes SHA-256-hashed, consent-filtered audiences (fail-closed without the DPO's ROPA entry; preview at CRM audience-export); 2026-07-12: menu affinity — คู่เมนูขายด้วยกัน tab (co-purchase support/confidence/lift, per daypart) + schedulable `menu_affinity` report; 2026-07-10: menu engineering — branch picker + quantity-weighted average-margin threshold + on-screen thresholds; 2026-07-09: added the company-level AI opt-out (PDPA) note in the AI-assistant section)_

This chapter is for **managers, planners and executives** — and anyone who needs
reports. It covers dashboards, Excel / PDF reports, AI-driven forecasting and
replenishment, anomaly detection, and the AI assistant.

---

## 0. Analytics Home — one door to everything

**Screen:** `/analytics` · **Where:** sidebar → **วางแผน & BI → ศูนย์วิเคราะห์ (Analytics Home)** ·
**Permission:** any of `exec`, `dashboard`, `planner`, `warehouse`, `marketing`

Instead of hunting through the sidebar for the right analytics tool, open **ศูนย์วิเคราะห์** — a single hub
that lays out every analytics surface as labelled tiles, grouped by what you want to do:

| Group | Tiles |
|-------|-------|
| **สำรวจ & ถามข้อมูล** (Explore & ask) | Insights · BI Analytics · Analytics Studio · NL Analytics |
| **ติดตาม & แดชบอร์ด** (Monitor & dashboards) | Dashboard · Role Dashboards · Saved Views |
| **ส่งออก & กำหนดเวลา** (Deliver & schedule) | Scheduled Reports |
| **วางแผน & พยากรณ์** (Plan & forecast) | Planning · Budget · Demand · Profitability · MMM |

Click any tile to jump straight to that screen. The hub is only a launcher — it shows the full map of what
exists, and each destination still enforces its own permissions (a tile you open without access shows that
screen's normal access message). The original sidebar links remain, so existing bookmarks keep working.

**Expected result:** A single, task-grouped landing page for all reporting and analytics.

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
- **JE exceptions (รายการบัญชีผิดปกติ, GL-28)** — the detective sweep over the posted
  journal: duplicate entries, suspiciously round manual amounts, backdated dates,
  after-hours posting (06:00–22:00 Asia/Bangkok is normal), and manual cash↔revenue
  pairs. **สแกนใหม่** re-runs the sweep (idempotent — reviewed items never re-appear);
  each open exception is cleared with **ยกเลิก**, which *requires a reason* and writes
  it to the GL audit log. The pillar turns **red while any HIGH exception is open**
  (duplicates, cash↔revenue pairs), amber for any other open item. The same sweep can
  be scheduled under Reports → Scheduled reports (**ตรวจจับรายการบัญชีผิดปกติ**).
- **Close checklist** — the required close steps and what's done (appears once a
  close run is started).

The **overall status turns red** if any control account is out of balance, a hard
readiness check fails, or a HIGH JE exception is open — the controller's cue not to
lock yet. Read-only; it posts nothing and drives no lock (the lock stays on the
period-close screen). Dismissing a JE exception changes only the exception register
(with the audit-logged reason) — never the journal itself.

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
restaurant demand, a **Thai-calendar holiday** model that learns each
item's uplift on fixed public holidays — ปีใหม่, สงกรานต์, วันแม่/วันพ่อ — and
applies it to future dates that land on one, and an optional **weather**
model that learns each item's rain-day dip/uplift and applies it to days a
forecast calls for rain) and **automatically picks the most accurate one**
by back-testing each on recent history.

> ☔ **Weather model (opt-in):** off by default. An operator turns it on with
> `DEMAND_WEATHER_ENABLED=true` — no API key or signup needed (the free
> Open-Meteo service, geocoded from your company's **province**). Left off,
> the weather model quietly sits out of auto-selection (it behaves exactly
> like the day-of-week model) and nothing changes.

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

## 5b. Marketing Mix Modeling — MMM (`/mmm`)

**Where:** sidebar **วางแผน & BI → Marketing Mix (MMM)**. **Who:** `marketing` or `exec`.

MMM estimates how much each marketing channel (Facebook, Google, TikTok, a promotion…)
contributes to sales, then suggests how to split a budget for the best return. It reads
signals you bring into the system — it never guesses from your live sales tables directly.

The workspace has four tabs:

1. **นำเข้าข้อมูล (Ingest)** — if you don't have an automatic integration feeding the model,
   enter data by hand here: **Channel sales** (date · channel · revenue · units) and **Social
   sentiment** (date · platform · mention count · sentiment score −1…1). Add a row per line and
   press **นำเข้า (Ingest)** — the rows land in the Signals tab immediately and are re-ingestable
   (re-entering the same day/channel updates rather than duplicates). Skip this tab entirely if an
   integration already loads your signals.
2. **สัญญาณ (Signals)** — the marketing signals ingested for the last 30 days: revenue and units
   per channel, and social mention volume + average sentiment per platform. Read-only view of
   whatever the Ingest tab or your integration has loaded.
3. **รันโมเดล (Model)** — choose a **window (days)** and enter the **spend per channel**
   (add a row per channel), then press **รันโมเดล (Run model)**. Every run is recorded with a
   run number (`MMM-YYYYMMDD-NNN`), who ran it, and the exact inputs — so any budget
   recommendation can be reviewed and reproduced later. Prior runs are listed below the form;
   **click any run** to open its full per-channel results (ROI / lift / recommended budget).
4. **คำแนะนำ (Recommendation)** — the latest run's result: each channel's **ROI**, its
   **share of the modelled lift**, and the **recommended budget** (the same total, re-split
   toward the higher-ROI channels). A channel with no spend shows ROI **—** (undefined, never
   a fake "infinite" number), and the recommended split always adds back to exactly your total.

**Good to know:** MMM is analysis only — it posts nothing to the general ledger. Each company
sees only its own signals and runs. The v1 model is a transparent lift-share heuristic (a
statistical regression can replace it later without changing this screen).

## 5c. Budget Planner — Marketing Intelligence (`/marketing-intel`)

**Where:** sidebar **วางแผน & BI → Marketing Intelligence → Budget Planner**. **Who:** `marketing`
or `exec` to plan; `exec` / `approvals` to approve a plan.

Once an MMM run has been pushed in, the Budget Planner answers the forward question — *"if I have
฿X to spend, how should I split it across channels for the most sales?"*

**To find the best split for a budget:**

1. Open **Budget Planner**. Each channel shows its **response curve** (spend → extra sales): the
   curve flattens as a channel saturates, so the first baht returns more than the last.
2. Enter a **total budget** and press **หาสัดส่วนที่ดีที่สุด (Optimise)** — the planner fills the
   allocation that maximises predicted sales (it keeps feeding each next baht to whichever channel
   is still returning the most).
3. Or drag the **per-channel sliders** yourself; the **predicted sales** figure updates live as you
   move them (a "what-if"). Optimise and the sliders use the same math, so a re-check always gives
   the same number.

> If the platform hasn't pushed precise response curves yet, the planner derives a serviceable
> curve from each channel's current spend and ROI (shown as *ประมาณการ / derived*) so you can still
> plan; the numbers sharpen once real curves arrive.

**To turn a plan into an approved budget (two people):**

4. Press **เสนอแผนงบ (Stage plan)** — this records the allocation as a **draft plan** (status
   *Pending*). **It does not spend or move any money** — it is a proposal.
5. A **different** person (with `exec` / `approvals`) opens the plan and presses **อนุมัติ (Approve)**.
   You **cannot approve your own plan** — the system refuses it (*ต้องให้คนอื่นอนุมัติ*), so a budget
   shift always has a second pair of eyes.

**Good to know:** the Budget Planner never posts to the general ledger — a plan is advice until a
person acts on it in your normal budgeting/PR process. Each company sees only its own plans.

---

## 5d. Customer Intelligence — drill-down (`/marketing-intel`)

**Where:** sidebar **วางแผน & BI → Marketing Intelligence → Customer Intelligence**. **Who:**
`marketing` or `exec` (read-only).

Once the platform has pushed the advanced RFM, each segment can be opened to see **who** is in it and
**what to do** with each customer. For every member the platform estimates a **12-month value (CLV)**,
a **churn risk** (how likely they are to stop buying), and a **next-best-action** (e.g. *ดึงกลับ /
WINBACK*, *ขายเพิ่ม / UPSELL*, *ดูแลลูกค้า VIP / VIP_CARE*, *กระตุ้นให้กลับมา / REACTIVATE*).

**To review a segment's customers:**

1. Open **Customer Intelligence** and pick a **segment** (e.g. *At Risk VIPs*). The members appear as a
   sortable list.
2. Sort by **มูลค่า (CLV)** to see your most valuable customers first, or by **ความเสี่ยงเลิกใช้
   (churn)** to see who is most likely to leave. Each row shows the recommended **next action**.
3. To act, press **สร้างแคมเปญ (Create campaign)** — this opens a **draft** campaign aimed at that
   segment, which you **edit and send** through the normal messaging screen.

> These scores are **advice**, kept separate from the company's own churn/value figures — they never
> overwrite them. Nothing is sent automatically: a customer is only contacted through a campaign a
> person reviews and sends, and only if they have consented. Each company sees only its own customers.

---

## 5e. Incrementality — did the campaign actually work? (`/marketing-intel`)

**Where:** sidebar **วางแผน & BI → Marketing Intelligence → Incrementality**. **Who:** `marketing`
or `exec`.

A jump in sales after a campaign isn't proof the campaign *caused* it — sales can rise for many
reasons. The honest way to know is an **A/B holdout test**: contact most of a segment (the **treatment**
group) but deliberately hold back a small random slice (the **control** group), then compare. The
difference is the real **lift**.

**To run a holdout test:**

1. Open **Incrementality**, pick a **segment**, set the **holdout %** (e.g. 20% held back) and a
   **measurement window** (e.g. 14 days), and press **เริ่มการทดลอง (Start test)**. The system splits
   the members and sends the campaign to the **treatment** group only — the **control** group is fixed
   at that moment and **never contacted**.
2. After the window has passed, press **วัดผล (Measure)**. The system compares the average sales per
   person in each group and reports the **lift %** and the **incremental revenue** the campaign caused.

> The control group is chosen once and never contacted, so the comparison is fair. You can't measure
> before the window ends, and a test can't be re-measured (the result is locked). Each company sees
> only its own tests. These measured results also flow back to the analytics platform so future
> recommendations learn from what actually worked.

---

## 5f. Model governance (`/marketing-intel`)

**Where:** sidebar **วางแผน & BI → Marketing Intelligence → Governance**. **Who:** `marketing` or
`exec` to view; `exec` / `approvals` to change the setting and approve runs.

Because these analytics now drive real spend and customer contact, you can require them to be **checked by
a second person** before anyone acts on them — the same control posture as the rest of the finance system.

**To turn on governance:**

1. Open **Governance** and switch **Require approval** on. From now on, each result the platform pushes in
   arrives **Pending** and can't drive a budget plan or a campaign until someone approves it.

**To review and approve a run:**

2. Each run shows its **model card** (which model version, over what training window, key metrics like R²)
   — the record of *what produced this recommendation*.
3. If a run's quality dropped sharply from the last approved one, it's flagged **drift** and appears in the
   company-wide **pending-approvals center**. Approving a drifted run **requires a reason**.
4. Press **อนุมัติ (Approve)**. You **cannot approve a run you pushed** — a different person must, so a
   recommendation always has a second pair of eyes.

The **audit trail** at the bottom links the whole chain — the recommendation (run) → the action it drove
(budget plan) → the measured outcome (campaign lift) — the evidence auditors ask for.

> Governance is **off by default**, so nothing changes until you switch it on. Each company has its own
> setting and sees only its own runs.

---

## 5g. Marketing Activation workspace (`/marketing-activation`)

**Where:** sidebar **วางแผน & BI → Marketing Activation**. **Who:** `marketing` or `exec`.

One friendly "Marketing Studio" home for the five activation tools (docs/61, controls MKT-21…25). Every
tool is **advisory**: nothing here sends a message or spends money by itself — contact always goes through
a consent-gated campaign **draft**, spend/contact needs a **second approver**, and holdout groups keep every
action measurable. Amounts on this workspace display as **"48,000 THB"** (no ฿ sign, by design).

**ภาพรวม (Overview).** Live counters (journeys, AI drafts, the latest save-run net benefit, segments ready)
plus one card per tool — click a card to jump to its tab. The **ทำงานอย่างปลอดภัย** card summarises the
guardrails.

**To find what to offer a customer (③ Cross-sell):**
1. Open the **สินค้าที่ควรเสนอ** tab and enter a customer code (e.g. `M-1042`), then **ค้นหา**.
2. Read the ranked offers — each one says *why* (**เพราะซื้อ "…"**), with the confidence, **lift** and margin
   behind it, and shows whether the customer has consented to marketing.
3. The right-hand panel answers the reverse question: enter an item id to see the **best audiences** for it.

**To decide where the next budget goes (⑤ Segment × Channel):**
1. Open **ROI กลุ่ม × ช่องทาง**, set the budget and press **จัดอันดับ**.
2. Cells are ranked by incremental ROI × segment value; a **lift จริง** chip means a real measured
   experiment (MKT-19) backs that cell, not just the model.
3. **จัดเป็นแผนงบ** stages the split as a Pending budget plan — a *different* user approves it on
   **Marketing Intelligence → Budget Planner** (the MKT-17 maker-checker path).

**To run a prioritised journey (② Next-best action):**
1. Open **ลำดับการกระทำ**, pick a segment — the preview ranks members by expected value and shows who was
   auto-suppressed (no consent / recent purchase / no action), each with the reason recorded.
2. **จัดเป็น journey** stages it; a *different* user presses **เปิดใช้งาน** (self-activation is refused —
   แบ่งแยกหน้าที่) and only then a consent-gated draft is created for the treatment arm.
3. **Prove it worked:** activation starts a measurement window (14 days by default). Once it elapses, press
   **วัดผล** on the journey — the system compares the treatment arm's *real* POS revenue against the
   never-contacted control arm and pins the **realized lift** on the journey (a green/red chip). Measuring
   early tells you the window hasn't elapsed; a journey staged without a control group can never claim a
   measured lift. The proven lift automatically feeds the **ROI กลุ่ม × ช่องทาง** ranking.

**To draft a campaign with AI (① Studio):**
1. Open **สตูดิโอ AI**, pick a segment — the studio drafts bilingual copy from the segment's *facts*
   (size, CLV, dominant action, best channel, send-hour, and the segment's **top un-bought product** as the
   concrete offer). Expand **ดูพรอมป์ + model card** to see the grounding evidence.
2. A badge on the draft shows **who wrote the copy**: **เขียนโดย AI** (a live AI model refined the wording —
   only when your company has not opted out of external AI processing in Settings › Labs & AI, per PDPA) or
   **แม่แบบมาตรฐาน** (the built-in deterministic template — also the automatic fallback whenever AI is
   unavailable). Either way the *targeting* (channel, send-hour, reach, holdout) always comes straight from
   the facts, and the model card records which one produced it.
3. **สร้างดราฟต์แคมเปญ** logs the model card and creates a *draft* — a human always reviews; you edit and
   send it from the normal campaign flow; nothing auto-sends.

**To save at-risk customers (④ Churn-save):**
1. Open **รักษาลูกค้า** and stage a policy (risk threshold, minimum CLV, offer rate and the **hard offer
   cap** — the control that stops runaway discounts). A *different* user approves it.
2. The preview sweeps at-risk, consented customers, shows every **capped** offer and the retention P&L
   (expected saved − offer cost, ROI). **เริ่มรอบรักษาลูกค้า** records the run and creates the draft for
   the treatment arm only — the control group is never contacted, so the saved revenue is provable. The run
   also records *who* was in each group, so the proof can be computed later.
3. **Prove the save:** after the run's measurement window (14 days by default), press **วัดผล** on the run —
   the system compares real POS revenue between the treated and control groups and replaces the *expected*
   numbers with a **พิสูจน์แล้ว** chip: the realized saved revenue and the realized net benefit
   (saved − offer cost). A run with no control group cannot claim a measured save.

**Run the toolkit on a schedule (autopilot):**
1. Open **รายงานตามกำหนดเวลา** (Scheduled Reports) and add any of the three marketing jobs:
   **จัดแผน NBA อัตโนมัติ** (stages a journey and waits for a human to activate it),
   **จัดรอบรักษาลูกค้าอัตโนมัติ** (stages a save sweep under the *approved* policy), and
   **วัดผลการตลาดเมื่อครบกำหนด** (measures every journey/run whose window elapsed, so realized lift keeps
   flowing into the ROI ranking by itself).
2. The jobs only ever *prepare* work — anything staged shows `(auto)` as its requester, and activating,
   approving, sending and spending always remain a person's decision (แบ่งแยกหน้าที่ unchanged). A job that
   finds an item still in flight, or no approved policy yet, simply reports why and does nothing.

**See what needs you (action center):**
1. The **ภาพรวม** tab now opens with a **สิ่งที่รอคุณตอนนี้** card: red dots = measurement windows that
   elapsed (the proof is waiting), amber = journeys/policies/budget plans awaiting a second person, grey =
   standing nudges (e.g. no approved save policy yet). Click a row to jump to the owning tab.
2. The same items appear in the company-wide **pending-approvals monitor** for approvers who live there.

> **Good to know:** a brand-new company sees friendly zeros here. The tools light up as Marketing
> Intelligence pushes results in and campaigns start running.

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
   A dedicated screen, **`/crm/audience-export`** (`marketing`/`exec`), shows the consent-filtered
   payload preview, the register history, and whether the ROPA activity is recorded — with a link back
   here to actually schedule or run it.
   Destinations: a generic webhook/CDP (`AUDIENCE_EXPORT_URL`) and/or **direct Meta Custom Audiences +
   Google Customer Match** (set the `META_*` / `GOOGLE_ADS_*` creds; each configured platform gets its own
   register row). Nothing configured = a safe mock run.
   **Consent withdrawal is honoured externally too:** every run also *removes* previously-uploaded
   members whose marketing consent is no longer live from each configured platform (Meta delete,
   Google remove job, webhook `action='remove'`) — the register row shows the count as `rows_removed`,
   and a member is only marked removed once **every** platform accepted (otherwise the run fails with
   `AUDIENCE_REMOVE_FAILED` and retries on the next run).
   **Reputation & analytics sync** (docs/47): **Google Maps reviews** and **Google Analytics (GA4)**
   don't offer webhooks, so two scheduled jobs poll them instead — `reputation_review_sync` pulls new/
   updated reviews for every location you've connected, and `reputation_ga4_sync` pulls daily sessions/
   users/conversions/revenue for every connected property. Connect and manage both at the dedicated
   screen, **`/reputation`** (`marketing`/`exec`) — Connections (OAuth connect + pick locations/
   properties), Reviews (with a needs-attention filter + in-app reply), and Analytics (a live dashboard
   also readable via `GET /api/bi/reputation-summary`). Wongnai reviews aren't supported — no
   documented public API exists for a third party to pull its own reviews there.
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
