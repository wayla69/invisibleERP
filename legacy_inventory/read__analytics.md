I have everything needed. Producing the structured documentation.

# Analytics Module — Predictive Replenishment, Anomaly Detection & LLM Insights

Location: `C:/Users/ASUS/Invisible ERP/analytics/` — pure stdlib statistics (no numpy/pandas/sklearn), backed by SQLite via `erp_mcp.db`. Powers the 5 `/api/analytics/*` endpoints in `C:/Users/ASUS/Invisible ERP/api_server.py` (lines 850–916).

## Critical infrastructure facts (apply to ALL features below)

- **DB engine is SQLite** (`erp_mcp/db.py`, `sqlite3.connect`). All SQL uses **SQLite-specific functions** that are NOT portable to PostgreSQL — this is a parity landmine for any rewrite:
  - `strftime('%Y-%m-%d', col)`, `julianday(...)`, `date('now', '-60 days')`, `?` positional params, `ABS()/COALESCE()` (these last two are portable).
  - **PG rewrite must translate:** `julianday(g.GR_Date) - julianday(p.PO_Date)` → `(g.GR_Date::date - p.PO_Date::date)`; `strftime('%Y-%m-%d', x)` → `to_char(x,'YYYY-MM-DD')`; `date('now','-60 days')` → `now() - interval '60 days'`; `?` → `%s`.
  - Note: repo recently migrated user_store to PostgreSQL (`git log`), but **analytics still targets SQLite exclusively**. If the master DB moves to PG, all of analytics breaks silently (functions like `julianday`/`strftime` don't exist in PG → SQL errors, not wrong answers).
- `fetchall` returns `list[dict]`; `fetchone` returns `dict | None`. Rows accessed by **exact column-name keys** — column casing is load-bearing (`Item_ID`, `AV_QTY`, `Sale_Date`, etc.). PG lowercases unquoted identifiers, which would break every `r["Item_ID"]` lookup.
- `DB_PATH` resolved from `DB_PATH` env (Railway volume) → `config.json` `db_filename` → `Inventory_Master_DB.sqlite`.
- **All date math uses `datetime.now()` (server local time, naive).** No timezone handling — Thai (ICT/UTC+7) vs server UTC could shift day-bucketing and stockout dates. Flag for parity.

---

## FEATURE 1 — Predictive Replenishment / Stockout Forecasting (`forecasting.py`)

**Purpose:** For each inventory item, forecast days until stockout and a reorder point from 60-day sales history, supplier lead time, and current stock. Drives reorder urgency triage.

### Endpoints powered
- `GET /api/analytics/replenishment?limit=50` → `get_replenishment_list(limit)`. Returns `{items, count, critical, warning}`.
- `GET /api/analytics/replenishment/{item_id}` → `predict_stockout(item_id)` merged with `get_replenishment_insight(pred)` under key `insight`.
- `GET /api/analytics/dashboard-summary` uses `get_replenishment_list(limit=10)`.

### Sub-algorithm 1a — `_daily_sales(item_id, days=60)` → `list[float]`
- **Inputs:** `item_id`, lookback `days` (default 60).
- **SQL:** sums `i.Qty` from `tbl_cust_pos_items` JOIN `tbl_cust_pos_sales` on `Sale_No`, grouped by day, where `Sale_Date >= cutoff` AND `s.Status != 'Voided'`. Cutoff = `now() - days`.
- **Key logic — gap-filling:** builds a **dense daily series** from the earliest day with sales through `datetime.now()`, inserting `0.0` for days with no sales. Start = `min(observed day)`, NOT `now-60`. **Parity-critical:** the series length depends on the first sale date, not the window — an item whose first sale was 12 days ago yields a 12-element series even though the window is 60 days. This directly feeds the `confidence` and `data_days` outputs and the `series[-30:]` slice below.
- **DB read:** `tbl_cust_pos_items` (Qty, Item_ID, Sale_No), `tbl_cust_pos_sales` (Sale_No, Sale_Date, Status).
- **Voided exclusion** is a hard business rule — drop it and forecasts inflate.

### Sub-algorithm 1b — `_lead_time_days(item_id)` → `float`
- **Math:** average of `GR_Date − PO_Date` (in days, via `julianday` difference) over up to 10 most recent matching POs. Returns `round(mean, 1)`, **fallback `7.0`** if no history.
- **SQL filter:** `tbl_po_items` JOIN `tbl_purchase_orders` (Status `IN ('Received','Partial')`) JOIN `tbl_goods_receipt` on `PO_No`, requiring `GR_Date > PO_Date`. Only positive lead times kept (`lt > 0`).
- **DB read:** `tbl_po_items` (Item_ID, PO_No), `tbl_purchase_orders` (PO_No, PO_Date, Status), `tbl_goods_receipt` (PO_No, GR_Date).
- **Parity-critical:** `LIMIT 10` with no `ORDER BY` → SQLite returns rows in arbitrary/rowid order, so the "10 samples" are not deterministically the most recent. Replicate behavior or note the change.

### Sub-algorithm 1c — `_current_stock(item_id)` → `float`
- Latest `AV_QTY` from `tbl_raw_inventory` ordered by `Generate_Date DESC LIMIT 1`. `0.0` if none.
- **DB read:** `tbl_raw_inventory` (AV_QTY, Generate_Date, Item_ID).

### Core — `predict_stockout(item_id)` → `dict`
Inputs: `item_id`. Internally calls 1a (days=60), 1b, 1c, plus item meta (`Item_Description`, `UOM` from `tbl_raw_inventory`).

**Empty/zero-sales guard:** if series empty or all zeros → returns dict with `avg_daily_sales=0`, `days_of_stock=None`, `predicted_stockout_date=None`, `reorder_point=0`, `urgency="ok"`, `confidence="low"`, and **Thai message `"ไม่มีข้อมูลยอดขาย"` (“no sales data”)**. Note `uom` IS included here but `data_days` is NOT (inconsistent shape vs the normal path — easy to drop in a rewrite).

**Math (the precise statistics):**
1. `recent = series[-30:]` if `len(series) >= 30` else the whole series. (Uses the **trailing 30 days** of the gap-filled series.)
2. `avg = mean(recent)` (average daily sales).
3. `sd = stdev(recent)` if `len(recent) > 1` else `0.0` (sample stdev, `statistics.stdev`, i.e. n−1 denominator).
4. `safety = sd * 1.5` (safety stock = 1.5 standard deviations of daily demand).
5. **Reorder point** = `round(avg * lead_time + safety, 2)` = `(avg daily sales × lead time) + 1.5·σ`.
6. **Days of stock** = `stock / avg` (only if `avg > 0`; else `None`).
7. **Predicted stockout date** = `now() + days_left` days, formatted `%Y-%m-%d` (else `None`).

**Urgency classification (status workflow — exact thresholds):**
- `days_left is None` → `"ok"`
- `days_left <= lead_time` → `"critical"`
- `days_left <= lead_time * 2` → `"warning"`
- else → `"ok"`

**Confidence** (based on full series length, not `recent`):
- `len(series) >= 30` → `"high"`; `>= 14` → `"medium"`; else `"low"`.

**Output dict (normal path):** `item_id, item_name (=Item_Description or item_id), uom (or "unit"), current_stock (round 2), avg_daily_sales (round 2), stdev_daily (round 2), lead_time_days, days_of_stock (round 1 or None), predicted_stockout_date, reorder_point, urgency, confidence, data_days (=len(series))`.

### `get_replenishment_list(limit=50)` → `list[dict]`
- **Candidate set:** `SELECT DISTINCT Item_ID` from POS items joined to sales where `Sale_Date >= date('now','-60 days')` AND `Status != 'Voided'`, `LIMIT 200`. **So at most 200 distinct items are ever evaluated** (hard cap — items selling rarely or beyond the first 200 distinct rows are silently never considered for reorder). Flag.
- Calls `predict_stockout` per candidate; keeps only `urgency in ("critical","warning")`.
- **Sort:** by `(urgency order {critical:0, warning:1, ok:2}, days_of_stock or 999)` ascending → critical first, then soonest stockout. Truncated to `limit`.
- **N+1 query pattern:** one `predict_stockout` per item, each issuing ~4 sub-queries → up to ~800 SQLite queries per call. Performance-critical; a rewrite batching this could change ordering ties.

---

## FEATURE 2 — Anomaly Detection (`anomalies.py`)

**Purpose:** Flag unusual stock movements (waste/theft/loss spikes) and large stocktake discrepancies for loss-prevention. `Z_THRESHOLD = 2.5` (module constant).

### Endpoints powered
- `GET /api/analytics/anomalies?days=30` → `get_anomaly_summary(days)`.
- `GET /api/analytics/dashboard-summary` → `get_anomaly_summary(days=7)`.

### Helper — `_zscore(value, series)` → `float`
- Returns `0.0` if `len(series) < 3` OR if `stdev(series) == 0` (guards div-by-zero and tiny samples). Else `(value − mean(series)) / stdev(series)`. Sample stdev (n−1).

### 2a — `detect_stock_anomalies(days=30)` → `list[dict]`
- **Baseline window:** `hist_cutoff = now − (days + 60)`. **Recent window:** `cutoff = now − days`. So baseline spans the last `days+60` days; recent spans last `days`. **The recent window's days are INCLUDED in the baseline series** (no exclusion), which slightly self-dampens the z-score. Note for parity.
- **Baseline series:** from `tbl_stock_movements`, group by `(Item_ID, Move_Type, day)`, value = `SUM(ABS(Qty))` per day. Built into `series_map[(Item_ID, Move_Type)] = [daily totals...]`. (Uses `ABS` so direction-agnostic magnitude.)
- **Recent aggregate:** group by `(Item_ID, Move_Type)`, `total_qty = SUM(ABS(Qty))`, `event_count = COUNT(*)`, `HAVING SUM(ABS(Qty)) > 0`.
- **Detection:** for each recent group, `z = _zscore(total_qty, baseline_daily_series)`. **Note dimensional mismatch (parity-critical, possibly a latent bug to preserve):** `total_qty` is the *summed* recent total over `days`, while the baseline series is *per-day* totals. The recent aggregate is compared against the distribution of single-day historicals → inflates z. Replicate exactly unless intentionally fixing.
- **Flag if `z > 2.5`.** For each flagged, looks up `Item_Description` from `tbl_raw_inventory`.
- **Severity:** `z > 3.5` → `"critical"`, else `"warning"`.
- **Output per anomaly:** `item_id, item_name, movement_type, recent_qty (round 2), hist_avg (=round(mean(series),2) or 0), z_score (round 2), event_count, severity, detected_at ("%Y-%m-%d %H:%M")`. Sorted by `z_score` desc.
- **DB read:** `tbl_stock_movements` (Item_ID, Move_Type, Move_Date, Qty), `tbl_raw_inventory` (Item_Description).

### 2b — `detect_stocktake_variance(threshold_pct=20.0)` → `list[dict]`
- **Latest stocktake only:** `WHERE st.ST_Date = (SELECT MAX(ST_Date) FROM tbl_stocktake)`. Earlier stocktakes ignored.
- **Math per row:** `expected = System_Qty`, `counted = Physical_Qty`, `variance = Difference` (falls back to `counted − expected` if `Difference` NULL).
  - `pct = abs(variance/expected) * 100` when `expected != 0`; when `expected == 0` → `100.0` if `variance != 0` else `0.0`.
- **Flag if `pct >= threshold_pct` (default 20%).**
- **Severity:** `pct >= 50` → `"critical"`, else `"warning"`.
- **Output:** `item_id, item_name, stocktake_date, expected_qty, counted_qty, variance, variance_pct (round 1), severity`. Sorted by `variance_pct` desc.
- **DB read:** `tbl_stocktake` (Item_ID, Physical_Qty, System_Qty, Difference, ST_Date) LEFT JOIN `tbl_raw_inventory` (Item_Description).

### 2c — `get_anomaly_summary(days=30)` → `dict`
- Combines 2a (`days`) + 2b (default threshold). `critical_count` = critical movement anomalies + critical variances. `warning_count` = total − critical.
- **Output:** `{movement_anomalies:[...], stocktake_variances:[...], summary:{total_anomalies, critical_count, warning_count, analysis_days, generated_at "%Y-%m-%d %H:%M"}}`. The dashboard endpoint returns `anomaly["summary"]` directly.

---

## FEATURE 3 — LLM Insights (`llm_insights.py`) — Anthropic integration

**Purpose:** Turn structured predictions/anomalies into concise **Thai-language** recommendations. Three functions, each with a deterministic rule-based fallback.

### Endpoints powered
- `GET /api/analytics/replenishment/{item_id}` → `get_replenishment_insight(pred)`.
- `POST /api/analytics/insight` body `{type, data}` (`InsightRequest`): `type=="replenishment"`→`get_replenishment_insight`; `type=="anomaly"`→`get_anomaly_insight`; else HTTP 400. Returns `{"insight": text}`.
- `GET /api/analytics/dashboard-summary` → `get_bulk_insight(repl_items, anomaly_summary)`.

### Anthropic call mechanics (identical pattern in all 3 functions)
- **Gate:** reads `os.environ["ANTHROPIC_API_KEY"]` (default `""`). **If empty → returns rule-based fallback immediately**, never imports anthropic. (Module docstring claims `claude-sonnet-4-6`; matches code.)
- **Client:** `import anthropic` (lazy, inside function); `anthropic.Anthropic(api_key=api_key)`; `client.messages.create(...)`.
- **Model: `"claude-sonnet-4-6"`** (hard-coded string literal in all three calls — single point to update on model migration; note this is not a currently-valid public model id, a rewrite should confirm/replace it).
- **Params:** single `{"role":"user","content":prompt}` message; **no system prompt**; `max_tokens` = **300** (single replenishment), **300** (single anomaly), **200** (bulk). No temperature/streaming/tools.
- **Response extraction:** `msg.content[0].text.strip()` (first content block only).
- **Error handling:** entire call wrapped in `try/except Exception` → **any failure (network, bad key, API error, model id rejected) silently falls back to the rule-based string.** No logging. Parity-critical: failures are invisible; a rewrite must preserve graceful degradation or it will hard-fail dashboards.
- **Data passed to model:** the full prediction/anomaly dict via `json.dumps(..., ensure_ascii=False, indent=2)` (ensure_ascii=False preserves Thai). The bulk prompt instead passes counts + `[p['item_name'] for p in replenishment_list[:3] if urgency=='critical']`.

### Prompts (parity-critical — exact persona/language constraints)
- **`get_replenishment_insight`:** persona "ERP inventory analyst for a Thai food distribution company"; "concise, actionable recommendation in Thai (2-3 sentences max)"; focus urgency/action/quantity; "Reply in Thai only."
- **`get_anomaly_insight`:** persona "fraud and loss prevention analyst for a Thai food distribution company"; "Reply in Thai only"; focus what happened/severity/action.
- **`get_bulk_insight`:** "Summarize this ERP analytics snapshot for a Thai F&B company manager in 2 sentences in Thai." Includes counts of reorder items (+critical) and anomalies (+critical) and top-3 critical item names.

### Rule-based fallbacks (used when no key OR on exception — i18n-critical Thai strings with emoji)
- **`_rule_based_replenishment(pred)`:** branches on `urgency`:
  - `critical`: `⚠️ **{name}** มีสต๊อกวิกฤต! คาดว่าจะหมดใน {days:.0f} วัน แต่ Lead Time ของ Supplier คือ {lt} วัน — ควรสั่งซื้อทันที (Reorder Point: {reorder:.0f} หน่วย, ยอดขายเฉลี่ย {avg:.1f} หน่วย/วัน)`
  - `warning`: `⚡ **{name}** ควรพิจารณาสั่งซื้อเร็วๆ นี้ สต๊อกเหลือประมาณ {days:.0f} วัน (Lead Time: {lt} วัน) Reorder Point แนะนำ: {reorder:.0f} หน่วย`
  - else: `✅ **{name}** สต๊อกเพียงพอ ยังไม่จำเป็นต้องสั่งซื้อ`
  - **Runtime risk to preserve/flag:** `critical`/`warning` branches format `days:.0f`, but `days_of_stock` can be `None` (e.g. `urgency` from inconsistent data) → would raise `TypeError`. In practice `critical`/`warning` only occur when `avg>0` so `days` is set, but a rewrite feeding arbitrary dicts via `POST /api/analytics/insight` could crash here.
- **`_rule_based_anomaly(anomaly)`:** `🔴 ตรวจพบความผิดปกติ: **{name}** มี {mtype} สูงผิดปกติ ({qty:.1f} หน่วย เทียบกับค่าเฉลี่ยปกติ {avg:.1f} หน่วย, Z-score: {z:.1f}) — แนะนำตรวจสอบและขออนุมัติหากจำเป็น`
- **`get_bulk_insight` fallback:** pipe-joined parts — `⚠️ มีสินค้า {n} รายการที่ต้องสั่งซื้อด่วน`, `🔴 พบความผิดปกติร้ายแรง {n} รายการ ควรตรวจสอบทันที`, or `✅ สต๊อกสินค้าและการเคลื่อนไหวอยู่ในระดับปกติ`. The except-branch fallback differs slightly: `⚠️ {critical_repl} รายการต้องสั่งด่วน | 🔴 {critical_anom} anomalies วิกฤต`.

---

## Cross-cutting parity risks (easy to silently drop in a rewrite)
1. **No RBAC / no multi-tenant scoping anywhere** in analytics — queries are global across the entire DB (no customer/branch/tenant filter, no role gate). If the target system is multi-tenant, every endpoint leaks all items. The only filters are date + `Status != 'Voided'`. Endpoints in `api_server.py` (858–916) have no auth dependency shown.
2. **No document numbering schemes** in analytics (read-only over POS/PO/stocktake docs); but it *consumes* `Sale_No`, `PO_No`, `GR_No`-style keys and PO `Status` workflow values `'Received'/'Partial'` and sale `Status='Voided'` — these enum/status strings must match the source system exactly.
3. **Magic constants to carry over verbatim:** `Z_THRESHOLD=2.5`, critical z `>3.5`, safety factor `1.5`, lead-time fallback `7.0`, variance threshold `20.0` (critical `>=50`), confidence cutoffs `30`/`14`, lookback `60`, recent slice `[-30:]`, candidate `LIMIT 200`, lead-time `LIMIT 10`, urgency multiplier `×2`, `max_tokens` 300/300/200.
4. **Thai-only LLM output + Thai fallback strings with emoji** — i18n is hard-coded Thai, no English path. A rewrite adding English must not break the Thai default.
5. **Statistics use `statistics.stdev` (sample, n−1)** throughout, not population stdev — matters for reproducing exact z-scores and reorder points.
6. **SQLite-only date/time SQL** (see top section) — the single biggest portability risk.