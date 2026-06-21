I now have full coverage of all helper functions and the complete feature range. Here is the structured analysis.

---

# Legacy Streamlit Monolith — Reverse-Engineering Report

## Scope: `ERPPOS_Invisible.py` L6662–9569

Covers: **Planner** (`nav_planner`), **Warehouse** (`nav_warehouse`), **Procurement** (`nav_procurement`), **Images** (`nav_images`), **Master Data** (`nav_masterdata`), **BoM Master** (`nav_bom_master`).

---

## 0. Shared infrastructure (parity-critical helpers)

| Helper | Location | Behavior — DO NOT silently drop |
|---|---|---|
| `_next_doc_no(prefix, conn)` | L2251 | Format `{PREFIX}-{YYYYMMDD}-{NNN}` (3-digit zero-pad). **Counter = `COUNT of rows LIKE '{prefix}-{today}%'` + 1.** Per-day reset. Only handles 4 prefixes via lookup table: `PO`→`tbl_purchase_orders.PO_No`, `GR`→`tbl_goods_receipt.GR_No`, `ST`→`tbl_stocktake.ST_No`, `MI`→`tbl_stock_movements.Doc_No`. **`PR` and `GRC` are NOT in this map** — they are numbered inline (see below). ⚠️ **Numbering is not concurrency-safe** (count-based, race-prone). ⚠️ `MI` counts `tbl_stock_movements` rows but a single stocktake/GR inserts many movement rows, so MI numbering may skip — preserve exact semantics. |
| `_log_status(doc_type, doc_no, old, new, conn, remarks)` | L2595 | Inserts into `tbl_doc_status_log (Doc_Type, Doc_No, Old_Status, New_Status, Changed_By, Changed_At, Remarks)`. `Changed_By` = session username (fallback `'system'`), `Changed_At` = `'%Y-%m-%d %H:%M'`. Swallows all exceptions silently. |
| `_load_master_df()` | L2609 | Reads `master_path` **CSV** (not DB). Coerces `Item_ID` to stripped string. Injects defaults if missing: `Unit_Price=0, Stock_UOM='Unit', Category='ทั่วไป', Conversion_Factor=1, Min_Stock=0`. |
| `_get_current_stock_wh()` | L2621 | `@st.cache_data(ttl=300)`. Reads `tbl_raw_inventory`, filtered to **latest `Generate_Date` snapshot only** (`WHERE Generate_Date=(SELECT MAX(Generate_Date)...)`), `SUM(AV_QTY) GROUP BY Item_ID, Item_Description`. **Stock is snapshot-based, not transactional** — this is the source of truth for "current stock" across Planner & Warehouse. |
| `_make_qr_png_b64(data, size)` | L2271 | QR via reportlab `QrCodeWidget` + `renderPM` → base64 PNG. No external QR lib. |
| `_make_qr_label_pdf(items, label_cols, label_rows)` | L2391 | Grid label PDF generator. |
| `_wh_kpi(label, value, sub, bg, tc)` / `_wh_badge(status)` | L2528/2542 | KPI card / colored status pill HTML. |
| `_menu_is(menu_val, *keys)` | L2641 | **Routing is by translated label string**, comparing `menu_val` against `_LANG['TH'/'EN'][key]`. i18n switch is `st.session_state['lang'] == "EN"`. Every page recomputes `is_en` locally. |

---

## 1. PLANNER (`nav_planner`) — L6662–7082

**Purpose:** Reorder planning, what-if stress testing, deadstock analysis, and PR generation.

**Data assembly (L6667–6690):** LEFT-merges `_get_current_stock_wh()` (`df_stock`) with `_load_master_df()` (`df_master`) on `Item_ID`. Falls back to master-only (`AV_QTY=0`) or stock-only. Default-fills columns: `Min_Stock=0, Max_Stock=9999, Avg_Daily_Usage=0, Lead_Time_Days=3, Unit_Price=0, Category='ทั่วไป', Stock_UOM='Unit'`.

### ⚠️ Replenishment math (parity-critical, L6686–6690)
```
Days_Supply     = round(AV_QTY / Avg_Daily_Usage, 1)  if Avg_Daily_Usage>0 else 999
ROP             = Avg_Daily_Usage * Lead_Time_Days + Min_Stock     # reorder point
Suggest_Order   = clip(Max_Stock - AV_QTY, lower=0)               # order-up-to-Max
Budget_Required = Suggest_Order * Unit_Price
```
Health classification (L6738): `AV_QTY < ROP` → 🔴 Below ROP; `AV_QTY > Max_Stock` → 🟡 Overstock; else 🟢 Healthy. (Note overlap: an item below ROP that is also `>Max` can't happen, but `n_ok = len - n_below - n_over` can mis-count if both flags overlap.)

### Tab 1 — Stock Overview (L6700)
KPIs: Total SKUs, Below ROP count, Overstock count, Inventory Value `Σ(AV_QTY*Unit_Price)`. Search (Item_ID/Description), health multiselect, category filter. CSV export `utf-8-sig`.

### Tab 2 — Planner & Create PR (L6770)
- **Need-to-order set:** `AV_QTY <= ROP AND (Avg_Daily_Usage>0 OR Min_Stock>0)`. Overstock set: `AV_QTY > Max_Stock`.
- Editable `data_editor` — only `PR_Qty ✏️` column editable (pre-filled with `Suggest_Order`).
- **⚠️ PR numbering (L6817–6822):** `_next_doc_no('PR',...)` is called but **PR is not in the lookup map**, so it would fall through to PO table. The code then **overrides** it with an inline query: `PR-{YYYYMMDD}-{count of PRs LIKE today + 1:03d}`. Parity must replicate the inline override, not the helper.
- **PR insert (L6823):** `tbl_purchase_requests VALUES (?,?,?,?,?,?,?,?)` — 8 positional cols: `(PR_No, PR_Date, Requested_By, Status='Pending', '', '', Remarks, Priority)`. The two empty strings are `Approved_By`/`Approved_At` placeholders.
- **PR line insert:** `tbl_pr_items (PR_No, Item_ID, Item_Description, Request_Qty, UOM, Required_Date, Reason='Below ROP', Status='Open')`. Only rows with `PR_Qty > 0`.
- Inputs: Required Date (default +7d), Priority (Normal/Urgent/Low), Remarks.
- **PR History (L6850):** lists last 30. **RBAC: Approve/Reject buttons only if `Status=='Pending' AND role=='Admin'`.** Approve sets `Status='Approved', Approved_By, Approved_At`. Reject sets `Status='Rejected'`. Status colors: Pending/Approved/Rejected/Converted.

### Tab 3 — What-If Scenario (L6882)
Two sliders: Demand Spike % (0–200), Supplier Delay days (0–30).
```
Stress_Usage = Avg_Daily_Usage * (1 + spike_pct/100)
Stress_LT    = Lead_Time_Days + delay_days
Stress_ROP   = Stress_Usage * Stress_LT + Min_Stock
Will_Stockout = AV_QTY <= Stress_ROP
```
`df_fail` = will-stockout AND `Avg_Daily_Usage>0`. KPI before/after comparison, top-15 risk bar chart, baseline Days-of-Supply histogram (30-day threshold line).
- **Emergency PR button (L6956):** same inline PR numbering. PR `Priority='Urgent'`, remark `"Emergency: Spike {x}% + Delay {y}d"`. **Per-line qty = `max(Suggest_Order, Stress_ROP - AV_QTY)`, floored at 1.** Reason `"Emergency: Stress test scenario"`.

### Tab 4 — Deadstock Analysis (L6994)
Inputs: slow-mover threshold (Days_Supply >, default 90), dead threshold (default 180, **declared but unused in filter**), monthly warehouse cost (default ฿250,000).
```
Inv_Value       = AV_QTY * Unit_Price
Holding_Cost_Mo = (Inv_Value / total_inv) * monthly_wh_cost   # pro-rata allocation
Dead set  = AV_QTY>0 AND Avg_Daily_Usage==0
Slow set  = Days_Supply>=slow_days AND Days_Supply<999 AND AV_QTY>0
```
KPIs (dead/slow value + holding cost), scatter (Days vs Value, size=holding), stacked bar by category, two sub-tabs with CSV export. ⚠️ The `dead_days` input is collected but never applied to filtering — likely a latent bug; replicate or fix deliberately.

---

## 2. WAREHOUSE (`nav_warehouse`) — L7084–7482

**Purpose:** Goods issue/transfer, physical stocktake, QR label generation, movement history.

Data = same stock⋈master merge as Planner. KPIs: SKUs in stock, below-min count, movements today (`date(Move_Date)=date('now')`), open stocktakes (`tbl_stocktake.Status='Draft'`, distinct ST_No).

### Tab 1 — Goods Issue / Transfer (L7128)
- Radio: **Goods Issue** vs **Internal Transfer**. Header fields: Ref Doc, From Location (default "Main Warehouse"), To Location (default "Production / Customer" for issue, blank for transfer), Remarks.
- Cart in `st.session_state.mi_cart`. Availability warning if `qty > AV_QTY` (warns but **does not block**).
- **Confirm (L7176):** `doc_no = _next_doc_no('MI', conn)`. `Move_Type = 'Issue' | 'Transfer'`. Inserts per cart line into `tbl_stock_movements (Move_Date, Doc_No, Move_Type, Item_ID, Item_Description, UOM, Qty, From_Location, To_Location, Ref_Doc, Remarks, Created_By)`. **⚠️ Does NOT decrement `tbl_raw_inventory`** — movements are logged but stock snapshot is untouched (stock is recomputed from `Generate_Date` snapshots, not movements). Critical semantic: movements are an audit log, not a live ledger.

### Tab 2 — Stocktake (L7191)
- New Count: counter name (default username), zone/remarks, category filter.
- `data_editor` — only `Physical_Qty` (pre-filled = System_Qty) and `Remarks` editable. `Difference = Physical_Qty - System_Qty` computed live; discrepancies rendered as colored cards (green = surplus, red = short).
- **Save (L7249):** `st_no = _next_doc_no('ST', conn)`. Inserts **every row** (not just discrepancies) into `tbl_stocktake (ST_No, ST_Date, Item_ID, Item_Description, UOM, System_Qty, Physical_Qty, Difference, Counted_By, Status='Draft', Remarks)`. **⚠️ Status stays 'Draft' — there is no posting/adjustment step that writes back to inventory.** Stocktake is record-only.
- History: groups by ST_No (last 20), shows diff count, per-ST drilldown sorted by `ABS(Difference)`, CSV export.

### Tab 3 — QR Label Manager (L7286)
- **Universal QR concept (L7315):** one QR per item serves all actions (GR/Issue/Transfer/Stocktake/Info). Payload string format (parity-critical):
  `ITEM_ID:{id}|DESC:{desc[:35]}|UOM:{uom}|CAT:{cat}|PRICE:{price:.2f}` (single-item) and `ITEM_ID:{id}|UOM:{uom}` (bulk preview).
- Single: PNG download + styled info card + label-size selector (Standard 2×4, Large 2×3, XL 1×2, Small 4×5) → `_make_qr_label_pdf`.
- Bulk: category filter, size selector (with mm dims), max-items (1–200, default 20), page-count math `n_pages = ceil(len/(cols*rows))`, 10-item preview grid, full-sheet PDF generation.

### Tab 4 — Movement History (L7451)
Filter by Move_Type (Issue/Transfer/GR) and date window (7/30/90/All days via `date(Move_Date)>=date('now','-N days')`). Last 200 by `id DESC`. CSV export.

---

## 3. PROCUREMENT (`nav_procurement`) — L7488–8367

**Purpose:** Full PR→PO→GR→Claims→Suppliers cycle. 7-tab layout declared but **⚠️ tab-to-content mapping is scrambled** (see warning box below).

KPIs: total POs, pending approval, approved, open PO value (`Pending+Approved`), active suppliers.

### ⚠️⚠️ CRITICAL: Tab routing bug (parity trap)
Tabs are declared in this order (L7518): `pr_t1=PO Dashboard, pr_t2=PR→PO, pr_t3=Create PO, pr_t4=Approve, pr_t5=GR, pr_t6=Doc Trail, pr_t7=Suppliers`. **But the `with` blocks assign content to the WRONG variables:**
- `with pr_t1:` → PO Dashboard ✓ (L7529)
- `with pr_t2:` → **Create PO** (L7713) — mislabeled, tab says "PR→PO"
- `with pr_t3:` → **Approve/Reject** (L7782) — tab says "Create PO"
- `with pr_t4:` → **Goods Receipt + GR Claims** (L7824) — tab says "Approve"
- `with pr_t2:` → **PR→PO** AGAIN (L8053) — **second binding to pr_t2 overwrites/duplicates**; Streamlit renders both into the pr_t2 container
- `with pr_t6:` → Doc Status Trail (L8159) ✓
- `with pr_t5:` → **Suppliers** (L8233) — tab labeled "GR"
- `pr_t7` (Suppliers tab) is **never used**.

In a rewrite this must be deliberately reconciled — the *intended* UX is the label order; the *actual* runtime places content under mismatched tabs and double-renders pr_t2. **Flag explicitly: do not blindly copy the variable bindings.**

### Tab: PO Dashboard (L7529)
Status bar chart + top-8 suppliers by value. PO list with search + status multiselect (`Draft/Pending/Approved/Received/Closed/Cancelled`). Status color maps (`STATUS_COLOR`/`STATUS_TC`). Per-PO expander shows header + line items (`tbl_po_items`).
- **PO PDF export (L7596–7690):** hand-drawn reportlab canvas (A4). Navy header band, company name/subtitle from `CONFIG`, "PURCHASE ORDER", PO No/Date. Supplier box + Approval box (Approved_By/At, Created_By). Zebra-striped items table (`#`, Item Description[:52], Qty, UOM, Unit Price, Amount). TOTAL row, Remarks, system-generated footer with timestamp. Caption: "PDF is locked for editing — safe to send to supplier".
- **Cancel/Close (L7691):** if GR exists for PO and role≠Admin → blocked ("ต้องปิดผ่าน Admin"). Else if status in `Draft/Pending/Approved` → requires **mandatory cancel reason**, sets `Status='Cancelled'`, logs to `tbl_doc_status_log`.

### Tab: Create PO (bound to pr_t2, L7713)
- Requires active suppliers (`tbl_suppliers WHERE Active=1`). Header: Supplier, Expected Date (+7d), Remarks.
- Item add: select from master, qty, unit price (defaults to master `Unit_Price`), `Amount = round(qty*price, 2)`. Cart in `po_cart`.
- **Submit (L7769):** `po_no = _next_doc_no('PO', conn)`. `tbl_purchase_orders VALUES (?,?,?,?,?,?,?,?,?,?)` — 10 positional cols: `(PO_No, PO_Date, Supplier, Status='Pending', '', '', Remarks, Total_Amount, Created_By, Expected_Date)`. The two empties = `Approved_By`/`Approved_At`. Lines → `tbl_po_items (PO_No, Item_ID, Item_Description, Order_Qty, Unit_Price, UOM, Amount)`.

### Tab: Approve/Reject (bound to pr_t3, L7782)
- **RBAC: `role != 'Admin'` → blocked entirely.**
- Lists `Status='Pending'`. Approve → `Status='Approved', Approved_By, Approved_At`, `_log_status('PO',…,'Pending','Approved')`. Reject → `Status='Cancelled', Remarks='Rejected: {reason}'`, logs transition.

### Tab: Goods Receipt (bound to pr_t4, L7824)
- **New GR:** select from `Status='Approved'` POs. Per line shows `remaining = Order_Qty - Received_Qty`. Inputs per line: Received Qty (default=remaining, max=Order_Qty), Lot No, Expiry (dd/mm/yyyy text), Unit Cost (default=line Unit_Price).
- **Confirm GR (L7871):** `gr_no = _next_doc_no('GR', conn)`. Writes:
  1. `tbl_goods_receipt VALUES (?,?,?,?,?,?)` = `(GR_No, GR_Date, PO_No, Supplier, Received_By, Remarks)`.
  2. Per received line (`Received_Qty>0`): `tbl_gr_items (GR_No, PO_No, Item_ID, Item_Description, PO_Qty, Received_Qty, UOM, Lot_No, Expiry_Date, Unit_Cost)`.
  3. **Increments** `tbl_po_items.Received_Qty += recv` (this IS a live update, unlike issues).
  4. Inserts a `tbl_stock_movements` row with `Move_Type='GR'`, From='Supplier', To='Warehouse'.
  5. **Auto-close logic (L7886):** PO → `'Closed'` if ALL lines `Received_Qty >= Order_Qty`, else `'Received'`.
  6. **Lot ledger sync (L7889):** if line has non-blank Lot_No → insert `tbl_lot_ledger (Lot_No, Item_ID, …, Location_ID='WH-MAIN', GR_No, Qty_In, Qty_Out=0, Balance=Qty_In, Expiry_Date, Status='Active', Move_Date, Ref_Doc=GR_No, Created_By)`.
  ⚠️ GR does **not** update `tbl_raw_inventory` either — only the movement log + PO line + lot ledger.
- **GR History:** last 30, drilldown, per-GR "Raise Claim" button sets `st.session_state['active_claim_gr']`.
- **GR Claims (inbound supplier claims, L7934):**
  - New Claim: select GR → per-item claim qty (max=Received_Qty), reason, photo upload.
  - Image saved to `{base_folder}/gr_claim_images/GRCLAIM_{GR}_{Item}_{timestamp}.{ext}`.
  - **⚠️ Claim numbering is INLINE, not via helper (L7993):** `GRC-{YYYYMMDD}-{count LIKE 'GRC-today%' + 1:03d}`.
  - Insert `tbl_gr_claims (Claim_No, Claim_Date, GR_No, PO_No, Supplier, Item_ID, Item_Description, GR_Qty, Claim_Qty, UOM, Reason, Image_Path, Status='Open')`, `_log_status('GRC',…,'','Open')`.
  - Resolution: supplier action enum `[Pending, Replace, Credit Note, Partial Credit, Reject]` → sets `Status='Resolved', Supplier_Action, Resolved_By, Resolved_At, Remarks`, logs `Open→Resolved`. Status colors Open/Resolved/Cancelled.

### Tab: PR→PO (bound to pr_t2 AGAIN, L8053)
- Pulls approved PRs not yet linked: `tbl_purchase_requests pr JOIN tbl_pr_items pi WHERE pr.Status='Approved' AND (pi.PO_No IS NULL OR pi.PO_No='')`.
- Multiselect PRs to merge. **Blanket PO option:** checkbox → slider rounds (1–6, default 2), splits qty into rounds every ~7 days.
- **⚠️ PR→PO numbering is INLINE (L8119), NOT the helper:** `PO-{YYYYMMDD}-{COUNT(*) of ALL purchase_orders + 1:03d}`. **This differs from `_next_doc_no('PO')`** — helper counts only *today's* POs (per-day reset), but this counts *all-time* POs. **Two different PO numbering schemes coexist** → potential collisions. Flag loudly.
- `Total_Amount` = `Σ(Request_Qty × master Unit_Price)`. Remarks prefixed `[Blanket/{n}rounds]` if blanket.
- Lines → `tbl_po_items (…, Status='Open')`. Blanket → `tbl_po_deliveries (PO_No, Delivery_No, Item_ID, Scheduled_Qty=Request_Qty/n, Scheduled_Date, Status='Pending')` per round.
- Marks source PR item: `UPDATE tbl_pr_items SET PO_No=?, Status='Converted'`. Logs PO creation with source PR list.

### Tab: Doc Status Trail (pr_t6, L8159)
Filters by Doc Type (`PO/PR/GR/ST/MI`) and Doc No search. Reads `tbl_doc_status_log` (last 200 by `Changed_At DESC`). **PO tracker:** visual status-flow pills over `STATUS_FLOW = ['Draft','Pending','Approved','Received','Closed','Cancelled']` (✅ past / ▶ current / dim future), plus that PO's GRs and blanket delivery schedule.

### Tab: Suppliers (bound to pr_t5, labeled "GR", L8233)
- List (Active=1): expanders with star rating, inline edit form (Rating slider, Lead_Time_Days).
- **Add (RBAC-split):**
  - **Admin:** direct insert `tbl_suppliers VALUES (?,?,?,?,?,?,?,?,?,?)` = `(Supplier_ID, Name, Contact, Phone, Email, Address, Payment_Terms, Lead_Time_Days, Rating, Active=1)`. Payment terms enum `[Cash, Net 7/15/30/45/60]`. Plus a **pending supplier-request approval queue** (`tbl_supplier_requests Status='Pending'`) — approve generates `SUP-{timestamp}` ID and creates real supplier (default Rating 3.0).
  - **Non-admin:** submits to `tbl_supplier_requests (…, Status='Pending')`, sees own requests with status badges. **This is the RBAC gate: non-admins cannot create suppliers directly.**

---

## 4. IMAGES (`nav_images`) — L8375–8590

**Purpose:** Upload/manage product images, auto-renamed to Item_ID.

Uses `load_current_stock()` (different loader than `_get_current_stock_wh` — includes `Image_Path` column). Images stored in `{base_folder}/images/`.
- **Tab 1 (single):** select item → upload → preview → save. **On save (L8458): deletes ALL existing extensions (`jpg/jpeg/png` + uppercase) for that Item_ID first**, then writes `{Item_ID}.{ext}`. Clears `load_current_stock` cache.
- **Tab 2 (bulk-by-code):** multi-file upload, per-file Item_ID assignment dropdown, per-file save (same delete-old-then-write). Skips unassigned, reports saved/skipped counts.
- **Tab 3 (gallery):** grid of items with `Image_Path` (5 cols), per-image delete button (removes file + clears cache). Expander lists items without images.

⚠️ Image filename = Item_ID is the linkage convention (`get_image_path(item_id)` / `Image_Path`). Preserve the all-extension-cleanup-on-replace behavior.

---

## 5. MASTER DATA (`nav_masterdata`) — L8596–9136

**Purpose:** CRUD for the master item catalog. **Master is a CSV file at `master_path`, NOT a DB table** (critical architecture fact). `Shared_Data` dir at `{base_folder}/Shared_Data`.

Info KPIs: item count, distinct categories, last-modified time.

### Tab 1 — Upload Excel (L8636)
- **Required cols:** `Item_ID, Item_Description, Unit_Price, Stock_UOM`. **Optional:** `Category, Base_UOM, Conversion_Factor` (+ template adds Min/Max_Stock, Avg_Daily_Usage, Lead_Time_Days).
- Reads csv/xlsx. Validates required cols (errors with list of missing). Defaults injected: `Category='ทั่วไป', Base_UOM=Stock_UOM, Conversion_Factor=1`. Coerces `Item_ID→str.strip`, `Unit_Price`/`Conversion_Factor→numeric`.
- **Two modes (L8652):** **Replace all** (overwrite CSV) vs **Append/Update** (drop existing rows where `Item_ID` in new, concat new — i.e. upsert by Item_ID). Writes `utf-8-sig`. Clears `load_current_stock`.

### Tab 2 — View Current (L8727)
Search + category filter, formatted dataframe, CSV download.

### Tab 3 — Download Template (L8769)
- **Master template:** styled `.xlsx` (MasterData + Instructions sheets) with full Thai column descriptions. Navy fill = required cols, Teal = optional. Freeze panes, auto-width, borders. Template includes planning columns with Thai docs (e.g. Conversion_Factor "1000 (=1KG=1000G)").
- **`_make_styled_excel()` helper (L8892):** reusable styled-template generator.
- **4 additional templates** (each in an expander, all styled): Supplier import, Stocktake import, Purchase Request import, Sales Order upload (Thai column headers `รหัสสินค้า/ชื่อสินค้า/หน่วยใหญ่/จำนวนสั่ง_หน่วยใหญ่/หน่วยเล็ก/จำนวนสั่ง_หน่วยเล็ก/ประเภทครัว`). ⚠️ These templates encode the exact import contracts for other pages — column names are load-bearing (Thai SO headers especially).

### Tab 4 — Add/Edit/Delete (L9060)
Radio mode. **Add:** form, rejects duplicate Item_ID, appends row, writes CSV. **Edit:** select Item_ID, edit Description/Price/Stock_UOM/Base_UOM/Conversion_Factor/Category via masked `.loc` update. **Delete:** select + confirm, filters out row. All clear `load_current_stock` cache.

---

## 6. BOM MASTER (`nav_bom_master`) — L9146–9559

**Purpose:** Central recipe/BoM library with costing, multi-tenant push to customers, and customer-submission approval. 5 tabs.

### ⚠️ BoM costing math (parity-critical)
Per line (L9289 / L9544):
```
Qty_Buy_UOM = Qty_Use_UOM / Conv_Factor          # convert usage units back to purchase units
Line_Cost   = Qty_Buy_UOM * Unit_Cost            # Unit_Cost = master Unit_Price of the raw material
```
Per BoM (L9174–9179):
```
Raw_Cost      = Σ(Line_Cost)
Total/batch   = Raw_Cost + Labor_Cost + Overhead_Cost + Other_Cost
Cost_per_unit = Total / max(Yield_Qty, 0.001)
Gross_Margin% = (Selling_Price - Cost_per_unit) / max(Selling_Price, 0.001) * 100
```
Note `Conv_Factor` semantics: "1 buy-unit = N use-units" (1KG→1000G ⇒ Conv=1000). Min-clamps (`max(...,0.001)`) prevent div-by-zero — preserve.

### Tab 1 — BoM Library (L9161)
Lists `tbl_bom_master` (by `Created_At DESC`), per-BoM cost/margin recomputed live from `tbl_bom_master_lines`. Expander shows costing breakdown + line table. Delete cascades both header and lines.

### Tab 2 — Create/Edit (L9203)
- Select existing or "Create New". **Header insert: `INSERT OR REPLACE INTO tbl_bom_master (BoM_Code, Product_Name, Yield_Qty, Yield_UOM, Labor_Cost, Overhead_Cost, Other_Cost, Selling_Price, Notes, Created_At, Created_By)`.**
- Add materials: select from master, Buy_UOM/Use_UOM/Conv_Factor/Qty_Use. Computes `Qty_Buy`/`Line_Cost`, pulls `Unit_Cost` from master `Unit_Price`. Insert `tbl_bom_master_lines (BoM_Code, Item_ID, Item_Description, Buy_UOM, Use_UOM, Conv_Factor, Qty_Use_UOM, Qty_Buy_UOM, Unit_Cost, Line_Cost, Notes)`. Per-line delete.

### Tab 3 — Push to Customer (L9302) — multi-tenant
- Multiselect BoMs × multiselect customers (`tbl_customers.Customer_Name`).
- **Push (L9324):** for each (BoM × customer), **delete-then-insert** (idempotent) into `tbl_cust_bom` (header, with `Customer_Name` scoping + `Active=1`) and `tbl_cust_bom_lines`. ⚠️ **Customer scoping = `Customer_Name` string** (not an ID) on every customer BoM row/line — this is the multi-tenant key. Preserve exactly.

### Tab 4 — Customer Submissions (L9364) — approval flow
- Reads `tbl_bom_submissions` (customer-uploaded BoMs), filter by Status (`Pending/Approved/Rejected`). Drilldown to `tbl_bom_submission_lines`.
- **Approve (L9389):** copies submission → `tbl_bom_master` (`INSERT OR REPLACE`), deletes old master lines, copies `tbl_bom_submission_lines` → `tbl_bom_master_lines`, sets submission `Status='Approved'`. `Created_By` = the customer name. **Reject:** sets `Status='Rejected'`.

### Tab 5 — Import Excel (L9432)
- Generates a styled `.xlsx` template (crimson `9B111E` headers) with 3 sheets: `BoM_Header`, `BoM_Lines`, `คำอธิบาย` (instructions in Thai). Header cols: `BoM_Code, Product_Name, Yield_Qty, Yield_UOM, Labor_Cost, Overhead_Cost, Other_Cost, Selling_Price, Notes`. Line cols: `BoM_Code, Item_ID, Buy_UOM, Use_UOM, Conv_Factor, Qty_Use_UOM, Notes`.
- **Import (L9518):** reads both sheets. Headers → `INSERT OR REPLACE tbl_bom_master`. Lines → looks up master for `Unit_Price`/`Item_Description`, computes `Qty_Buy=Qty_Use/Conv`, `Line_Cost=Qty_Buy*Unit_Price`, inserts `tbl_bom_master_lines`. Skips rows missing BoM_Code or Item_ID. Reports counts.

---

## DB tables touched (read/written) in this range

| Table | Written by | Read by |
|---|---|---|
| `tbl_raw_inventory` | — (never updated here) | `_get_current_stock_wh` (latest snapshot) |
| `tbl_purchase_requests` | Planner (PR create, approve/reject) | Planner history, PR→PO |
| `tbl_pr_items` | Planner (lines), PR→PO (mark Converted, set PO_No) | PR→PO join |
| `tbl_purchase_orders` | Create PO, PR→PO, Approve/Reject, GR auto-close, Cancel | Dashboard, KPIs, GR, Doc Trail |
| `tbl_po_items` | Create PO, PR→PO; GR increments Received_Qty | PO PDF, GR, approve preview |
| `tbl_po_deliveries` | PR→PO (blanket schedule) | Doc Trail |
| `tbl_goods_receipt` | GR confirm | GR history, claims, Doc Trail, PO cancel-gate |
| `tbl_gr_items` | GR confirm | GR claims |
| `tbl_gr_claims` | Claim raise / resolve | Claim status |
| `tbl_stock_movements` | Goods Issue/Transfer, GR | Movement history, KPIs |
| `tbl_stocktake` | Stocktake save | Stocktake history, WH KPI |
| `tbl_lot_ledger` | GR confirm (per lot) | (read elsewhere) |
| `tbl_suppliers` | Add (admin), request-approve, edit | Create PO, PR→PO, KPIs |
| `tbl_supplier_requests` | Request submit, approve/reject | Pending queue, my-requests |
| `tbl_doc_status_log` | `_log_status`, cancel, PR→PO | Doc Trail |
| `tbl_bom_master` / `_lines` | BoM CRUD, import, submission-approve | Library, push |
| `tbl_cust_bom` / `_lines` | Push to customer | (customer pages) |
| `tbl_bom_submissions` / `_lines` | (customer pages) → approve/reject status | Submissions tab |
| `tbl_customers` | — | BoM push customer list |
| `master_path` (**CSV file**) | Master Data upload/add/edit/delete | `_load_master_df`, all pages |
| `{base_folder}/images/`, `/gr_claim_images/` (**filesystem**) | Image upload/delete, claim photos | gallery, claim evidence |

---

## Top parity risks (easy to silently drop in a rewrite)

1. **Three coexisting numbering schemes for the same doc family.** `_next_doc_no('PO')` resets per-day; PR→PO uses all-time `COUNT(*)`; PR & GRC use inline per-day `COUNT LIKE`. These produce different formats/collision behavior. A naive "unify the numbering" refactor will silently change document IDs.
2. **Procurement tab variable bindings are scrambled** (pr_t2 bound twice, pr_t7 unused, labels ≠ content). A faithful rewrite should target the *intended* label order, not the literal bindings — but must be a conscious decision.
3. **Stock is snapshot-based, not transactional.** Issues, transfers, stocktakes, and even GR do **not** mutate `tbl_raw_inventory`. The movement log / lot ledger / PO Received_Qty are the only live writes. Anyone "fixing" stock to be transactional changes the entire data model.
4. **Master data lives in a CSV file**, not the DB — and is upserted by `Item_ID`. All costing (BoM) and pricing (PO) reads `Unit_Price` from this CSV.
5. **i18n routing is by translated menu-label string equality** (`_menu_is`). Changing any TH/EN label breaks routing.
6. **RBAC gates:** PR approve, PO approve/reject, PO cancel-after-GR, direct supplier add — all gate on `role=='Admin'`. Non-admin supplier creation is a request→approve flow.
7. **Multi-tenant BoM scoping is by `Customer_Name` string** (not ID), via delete-then-insert idempotent push.
8. **Lot ledger only created when Lot_No is non-blank** at GR; expiry is free-text `dd/mm/yyyy`.
9. **Deadstock `dead_days` input is collected but unused** (latent bug) — decide whether to replicate or fix.
10. **QR payload string format** (`ITEM_ID:…|DESC:…|UOM:…|CAT:…|PRICE:…`) is the scanner contract — must be byte-stable for any QR-scanning counterpart.
11. **Image replace deletes all 6 extension variants** before writing; filename === Item_ID is the image-link convention.
12. **GR auto-closes PO** only when every line is fully received; partial → `'Received'`.