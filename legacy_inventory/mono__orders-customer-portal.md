I have read the entire assigned range (L3665-6662). I now have complete coverage of all eight features. I'll compile the exhaustive structured reverse-engineering documentation.

# Order Management & Customer Portal — Reverse-Engineering Spec (ERPPOS_Invisible.py L3665-6662)

File: `C:/Users/ASUS/Invisible ERP/ERPPOS_Invisible.py`. All pages are `elif _menu_is(menu, "nav_*")` branches in the central Streamlit router. Currency formatting is hard-coded Thai Baht `฿`. i18n is via `T(key)` (some pages) but the **majority of customer-portal labels are hard-coded Thai with ad-hoc `st.session_state.get("lang")=="EN"` ternaries** — see PARITY FLAGS per page.

---

## 1. Order Management (`nav_order_mgt`) — Admin/Sales — L3665-3830

**Purpose:** Back-office order list, status workflow control, and document export. NOT customer-scoped (sees ALL customers).

**DB reads:** `tbl_sales_orders` (grouped header view + per-order line preview).
**DB writes:** `tbl_sales_orders` (status update; hard DELETE).

**Header query (L3678):**
```sql
SELECT DISTINCT Order_No, Customer_Name, Order_Date, Status,
       Estimated_Delivery, SUM(Total_Price) as Grand_Total
FROM tbl_sales_orders GROUP BY Order_No ORDER BY Order_Date DESC
```

**Status workflow (the canonical 6-state order lifecycle):**
`Pending → Processing → Shipped → Completed → Claimed → Cancelled`
- Selectable in any order (free transition, no guard rails) via `new_status` selectbox.
- **`Estimated_Delivery` is only captured when new status ∈ {Processing, Shipped}** (date_input shown conditionally, L3754); otherwise saved as empty string. Update statement blindly writes `est_date_val` (empty string) for other statuses — **silently wipes Estimated_Delivery when moving an order to Completed/Claimed/Cancelled.** PARITY-CRITICAL bug to preserve or fix deliberately.
- Update: `UPDATE tbl_sales_orders SET Status=?,Estimated_Delivery=? WHERE Order_No=?` — applies to **all line items** of the order (no Item-level granularity here).

**KPIs (counts of distinct-order rows):** Total, Pending, Shipped, Completed, Claimed. Note these count grouped rows, not `nunique`.

**Status color/bg maps** (parity-critical for visual fidelity): Pending `#fbbf24`, Processing `#60a5fa`, Shipped `#a78bfa`, Completed `#34d399`, Claimed `#f87171`, Cancelled `#9ca3af`. Order card list capped at `.head(20)`.

**Exports (4 buttons):**
- **PDF**: `generate_pdf(di, Customer_Name, Order_No, Order_Date)`.
- **TXT**: `generate_express_txt(...)` — "Express" accounting export format.
- **CSV**: Thai-column-named export (`'วันที่เอกสาร','เลขที่ใบสั่งขาย','รหัสลูกค้า','ชื่อลูกค้า','รหัสสินค้า','ชื่อสินค้า','จำนวน','หน่วยนับ','ราคา/หน่วย','จำนวนเงินรวม'`), `utf-8-sig` (BOM) encoded — **Thai column headers are load-bearing for downstream accounting-software import (Express). Must be byte-preserved.** `รหัสลูกค้า` (customer code) is exported empty.
- **PDF/TXT use f-string SQL interpolation** `WHERE Order_No='{sel_order}'` (SQL-injection-shaped; the others parametrize).

**Danger Zone:** Hard `DELETE FROM tbl_sales_orders WHERE Order_No=?` — irreversible, deletes all lines. Thai/EN warning text via `lang` ternary.

---

## 2. Claim Management Center (`nav_claim_mgt`) — Admin/Sales — L3835-3986

**Purpose:** Admin adjudicates customer-submitted claims. **Hard-coded Thai-only UI** (no EN path at all — PARITY FLAG).

**DB reads:** `tbl_sales_orders WHERE Claimed_Qty > 0` (pulls `rowid as _rid` + all cols).
**DB writes:** `tbl_sales_orders` (`Admin_Claim_Status`, `Reject_Reason` by rowid).

**Backward-compat shim:** if `Reject_Reason` column missing, synthesizes empty column (L3848) — handles older DB schemas.

**Claim adjudication workflow (3 states):**
`Waiting (default/null) → Approved | Rejected`
- Per-item selectbox `["Waiting","Approved","Rejected"]`, keyed `cs_{rowid}`.
- **Rejection requires a mandatory reason** (`Reject_Reason`): textarea only shown when `Rejected` selected; on save, validates `reject_reason_input.strip()` non-empty else blocks with error (L3935). Reason cleared to `""` if status flips away from Rejected.
- Save: `UPDATE tbl_sales_orders SET Admin_Claim_Status=?, Reject_Reason=? WHERE rowid=?` — **rowid-scoped (per line item)**, not Order_No.

**Per-order grouping:** orders grouped by `Order_No`; header shows `Customer_Name`; badge summarizes counts: `✅ N รับ / ❌ N ไม่รับ / 🟡 N รอ` (Approved/Rejected/Waiting).

**Evidence images:** displays `Claim_Image_Path` via `st.image` if file exists on disk (filesystem-coupled — paths stored relative, see Track Order §8).

**Report:** `generate_claim_summary_pdf(fresh_items, cust, so)` — re-queries DB fresh for latest `Reject_Reason` before generating "ClaimSummary_{Order_No}.pdf".

---

## CUSTOMER PORTAL — multi-tenant scoping
**All customer pages read `c_name`/`cust_name = st.session_state['customer_name']`** and scope EVERY query with `WHERE Customer_Name=?`. This is the sole tenant-isolation mechanism — there is no row-level DB enforcement, isolation is purely application-layer via this session var. **Dropping/loosening this `Customer_Name` filter in a rewrite = cross-tenant data leak.** Document numbering embeds `c_name[:N]` prefixes (collision risk for customers sharing name prefixes — see below).

---

## 3. Customer Dashboard (`nav_cust_dash`) — L3993-4859

**Purpose:** Customer self-service analytics home. Heavy Thai UI with partial EN tab labels.

**Pre-render side-effects (run on every load, before UI):**

**(a) Marketing popup/ticker (L3996-4063):**
- Reads `tbl_marketing_campaigns` (Active=1, Type='Popup'/'Ticker', date-bounded by `Start_Date<=today<=End_Date`), excludes popups already 'Closed' by this customer via `tbl_campaign_reads` anti-join. `ORDER BY Priority DESC LIMIT 1`.
- On close: writes `tbl_campaign_reads (Campaign_ID, Customer_Name, Read_At, Action='Closed')`. Ticker rendered via HTML `<marquee>`.

**(b) Auto-reorder trigger (L4065-4106) — CRITICAL business logic:**
- Reads `tbl_customer_inventory WHERE Customer_Name=? AND Reorder_Point > 0`.
- For each item where `Current_Stock <= Reorder_Point`: checks no existing Draft pending line via join `tbl_pending_order_items` × `tbl_pending_orders`. If none:
  - Gets-or-creates today's Draft `tbl_pending_orders` row. **Pending_No scheme:** `PND-{cust_name[:6] no spaces}-{YYYYMMDDHHMMSS}`, `Trigger_Type='Auto'`.
  - Inserts `tbl_pending_order_items` with `Suggested_Qty=Final_Qty=Reorder_Qty`, unit price from master, `Trigger_Reason="Stock (X) ≤ Reorder Point (Y)"`.
  - Whole block wrapped in bare `try/except: pass` — **silent failure swallows all errors** (parity hazard: if rewrite raises, behavior differs).

**Main data:** `tbl_sales_orders WHERE Customer_Name=?`.

**Welcome banner:** time-of-day Thai greeting (`<12` เช้า / `<17` บ่าย / else เย็น), last-order timestamp.

**Filter bar:** date_input range (defaults min/max), status multiselect (6 states), reset button.

**KPIs (6 metric pills, distinct-order counts):**
- Total spend (`Total_Price.sum`), avg/order; Total orders + completed; Pending+Processing (grouped as "รอดำเนินการ"); Shipped; Claimed-order count (`Claimed_Qty>0`); **MoM spend comparison** (this-month-to-date vs full last month, %delta with 📈/📉 + green/red). Pill #6 duplicates Shipped count (`avg_lead` computed but unused — dead code).

**Notifications:** `_get_notifications(cust_name, conn)` helper → list of `(icon, msg)`.

**Statement PDF:** month picker from order history; `generate_statement_pdf(df_stmt, cust_name, sel_month)` → `Statement_{cust}_{YYYY-MM}.pdf`.

**6 Tabs** (EN labels via `_is_en_cd` ternary; bodies mostly Thai):
1. **Overview** — status progress bars (% of total orders), status donut (`px.pie`), rule-based "Insights" (MoM up, shipped-in-transit, claim-count, top-ordered item via `groupby('Item_Description')['Order_Qty'].sum().idxmax()`).
2. **Spending Analysis** — granularity radio (รายวัน/สัปดาห์/เดือน), combo bar(spend)+line(order count) dual-axis, cumulative area chart, per-period summary table with Blues gradient. Uses ASCII agg col names deliberately (comment notes pandas encoding issue with Thai named-agg).
3. **Order History** — search by Order_No, timeline cards grouped by `Order_No/Order_Date/Status/Estimated_Delivery`, status icon + colored badge maps.
4. **My Items** — top-10 favorites by `total_spend`, medals 🥇🥈🥉, **per-item Reorder → adds to `st.session_state.cart`** (the standard POS cart; default qty = avg qty/times rounded), horizontal bar chart. Uses `T("reorder_btn")/T("reorder_ok")`.
5. **Claims** — claim KPIs (total/approved/rejected/waiting), approval-rate %, donut, detail table with conditional bg (`Approved`→green, `Rejected`→red), per-claim cards colored by `Admin_Claim_Status` showing `Reject_Reason` and evidence image expander. Backward-compat shims for missing `Admin_Claim_Status`/`Reject_Reason` cols.
6. **Raw Data** — re-queries `tbl_sales_orders WHERE Customer_Name=?`, search (Order_No/Item_Description/Item_ID), status multiselect, period selector (7/30/90 วัน/ทั้งหมด), summary metrics, order drill-down line items, CSV export `utf-8-sig` → `MyOrders_{cust}_{date}.csv`.

**PARITY FLAGS:** auto-reorder side-effect runs on dashboard view (not an explicit action — easy to miss); MoM "this month" = month-to-date vs full prior month (asymmetric window); pill #6 is a duplicate/dead; tab bodies are predominantly hard-coded Thai.

---

## 4. Customer POS (`nav_cust_pos`) — L4870-5230

**Purpose:** Customer's own retail front-of-house POS (a customer operating their shop, selling to end-consumers). Distinct from order-entry-to-supplier.

**Config loads:**
- `tbl_loyalty_config WHERE id=1` → `Enabled`, `Points_Per_Baht` (default 1.0).
- **`VAT_RATE = 0.07` hard-coded 7%** (comment says "from customer settings" but it is NOT — flag).

**Item catalog = union of:** `_load_master_df()` (Source='Master') + `tbl_customer_items WHERE Customer_Name=?` (Source='Custom', uses `Item_Name`/`UOM` cols).

**3 tabs:**

**TAB 1 New Sale:**
- Search (Item_ID/desc), per-hit qty + **Disc% per line**, `Eff_Price = Unit_Price*(1-disc/100)`. Cart in `st.session_state.cp_cart`.
- **Totals math:** `subtotal = Σ(qty*Eff_Price)`; `after_ly = subtotal − loyalty_discount`; `vat_amount = after_ly * 0.07`; `total_inc = after_ly + vat_amount`. (Loyalty discount sourced from `st.session_state['loyalty_discount']`, set elsewhere by loyalty redemption.)
- Payment method `["Cash","QR Code","Transfer","Card"]`, ref text, "ออกใบกำกับภาษี" (issue tax invoice) checkbox `include_vat` (captured but **not used to alter calc**).
- **Confirm Sale writes (transactional, single commit):**
  - **Sale_No scheme:** `SALE-{c_name[:4] no spaces}-{YYYYMMDDHHMMSS}`.
  - `tbl_cust_pos_sales` — **14-column positional INSERT `VALUES(?,...×14)`** (no column list — **column-order-fragile, schema drift will silently corrupt**): `(None, Sale_No, Sale_Date, Customer_Name, Subtotal, ly_discount, Tax_Amount, Total, Payment_Method, ly_discount, Points_Earned, 'Completed', pay_ref, username)`.
  - Per line → `tbl_cust_pos_items` (10-col positional): `(None, Sale_No, Item_ID, desc, Qty, UOM, Unit_Price, Disc_Pct, Amount, 0)`.
  - **Deducts customer inventory:** `UPDATE tbl_customer_inventory SET Current_Stock=MAX(0,Current_Stock-?)` + log to `tbl_cust_stock_log` (Log_Type='Sale', negative Qty_Change).
  - **Loyalty award** (if enabled): `pts_earned = subtotal * pts_per_baht`; upserts `tbl_loyalty_points` (Balance, Lifetime), inserts `tbl_loyalty_txn` (Txn_Type='Earn'). Note `Balance_After` passed as 0 (not computed). Wrapped in try/except pass.
  - Clears cart + `loyalty_discount`.
- **Receipt PDF (A5, reportlab):** generated inline; **BUG to preserve/flag**: iterates `st.session_state.get('last_cart_items',[])` which is set AFTER cart already cleared (L5083 assigns from the emptied `cp_cart`) → receipt line items render empty. Stored to `st.session_state['last_receipt']`.

**TAB 2 Sales History:** `tbl_cust_pos_sales WHERE Customer_Name=? LIMIT 100`; KPIs (Total/Txns/Points); drill `tbl_cust_pos_items WHERE Sale_No=?`; **Tax Invoice PDF (A4 reportlab)** "ใบกำกับภาษี" with itemized table + Subtotal/VAT 7%/Total, footer "Invisible Consulting Co., Ltd.".

**TAB 3 My Items:** `tbl_customer_items` CRUD. **Item_ID auto-prefixed `{c_name[:4].upper()}-{input}`.** Insert sets `Synced_Central=1` (flag for central demand analysis). Thai note: "ส่งให้ส่วนกลางเพื่อวิเคราะห์ความต้องการ" (sent to HQ for demand analysis).

---

## 5. Customer BOM (`nav_cust_bom`) — L5236-5841

**Purpose:** Customer recipe/Bill-of-Materials with cost rollup, production runs, and **dual-write sync to central submission tables for HQ approval.**

**4 tabs.** Core tables: `tbl_cust_bom` (header), `tbl_cust_bom_lines` (materials). **Every create/edit also dual-writes** `tbl_bom_submissions` + `tbl_bom_submission_lines` (the HQ-facing copy) with `Status='Pending'` — **this central-sync mirror is the parity-critical bit; dropping it breaks the HQ approval pipeline.**

**Cost model (parity-critical formulas):**
- `Conv_Factor` = buy-unit→use-unit (e.g. 1 KG = 1000 G → 1000).
- `Qty_Buy_UOM = Qty_Use_UOM / Conv_Factor`.
- `Line_Cost = Qty_Buy_UOM * Unit_Price` (Unit_Price pulled from master by Item_ID).
- `raw_cost = Σ Line_Cost`; `total_cost = raw_cost + Labor + Overhead + Other`.
- `cost_per_unit = total_cost / max(Yield_Qty, 0.001)`.
- `margin% = (Selling_Price − cost_per_unit) / max(Selling_Price,0.001) * 100`.

**TAB 1 My BoMs:** dedup by `BoM_Code` (keep first), expander per BoM with cost summary, materials table, cost-breakdown donut (RawMat/Labor/Overhead/Other). Delete removes from `tbl_cust_bom` + `tbl_cust_bom_lines` (but **NOT** the submission mirror tables — orphan flag).

**TAB 2 Create/Edit:** radio New vs Edit.
- **New:** header form + draft material lines in `st.session_state['draft_bom_lines']`. Save = DELETE+INSERT header & lines & **both submission tables** (`Status='Pending'`). **BoM_Code uniqueness scoped to `(BoM_Code, Customer_Name)`.**
- **Edit:** select existing BoM, live add/delete lines, each line op dual-writes/deletes from `tbl_bom_submission_lines` too.

**TAB 4 Import Excel:** openpyxl-generated 3-sheet template (BoM_Header / BoM_Lines / คำอธิบาย-instructions, all Thai). Import parses both sheets, recomputes Qty_Buy/Line_Cost from master prices, DELETE+INSERT into all 4 tables. Example rows are Thai (น้ำส้มคั้น, คุกกี้ช็อกโกแลต).

**TAB 3 Production Run:**
- **Run_No scheme:** `PRD-{c_name[:4] no spaces}-{YYYYMMDDHHMMSS}`.
- Computes required materials = `Qty_Buy_UOM * batch_qty`; checks against `tbl_customer_inventory.Current_Stock` (shows ✅ or ⚠️ ขาด shortage). **Does NOT block on shortage** (can run negative-feasible).
- On run: inserts `tbl_cust_prod_runs` (Status='Completed', Total_Cost) + `tbl_cust_prod_items` (Theoretical=Actual, Variance=0); **deducts each raw material** from inventory (`MAX(0,...)`) + stock log (Log_Type='Production'); **adds finished goods** to inventory (`INSERT OR IGNORE` the FG row keyed by `BoM_Code` as Item_ID, then `+= yield_total`) + stock log (Log_Type='Production-FG'). `yield_total = Yield_Qty * batch_qty`.

---

## 6. Customer Variance (`nav_cust_variance`) — L5847-6036

**Purpose:** End-of-day physical count vs system stock → variance analysis (theoretical-vs-actual usage). Anomaly threshold = **10%** (and 5% warning).

**Tables:** reads `tbl_customer_inventory`, writes `tbl_cust_variance` + updates inventory + `tbl_cust_stock_log`.

**TAB 1 Daily Count / EOD:**
- date + shift `["Day","Evening","Night","All Day"]`.
- Per inventory item: enter Actual Qty (default=Current_Stock); `Variance = Actual − System`. Only changed rows captured.
- `Variance_Pct = Variance / max(|System_Qty|,0.001) * 100`; color flag 🔴>10% / 🟡>5% / 🟢 else.
- **Mandatory reason capture** per varied item (free-text, not enforced-required at save).
- Save: INSERT `tbl_cust_variance (Var_Date, Customer_Name, Item_ID, desc, Theoretical_Use=System, Actual_Use=Actual, Variance, Variance_Pct, UOM, Reason, Shift)`; **overwrites** `tbl_customer_inventory.Current_Stock = Actual`; logs Log_Type='EOD-Count'.

**TAB 2 Dashboard:** KPIs (records, Σ|variance|, avg|var%|, anomalies>10%), filters (item/threshold slider 0-50/shift), styled table (red>10% / amber>5%), top-10 variance bar (diverging red→green), CSV export.

**TAB 3 Trend:** granularity radio, per-item or All, line chart of avg var% with min/max dotted bands + ±10% threshold hlines, anomaly list (>10%) with RdYlGn gradient.

**PARITY FLAG:** Variance field semantics — `Theoretical_Use`/`Actual_Use` columns actually store System-stock/Actual-count (naming mismatch with intent); preserve mapping.

---

## 7. Customer Inventory & Reorder (`nav_cust_inventory`) — L6037-6370

**Purpose:** Customer's raw-material stock ledger with reorder-point automation and a Draft→Submitted pending-order approval flow.

**Tables:** `tbl_customer_inventory`, `tbl_cust_stock_log`, `tbl_pending_orders`, `tbl_pending_order_items`; reads `tbl_sales_orders` (history suggestions) and master.

**Header KPIs:** Items Tracked; Below Reorder (`Current_Stock <= Reorder_Point`); Pending Draft orders count. Uses `_wh_kpi(...)` helper.

**TAB 1 My Stock:** status `🔴 ต้องสั่ง` (≤RP) / `🟡 ใกล้หมด` (≤RP*1.3) / `🟢 ปกติ`; days-to-empty estimate `Current_Stock / (Reorder_Qty/7)`; **Quick Reorder** button adds ALL below-RP items to `st.session_state.order_cart` (the supplier-order cart — qty=Reorder_Qty, price from master).

**TAB 2 Update Stock:** two modes —
- **Issue (เบิกใช้):** `new_balance = curr − issue_qty`; warns if below RP; UPDATE stock + log Log_Type='Issue' (negative, with `Balance_After`).
- **Physical Count (ปรับยอด):** `diff = phys − curr`; UPDATE stock=phys + log Log_Type='Adjustment'.
- Below: last-50 stock-log history.

**TAB 3 Pending Orders:** lists `tbl_pending_orders` (status colors Draft/Submitted/Approved/Rejected). For **Draft** orders: editable per-line Final_Qty, add more items from master, then:
- **📤 ส่งขออนุมัติ (Submit):** pushes all Final_Qty>0 lines into `st.session_state.order_cart` AND `UPDATE tbl_pending_orders SET Status='Submitted'`. **Pending-order status workflow:** `Draft → Submitted (→ Approved/Rejected set elsewhere)`. Non-Draft orders shown read-only.
- Cancel: hard-deletes order + items.

**TAB 4 Setup Items & Reorder:**
- **Auto-suggest** from purchase history: `tbl_sales_orders WHERE Customer_Name=? AND Item_ID NOT IN (already-tracked)` GROUP BY item, top-20 by qty; one-click add (default Reorder_Qty = avg per order). `INSERT OR IGNORE`.
- Manual add (form) `INSERT OR REPLACE tbl_customer_inventory` with RP/RQ/Notes.
- Edit/remove existing tracked items (RP, RQ).

**PARITY FLAGS:** Two different session carts in play — `cart` (POS/dashboard reorder) vs `order_cart` (inventory/pending supplier orders). Reorder_Point/Qty defaults and the `*1.3` near-low heuristic are load-bearing for the status coloring and the dashboard auto-trigger (§3b reads same RP).

---

## 8. Track Order (`nav_track`) — Customer Goods-Receipt & Claim Submission — L6371-6649

**Purpose:** Customer-facing order tracking + **the claim/return origination workflow** (the front of the claim pipeline that §2 Claim Management adjudicates).

**DB:** reads/writes `tbl_sales_orders WHERE Customer_Name=?`. **Schema-defensive:** `PRAGMA table_info` checks existence of `Claim_Image_Path` & `Admin_Claim_Status` before referencing.

**Display-status derivation (composite per-order, parity-critical):** queries all line `Status` values for the order, then:
- `has_claimed AND has_completed` → **"Partial Claim"** 🟠
- `has_claimed` → "Claimed" 🔴
- `has_completed` → "Completed" 🟢
- `has_shipped` → "Shipped" 🚚
- else → raw Status 🟡

**Goods-Receipt / Claim workflow (only when order has Shipped lines):**
Radio: `["-- เลือก --", "✅ ได้รับครบถ้วน (ไม่มีเคลม)", "⚠️ ไม่ครบ/มีตำหนิ (แจ้งเคลม)"]`.

**(a) Receive-complete path:** `UPDATE tbl_sales_orders SET Status='Completed', Received_Qty=Order_Qty WHERE Order_No=?` (all lines). Irreversible — Thai note warns claim no longer possible after.

**(b) Claim path (the return/claim origination — STATE TRANSITIONS):**
- `st.data_editor` grid: Item_ID/Description/Order_Qty **locked**; editable `Received_Qty (รับจริง)`, `Claimed_Qty (เคลม)` (default 0), `Reason (เหตุผล)`.
- Lines with `Claimed_Qty>0` = claimed; else received-complete.
- **Per-claimed-line image upload mandatory** (png/jpg/jpeg), keyed `img_{Order_No}_{Item_ID}`.
- **Validation before submit:** ≥1 claimed line; **every claimed line requires non-empty Reason AND an uploaded image** (else blocks).
- Images saved to `./claim_images/` dir (created if absent), filename `claim_{Order_No}_{Item_ID}.{ext}` — **relative filesystem path stored in `Claim_Image_Path`** (this is what §2 and Dashboard Tab-5 read back via `os.path.exists`; deployment must persist this dir — ephemeral container FS = lost evidence. FLAG.).
- **Writes per line (item-level status split):**
  - Claimed line: `Status='Claimed', Received_Qty=?, Claimed_Qty=?, Claim_Reason=?, Claim_Image_Path=?, Admin_Claim_Status='Waiting'`.
  - Non-claimed line in a claim submission: `Status='Completed', Received_Qty=Order_Qty, Claimed_Qty=0, Claim_Reason='', Claim_Image_Path=''`.
- **This produces the mixed-status order → "Partial Claim" display, and seeds `Admin_Claim_Status='Waiting'` consumed by Claim Management (§2).**

**Full claim/return lifecycle (cross-page):**
`Shipped` → [customer Track Order] → line-level `Claimed` + `Admin_Claim_Status='Waiting'` → [admin Claim Management] → `Approved`/`Rejected (+Reject_Reason)` → visible to customer in Track Order ("ผลการพิจารณา") and Dashboard Claims tab. There is **no automated inventory restock / credit-note** on claim approval in this range — approval is informational only (flag if rewrite is expected to post a return movement).

---

## Cross-cutting parity-critical inventory

- **Document numbering schemes** (all use `c_name`/`cust_name` prefixes → collision-prone for similar-named tenants): `PND-{name[:6]}-{ts}`, `SALE-{name[:4]}-{ts}`, `PRD-{name[:4]}-{ts}`, claim images `claim_{Order_No}_{Item_ID}`. Customer-item IDs prefixed `{name[:4].upper()}-`.
- **Status enums** (exact strings, case-sensitive): Order = Pending/Processing/Shipped/Completed/Claimed/Cancelled (+ derived "Partial Claim"). Admin claim = Waiting/Approved/Rejected. Pending order = Draft/Submitted/Approved/Rejected. Marketing campaign types = Popup/Ticker. Stock-log Log_Type = Sale/Production/Production-FG/Issue/Adjustment/EOD-Count.
- **VAT = 7% hard-coded** (Customer POS), **anomaly threshold = 10% / warn 5%** (Variance), **near-low = RP*1.3** (Inventory).
- **Multi-tenant isolation is app-layer only** (`WHERE Customer_Name=?` on every query) — no DB constraint backs it.
- **Central-sync mirrors:** Customer BOM → `tbl_bom_submissions/_lines` (Status='Pending'); Customer Items → `Synced_Central=1`. These feed the HQ side and must be preserved.
- **Positional INSERTs without column lists** (`tbl_cust_pos_sales` 14-col, `tbl_cust_pos_items` 10-col) — schema-fragile; a rewrite must keep exact column order.
- **Known latent bugs to consciously preserve-or-fix:** Order Mgt blanks Estimated_Delivery on non-ship statuses; POS receipt renders empty line items (cart cleared before receipt build); f-string SQL in PDF/TXT export; bare `try/except: pass` around auto-reorder and loyalty award (silent).
- **i18n inconsistency:** Order Mgt uses `T()`; Claim Mgt is **Thai-only**; customer pages mix `T()` + inline `lang=="EN"` ternaries + large hard-coded Thai blocks. A rewrite aiming for full EN/TH parity must externalize all the hard-coded Thai strings.