I now have the full picture of lines 9569-12878. Here is the exhaustive structured analysis.

---

# Feature Reverse-Engineering Report — ERPPOS_Invisible.py L9569-12878

Every page is dispatched by `_menu_is(menu, "nav_*")`. Every page opens its own `sqlite3.connect(db_path)` and closes it at the end. Common helpers used: `_wh_kpi(label,value,sub,bg,fg)` (HTML KPI card), `_load_master_df()` (master item catalog), `_log_status(prefix, doc_no, from, to, conn, note)` (status audit log), `make_hash(pw)` / `hashlib.sha256` (password hashing), `is_en = st.session_state.get("lang")=="EN"` (i18n switch), `st.session_state['username']` (audit user), `st.session_state['customer_name']` (multi-tenant scoping). `base_folder` is used for file uploads (POD images, campaign images).

**PARITY-CRITICAL GLOBAL PATTERN:** Almost every page is bilingual but the i18n is *inconsistent* — many strings are TH-only hardcoded (`st.info("ยังไม่มี...")`), captions, help text, and most success/error toasts. A rewrite that only ports `is_en ? EN : TH` ternaries will silently drop a large amount of Thai-only UI text. **Currency is always THB (฿), formatted `{:,.2f}` or `{:,.0f}`.**

---

## 1. AR — Accounts Receivable (`nav_ar`) L9569-9895

**Purpose:** Track customer invoices, receipts, aging, credit utilization.

**Auto-sync (`_sync_ar_invoices`) — PARITY-CRITICAL L9576-9599:** On every page load, generates AR invoices for any `tbl_sales_orders` with `Status IN ('Shipped','Completed')` that lack an invoice (`Order_No NOT IN (SELECT ... FROM tbl_ar_invoices)`). Invoice numbering: **`INV-{Order_No}`**. Due date = `Order_Date + Credit_Term days`, where credit term days are extracted from `tbl_customers.Credit_Term` by stripping non-digits (`''.join(filter(str.isdigit, ...))`, **default 30**). Inserts via `INSERT OR IGNORE INTO tbl_ar_invoices VALUES(11 positional cols)`: `(inv_no, Invoice_Date=Order_Date, Due_Date, Customer_Name, Order_No, Amount, Paid_Amount=0, Status='Unpaid', '', Created_By='system', Created_At)`.

**KPIs (5):** Total Invoices (SUM Amount), Collected (SUM Paid_Amount), Outstanding (SUM Amount-Paid where Status='Unpaid'), Overdue (count + value where Status='Unpaid' AND Due_Date<date('now')), Collection Rate (paid/total %).

**Tab 1 — Outstanding Invoices:** Filters: search (Customer_Name/Invoice_No/Order_No), Status multiselect (Unpaid/Partial/Paid), Customer multiselect, Overdue-only checkbox. Computes `Outstanding=Amount-Paid_Amount`, `Days_Due=now-Due_Date`. **Row color logic (PARITY):** Paid=green, Partial=amber, Days_Due>90=dark red w/white text, >30=red, >0=amber. CSV export (utf-8-sig BOM).

**Tab 2 — Record Receipt L9692-9751:** Form picks an Unpaid/Partial invoice. Records into `tbl_ar_receipts`. **Receipt numbering: `RCP-{YYYYMMDD}-{seq:03d}`** (seq = count of today's receipts +1). Payment methods: Transfer/Cash/Cheque/QR Code/Credit Card. On save: `new_paid = old + amt`; `Status = 'Paid' if new_paid>=Amount else 'Partial'`; updates `tbl_ar_invoices.Paid_Amount,Status`. Shows last 50 receipts.

**Tab 3 — AR Aging L9753-9829:** Buckets: Not Due / 1-30 / 31-60 / 61-90 / >90 Days (by Days_Due). Pivot table per-customer × bucket on Outstanding (`OS=Amount-Paid`), with TOTAL row. Aging bar chart + CSV export.

**Tab 4 — AR Analytics L9831-9893:** Top 10 outstanding customers (h-bar), invoice status pie, monthly collections trend, **Credit Utilisation** table: joins `tbl_customers` (Credit_Limit>0) with outstanding → `Utilisation_Pct`, status "🚨 Over Limit"/"⚠️ Near Limit"(>80%)/"✅ OK", shows Credit_Hold/Credit_Term.

**DB:** reads `tbl_sales_orders`, `tbl_customers`; reads/writes `tbl_ar_invoices`, `tbl_ar_receipts`.

---

## 2. Delivery Orders (`nav_delivery`) L9898-10040

**Purpose:** Create DOs from shipped orders, track delivery status, capture Proof-of-Delivery photos.

**KPIs (3):** Total DOs, Pending, Delivered.

**Tab 1 — DO List:** Search (DO_No/Customer/Driver), Status multiselect (Pending/In Transit/Delivered/Failed). Per-DO expander shows address/driver/vehicle/remarks + line items (`tbl_do_items`: Item_Description/Qty/UOM/Status). **Status update workflow (PARITY):** if not Delivered, selectbox to change status + **POD photo uploader** (jpg/jpeg/png). POD saved to `{base_folder}/pod_images/POD_{DO_No}_{timestamp}.{ext}`. On update: `UPDATE tbl_delivery_orders SET Status, Delivered_At(=timestamp only when Delivered else ''), POD_Image`. Delivered DOs show the POD image.

**Tab 2 — Create DO L9990-10039:** Source = distinct `tbl_sales_orders WHERE Status='Shipped'`. Multiselect orders. **DO numbering: `DO-{YYYYMMDD}-{seq:03d}`.** Inserts `tbl_delivery_orders` (11 positional cols: DO_No, DO_Date, Customer_Name, Address, Driver, Vehicle, Status='Pending', Delivered_At='', POD_Image='', Remarks, Created_By). Customer = first selected order's customer. For each selected order, copies its lines into `tbl_do_items (DO_No,Order_No,Item_ID,Item_Description,Qty,UOM)` from `tbl_sales_orders`.

**DB:** reads `tbl_sales_orders`; reads/writes `tbl_delivery_orders`, `tbl_do_items`. **Note:** DO does NOT decrement stock (delivery is informational).

---

## 3. Sales Returns / Credit Note (`nav_returns`) L10043-10158

**Purpose:** Process customer returns, optionally return goods to stock, create credit notes.

**Tab 1 — Create Return L10057-10138:** Source order = `tbl_sales_orders WHERE Status IN ('Completed','Shipped')`. Per-line: Return Qty (max = Order_Qty), **"Return to Stock" checkbox (default True)**. Return Type: Return / Credit Note / Exchange. Amount = ret_q × Unit_Price. **Return numbering: `RTN-{YYYYMMDD}-{seq:03d}`.**
- Inserts `tbl_sales_returns` (11 positional: Return_No, Return_Date, Customer, Order_No, Return_Type, Status='Approved', Total_Amount, Remarks, Created_By, Created_By(again), Created_At).
- Inserts each line to `tbl_return_items` (Return_No,Item_ID,Item_Description,Return_Qty,UOM,Unit_Price,Amount,Reason,Return_To_Stock).
- **PARITY-CRITICAL stock effect:** if Return_To_Stock flag set, inserts `tbl_stock_movements` with `Move_Type='Return'`, From_Location='Customer', To_Location='Warehouse', Ref_Doc=Order_No.
- Calls `_log_status('RTN', ret_no, '', 'Approved', conn, f"{ret_type} for {ret_ord_no}")`. Plays `st.balloons()`.

**Tab 2 — Return History:** Lists `tbl_sales_returns`; drill into line items by Return_No.

**DB:** reads `tbl_sales_orders`; writes `tbl_sales_returns`, `tbl_return_items`, `tbl_stock_movements`, status log.

---

## 4. Customer Price List (`nav_pricelist`) L10161-10266

**Purpose:** Special per-customer pricing / discount rules.

**Effective price formula (PARITY-CRITICAL, used in 2 places L10194 & L10251):** `Effective = Special_Price if Special_Price>0 else Base_Price*(1 - Discount_Pct/100)`. `Saving% = (Base-Effective)/Base*100`.

**Tab 1 — View:** Filters search + customer; shows Base/Special/Discount_Pct/Effective/Saving%/Min_Qty/Valid_From/Valid_To/Active.

**Tab 2 — Add Price Rule L10208-10244:** Customer dropdown includes **"All Customers"** (→ stored as empty `Customer_Name=''`). Item picked from `_load_master_df()`; Base Price auto-pulled from master `Unit_Price` (disabled field). Inputs: Special Price, Discount %, Min Qty (default 1), Valid From (today), Valid To (**today+365 days default**). Inserts `tbl_price_list` (List_Name default "Standard", Active=1).

**Tab 3 — Price Analysis:** Top-15 discount amounts by item (h-bar colored by customer), from `Active=1` rules.

**DB:** reads `tbl_price_list`, `tbl_customers`, master df; writes `tbl_price_list`.

---

## 5. Lot / Batch Tracking (`nav_lots`) L10269-10487

**Purpose:** Lot/batch ledger, expiry alerts, FIFO/FEFO picking guidance.

**Auto-sync (`_sync_lots`) — PARITY-CRITICAL L10278-10302:** Joins `tbl_gr_items` × `tbl_goods_receipt` where `Lot_No` is non-null/non-empty. For each (Lot_No,Item_ID,GR_No) not already in `tbl_lot_ledger`, inserts a ledger row: Location_ID hardcoded **`'WH-MAIN'`**, Qty_In=Received_Qty, Qty_Out=0, Balance=Received_Qty, Status='Active', Move_Date=GR_Date, Ref_Doc=GR_No, Created_By='system'.

**KPIs (4):** Active Lots (distinct Lot_No where Balance>0), Expiring within 30d, Expired (Expiry_Date<today and non-empty), Items Tracked.

**Tab 1 — Lot Ledger:** Last 500 rows. Filters: search, Status (Active/Consumed/Expired/Quarantine), Location. **Row color:** expired=red, ≤30d=amber, Balance≤0=grey. CSV export.

**Tab 2 — Lot Inquiry (trace):** Pick a lot → header card (expiry colored red if past) + movement table + cumulative-balance line chart (`Qty_In.cumsum() - Qty_Out.cumsum()`).

**Tab 3 — Expiry Alert:** Buckets Expired / 0-7d / 8-30d / >30d. Slider threshold (7-180, default 30). Colored table + CSV (`ExpiryAlert_{N}days.csv`).

**Tab 4 — FEFO/FIFO L10458-10485:** Pick item + mode (FEFO=order by Expiry_Date ASC / FIFO=Move_Date ASC). Lists lots Balance>0 with Pick_Order rank. FEFO recommended for food.

**DB:** reads `tbl_gr_items`, `tbl_goods_receipt`, master df; reads/writes `tbl_lot_ledger`.

---

## 6. Multi-Location Stock (`nav_locations`) L10490-10664

**Purpose:** Per-location stock map, inter-location transfers, location master.

**Auto-sync (`_sync_loc_stock`) — PARITY-CRITICAL L10500-10516:** **DELETES all `tbl_location_stock` then rebuilds** it by grouping `tbl_lot_ledger` by Location_ID/Item_ID/Lot_No, summing `Qty_In-Qty_Out`, inserting only rows with Qty>0. (Full-rebuild-on-load — destructive; any direct writes to tbl_location_stock would be lost.)

**Tab 1 — Overview:** Per-active-location (`tbl_locations WHERE Active=1`) expander with temp icon (🧊 Frozen / ❄️ Chilled / 🌡️ else), item/lot counts, stock-by-item. Full pivot "Stock Map" (Item × Location) with Blues gradient + CSV.

**Tab 2 — Stock Transfer L10568-10637:** From/To location (must differ), item (master), available lots at from_loc (or "All Lots"), Qty, Remarks. **Transfer Doc No: `TRF-{YYYYMMDDHHMMSS}`.** Effects: inserts `tbl_stock_movements` (Move_Type='Transfer', From/To_Location); **updates `tbl_lot_ledger` SET Location_ID=to_loc** (conditionally filtered by Lot_No if a specific lot chosen). Calls `_log_status('TRF', ...)`. Recent transfers list (last 30).

**Tab 3 — Manage Locations L10639-10663:** Add location: ID(unique), Name, Zone (Main/Cold/Dry/Staging/QC/Other), Type (Storage/Outbound/Inbound/Hold/Staging), Temperature (Ambient/Chilled/Frozen), Capacity, Notes. `INSERT OR IGNORE INTO tbl_locations` (8 positional, Active=1).

**DB:** reads `tbl_lot_ledger`, master df; reads/writes `tbl_locations`, `tbl_location_stock`, `tbl_stock_movements`, status log.

---

## 7. Promotions / Campaigns (`nav_promos`) L10666-10816

**Purpose:** Sales promotion rules (separate from Marketing campaigns).

**Tab 1 — Active Promotions:** `Is_Active = Active==1 AND Start_Date<=today<=End_Date`. Summary: Active/Upcoming/Expired counts. Radio filter All/Active/Upcoming/Expired. Promo type icons: Discount %=💯, Fixed Amount=💵, Buy X Get Y=🎁, Bundle=📦, Min Order=🛒, Free Shipping=🚚. Per-promo expander shows discount, min qty/amount, free item×qty, customer group, item IDs, category, **Usage `Used_Count/Max_Uses` (∞ if 0)**. Toggle Active button.

**Tab 2 — Create Promotion L10740-10786:** Promo ID(unique) + Name. Type (6 options above). Customer Group (All/Retail/Wholesale/VIP/New Customer). Start (today)/End (today+30d). Discount %, Fixed Discount ฿, Min Qty, Min Amount ฿, Free Item ID, Free Qty, Item IDs (comma-sep, blank=all), Category (blank=all), Max Uses (0=unlimited), Notes. **`INSERT INTO tbl_promotions VALUES(18 positional)`** — order: (Promo_ID, Promo_Name, Promo_Type, Start_Date, End_Date, Min_Qty, Min_Amount, Discount_Pct, Discount_Amt, Free_Item_ID, Free_Qty, Customer_Group, Item_IDs, Category, Max_Uses, Used_Count=0, Active=1, Notes).

**Tab 3 — Analytics:** Usage count bar (Used_Count>0), type-distribution pie.

**DB:** reads/writes `tbl_promotions`. **Note:** promo redemption/`Used_Count` increment is NOT done here (must happen in POS, outside this range).

---

## 8. Mobile Scanner (`nav_mobile`) L10819-11020

**Purpose:** Mobile/browser QR-barcode scanning into scan sessions, then commit to stock.

**Tab 1 — Scan & Record:** Picks an Open session (`tbl_scan_sessions WHERE Status='Open'`). Manual QR text input. **QR parse format (PARITY-CRITICAL L10872-10881):** pipe-delimited `KEY:VALUE` pairs, e.g. `ITEM_ID:P001|DESC:...|UOM:KG|PRICE:100|CAT:Dry`; if no `|`, whole string is Item_ID. Looks up master to enrich Description/Stock_UOM. Inputs: Qty, Lot No, Expiry, Action (GR-Receive In/Issue-Pick Out/Stocktake-Count/Transfer/Info Only). Action mapped to short codes GR/Issue/Stocktake/Transfer/Info. Inserts `tbl_scan_lines` (Confirmed=1).
- **Close & Commit (PARITY-CRITICAL L10937-10954):** for each scan line with Action in (GR/Issue/Transfer/Stocktake), inserts `tbl_stock_movements`: From_Location = 'Supplier' if GR else session location; To_Location = session location if GR else 'Issued'. Then `UPDATE tbl_scan_sessions SET Status='Closed', Closed_At`.

**Tab 2 — Scan Sessions:** History (last 50) + per-session line drill + CSV.

**Tab 3 — Session Setup L10980-11018:** Create session: Type (GR/Stocktake/Issue-Pick/Transfer/Cycle Count), Location (from `tbl_locations` Active, fallback `['WH-MAIN','WH-COLD','WH-FREEZE','WH-DRY']`), Reference Doc. **Session No: `SCAN-{YYYYMMDDHHMMSS}`**, Status='Open'. Includes TH usage guide + QR format reference.

**DB:** reads `tbl_locations`, master df; reads/writes `tbl_scan_sessions`, `tbl_scan_lines`, `tbl_stock_movements`.

---

## 9. Creditors / AP (`nav_creditors`) L11021-11417

**Purpose:** Vendor master + Accounts Payable invoice/payment tracking.

**KPIs (5):** Creditors (active/total), Total AP, Paid, Outstanding (Amount-Paid where Unpaid), Overdue Invoices (Unpaid & Due_Date<now).

**Tab 1 — Creditor List:** Filters search (ID/Name/Tax_ID/Contact), Category, Status (Active/Inactive). Per-creditor expander shows full contact/bank/terms + computed outstanding. **Inline edit form** (Payment_Terms, Credit_Limit, Notes) + Activate/Deactivate toggle.

**Tab 2 — Add Creditor L11161-11212:** Creditor ID(unique)+Name, Tax_ID, Category (Supplier/Service Provider/Contractor/Other), contact, bank, **Payment Terms (Cash/Net 7/15/30/45/60)**, Credit Limit, Currency (THB/USD/EUR/JPY). `INSERT INTO tbl_creditors VALUES(16 positional)` (Active=1, Created_At). Tip: creditors that are suppliers can share ID with Procurement→Suppliers (no enforced FK).

**Tab 3 — AP Transactions L11214-11343:** Record Invoice/Payment expander: Creditor, Txn Type (Invoice/Payment/Credit Note/Debit Note/Adjustment), Ref Doc (PO/GR No), Invoice No, Invoice Date, Due Date (default +30d), Amount, Paid Amount. **Txn numbering: `AP-{YYYYMMDD}-{seq:03d}`.** Status = Paid (paid≥amt) / Partial (paid>0) / Unpaid. Transaction list (last 200) with filters (search/type/status/period 30d/90d), summary metrics, **overdue row coloring**, "Mark Payment" (adds to Paid_Amount, recomputes status), CSV export.

**Tab 4 — AP Analytics L11345-11416:** Top-10 creditors by total AP, AP-by-status pie, **AP Aging** (same 5 buckets, by Due_Date) with bar + table (Days_Overdue Reds gradient).

**DB:** reads/writes `tbl_creditors`, `tbl_ap_transactions`.

---

## 10. Users / RBAC Admin (`nav_users`) L11419-11692 — PARITY-CRITICAL

**Purpose:** Full user & role-based access control management. **Highest parity risk in this range.**

**Roles:** `Admin, Sales, Customer, Warehouse, Procurement, Planner`. KPIs: total users, Admin+Sales count, Customer count. Uses global `ALL_PERMISSIONS` dict (`{key: (icon, label)}`) and `make_hash()`.

**Tab Add:** create user (Username, Password→`make_hash`, Role, and **if Role=Customer → "Link to Company" dropdown from `tbl_customers`; else Department text default "HQ"**). Stored in `tbl_users(Username, Password_Hash, Role, Customer_Name)`. Catches UNIQUE → "Username already exists".

**Tab Edit:** change Role/association/password (blank password = keep). Customer_Name column doubles as company link (Customer role) or department.

**Tab Permissions (individual override) L11519-11606 — PARITY-CRITICAL:**
- Per-user permission set stored as **comma-joined string in `tbl_users.Permissions`**.
- **Resolution order:** individual `Permissions` if non-empty, ELSE role defaults from `tbl_role_permissions`. (Override model.)
- `admin` user is excluded from selection.
- **`PERM_GROUPS` (L11558-11567) — the canonical permission taxonomy (must be preserved exactly):**
  - 🛍️ Customer Portal: `order_cust, cust_pos, cust_dash, cust_inventory, cust_bom, cust_variance, loyalty, survey, track`
  - 💼 My Business: `cust_my_crm, cust_my_suppliers, cust_my_pos, cust_my_users`
  - 💰 Sales & Orders: `pos, order_mgt, claim_mgt, crm, delivery, returns, pricelist, promos`
  - 📊 Dashboard & Analytics: `dashboard, exec, planner, marketing`
  - 🏭 Warehouse: `warehouse, lots, locations, mobile, images`
  - 💵 Finance & AR/AP: `ar, creditors`
  - 🛒 Procurement: `procurement`
  - ⚙️ Administration: `masterdata, users`
- Save writes sorted comma string; Reset writes `Permissions=''` (revert to role defaults). Guards against duplicate perm keys across groups (`seen_keys`).

**Tab Role Defaults L11608-11676:** Per-role checkbox grid over `ALL_PERMISSIONS`. **Admin is hardcoded full-access and cannot be restricted** ("Admin always has full access"). Saves to `tbl_role_permissions` via `INSERT OR REPLACE VALUES(Role, perm_str)`. Role colors/icons map present (Admin red, Sales blue, Customer green, Warehouse purple, Procurement orange, Planner teal).

**Tab Delete:** delete any user except `admin`.

**DB:** reads/writes `tbl_users`, `tbl_role_permissions`; reads `tbl_customers`.

---

## 11. Marketing Dashboard (`nav_marketing`) L11701-12182 — 9 tabs

**Tab 1 — Dashboard L11719-11777:** KPIs: active campaigns (Active=1 & in date window), campaign reads, unique customers reached, total revenue (฿M), active buyers. Charts: top-10 customers by revenue, sales-by-category pie, weekly revenue area trend.

**Tab 2 — Campaigns L11779-11864:** Create campaign. **Types: Popup / Ticker / Banner.** Fields: Campaign ID(unique)+Name, Type, Priority (higher=shown first), Content Text, Ticker Text, Image upload (→`{base_folder}/campaign_images/{id}_{name}`), Start/End (today/+30d), Target Type (All/Specific Customer/By Category Interest/By Spend Level), Target Value. Inserts `tbl_marketing_campaigns` (named cols, Active=1). Campaign list with **LIVE/Scheduled/Ended badge** + read count + Activate/Deactivate (by `id`).

**Tab 3 — Customer Insights L11866-11936 — PARITY-CRITICAL segmentation:** Builds RFM-lite profile (total_spend, order_count, item_count, last_order, Avg_Order, Days_Since). **`_segment` rules (L11888):** 🌟 VIP (Days≤30 & spend≥75th pct), 💰 Loyal (Days≤60 & orders≥3), 😴 At Risk (Days>90), 🆕 New (orders==1), else 👤 Regular. Segment pie + value-matrix scatter + per-customer item popularity.

**Tab 4 — Targeted Push L11938-11991:** Pick active campaign; target method (ทุกลูกค้า/หมวดสินค้า/ยอดซื้อ/Segment/ระบุรายชื่อ). Builds target customer list from `tbl_sales_orders`. On fire: `UPDATE tbl_marketing_campaigns SET Target_Type, Target_Value=','.join(first 100 custs)`. **TH-only UI** (no EN strings) — parity risk.

**Tab 5 — Campaign Log L11993-12031:** Joins `tbl_campaign_reads`×`tbl_marketing_campaigns`. Metrics, per-campaign interaction bar, log table + CSV.

**Tab 6 — A/B Testing L12034-12072:** Lists tests joining `tbl_ab_tests`×`tbl_ab_variants`; **CTR=Clicks/Impressions, CVR=Conversions/Impressions** per variant. Create test: Test ID+Name, Variant A (Control)/B (Treatment), Start/End (+14d). Writes `tbl_ab_tests` (Status='Running') + two `tbl_ab_variants` rows (A/B with Content_Text).

**Tab 7 — Loyalty Config L12074-12108 — PARITY-CRITICAL:** Single config row `tbl_loyalty_config WHERE id=1`. Fields: Enabled, **Points_Per_Baht (default 1.0), Baht_Per_Point (default 0.1), Min_Redeem (default 100), Expiry_Days (default 365, 0=no expiry)**. `INSERT OR REPLACE`. Shows all-customer points balances from `tbl_loyalty_points`.

**Tab 8 — Abandoned Carts L12110-12135:** Lists `tbl_abandoned_carts` (last 50). Metrics: total, recovered, **abandon rate = (1 - recovered/total)×100**. "Send Reminders to All Unrecovered" → sets `Notified_At` on Recovered=0 rows (reminder delivered as popup on next login).

**Tab 9 — Surveys L12137-12180:** Create survey: Survey ID+Name, Type (NPS/CSAT/Custom), Trigger (Post-Delivery/Monthly/Manual/Post-Purchase). Writes `tbl_surveys` (Active=1). Results: NPS histogram (avg), Q3 recommend pie, response table + CSV.

**DB:** reads `tbl_sales_orders`, `tbl_customers`; reads/writes `tbl_marketing_campaigns`, `tbl_campaign_reads`, `tbl_ab_tests`, `tbl_ab_variants`, `tbl_loyalty_config`, `tbl_loyalty_points`, `tbl_abandoned_carts`, `tbl_surveys`, `tbl_survey_responses`.

---

## 12. Loyalty (customer-facing) (`nav_loyalty`) L12190-12260

**Purpose:** Customer views/redeems loyalty points. Scoped to `st.session_state['customer_name']`.

**Gating:** if `tbl_loyalty_config.Enabled` is 0 → info message and stop. KPIs: Current Points (+฿ value = balance×Baht_Per_Point), Lifetime Earned, Redeem Rate. Tabs: history (`tbl_loyalty_txn`, green=earn/red=redeem) + redeem.
**Redeem (PARITY-CRITICAL L12241-12259):** must have balance ≥ Min_Redeem. redeem_val = pts × Baht_Per_Point. On redeem: `UPDATE tbl_loyalty_points SET Balance=balance-pts`; insert `tbl_loyalty_txn` (Txn_Type='Redeem', Points negative); **sets `st.session_state['loyalty_discount']=redeem_val`** (applied in POS next purchase — cross-page coupling). Points *earning* is not in this range (POS-side).

**DB:** reads/writes `tbl_loyalty_config`, `tbl_loyalty_points`, `tbl_loyalty_txn`.

---

## 13. Survey (customer-facing) (`nav_survey`) L12262-12297

**Purpose:** Customer answers active surveys. Scoped by customer_name. Shows surveys `Active=1 AND Survey_ID NOT IN (already-responded by this customer)`. Form: NPS slider (0-10, default 8), Q1 (best thing), Q2 (improve), Q3 recommend likelihood (แน่นอน/น่าจะแนะนำ/ไม่แน่ใจ/ไม่น่าจะแนะนำ/ไม่แนะนำ — **TH-only enum**), Comments. Writes `tbl_survey_responses`. Entirely TH UI.

**DB:** reads `tbl_surveys`; reads/writes `tbl_survey_responses`.

---

## 14. My Business Mini-ERP — Customer self-service (L12298-12503) — MULTI-TENANT CRITICAL

All four pages scope by `Owner_Customer = st.session_state['customer_name']`. TH-only UI.

- **`nav_cust_my_crm` L12301:** Customer's own customer book. `tbl_cust_my_customers (Owner_Customer, Customer_Name, Phone, Address, Notes)`. List/edit/delete + add.
- **`nav_cust_my_suppliers` L12347:** Customer's own suppliers. `tbl_cust_my_suppliers (Owner_Customer, Supplier_Name, Contact_Name, Phone, Address)`. List/delete + add.
- **`nav_cust_my_pos` L12383:** Customer issues external POs to their own suppliers (requires suppliers exist first). Session cart `my_po_cart`. **PO No: `MPO-{cust[:3].upper()}-{YYYYMMDDHHMMSS}`.** Writes `tbl_cust_my_pos` (7 positional: PO_No, Owner_Customer, PO_Date, Supplier_Name, Total_Amount, Status='Issued', Remarks) + `tbl_cust_my_po_items`.
- **`nav_cust_my_users` L12448 — RBAC sub-delegation, PARITY-CRITICAL:** Customer-admin creates sub-accounts for their staff (Role='Customer', same Customer_Name). **Password hashed inline with `hashlib.sha256` (NOT `make_hash`)** — verify both hashing paths are compatible in a rewrite. Permission bundles built from checkboxes: base `['cust_dash','track']`; +order→`order_cust,cust_inventory`; +pos→`cust_pos`; +bom→`cust_bom,cust_variance`; +erp→`cust_my_crm,cust_my_suppliers,cust_my_pos`; +admin→`cust_my_users`. Access-level label derived from perms (👑 ผู้ดูแลร้าน / 🏪 พนักงานขาย / 👤 พนักงานทั่วไป). Delete scoped to same customer & Role='Customer'.

**DB:** `tbl_cust_my_customers`, `tbl_cust_my_suppliers`, `tbl_cust_my_pos`, `tbl_cust_my_po_items`, `tbl_users` (filtered by Customer_Name + Role='Customer').

---

## 15. CRM — Customer master (`nav_crm`) L12504-12611

**Purpose:** Internal customer master (distinct from My-CRM). KPIs: customers, with-orders, total revenue. Tabs Add/View-Edit/Delete.
**Add (PARITY):** Company Name(req), Tax_ID, Contact, Phone, Email, **Credit Term (Cash/Net 7/15/30/45/60)**, **Credit Limit (0=unlimited)**, **Credit Hold checkbox (ระงับการสั่งซื้อ — blocks ordering)**, Address. `INSERT OR REPLACE INTO tbl_customers(...Credit_Term,Credit_Limit,Credit_Hold)`. These credit fields feed AR credit-utilization and POS credit-hold enforcement. View/edit (Tax_ID, Address only). Delete preserves orders.

**DB:** reads/writes `tbl_customers`; reads `tbl_sales_orders`.

---

## 16. AI Assistant (`nav_ai_chat`) L12614-12878 — (bonus, end of range)

**Purpose:** In-app Claude chat over ERP data. Requires `anthropic` SDK + `ANTHROPIC_API_KEY` (env or text input). Uses `ERPAgent` from `agents.erp_agent` (cached in session as `erp_agent_instance`). Defines 5 tools (`get_sales_summary, get_stock_levels, get_recent_orders, get_top_products, get_customer_summary`) each backed by real SQLite queries on `tbl_sales_orders` / `tbl_raw_inventory`. Note `get_stock_levels` uses fallback reorder threshold `stock<10` and latest `Generate_Date`. Quick-prompt buttons (TH). Keeps last 20 history turns. Handles `AuthenticationError` → sets `ai_key_invalid`. **Note:** there is a local `_AI_TOOLS`/`_exec_ai_tool` defined but the actual run path uses `ERPAgent.chat()` — the inline executor appears partly vestigial.

---

# Document Numbering Schemes (consolidated — parity-critical)
| Doc | Format | Source line |
|---|---|---|
| AR Invoice | `INV-{Order_No}` | 9585 |
| AR Receipt | `RCP-{YYYYMMDD}-{seq:03d}` | 9729 |
| Delivery Order | `DO-{YYYYMMDD}-{seq:03d}` | 10018 |
| Sales Return | `RTN-{YYYYMMDD}-{seq:03d}` | 10111 |
| Stock Transfer | `TRF-{YYYYMMDDHHMMSS}` | 10607 |
| Scan Session | `SCAN-{YYYYMMDDHHMMSS}` | 10995 |
| AP Transaction | `AP-{YYYYMMDD}-{seq:03d}` | 11255 |
| Customer external PO | `MPO-{cust[:3].upper()}-{YYYYMMDDHHMMSS}` | 12420 |

`seq` patterns = `COUNT(*) WHERE Doc LIKE '{prefix}-{today}%' + 1` — **not gap-safe / not concurrency-safe** (race on concurrent users). Preserve the exact prefixes; consider a sequence table in rewrite but match displayed format.

# Status workflows
- **AR/AP invoice:** Unpaid → Partial → Paid (auto by paid_amount vs amount).
- **Delivery Order:** Pending → In Transit → Delivered / Failed (POD required photo optional; Delivered_At stamped only on Delivered).
- **Return:** created directly as 'Approved'.
- **Scan Session:** Open → Closed (commit to stock_movements on close).
- **Promotion/Campaign:** Active flag + date window → Live/Scheduled/Ended derived, not stored.
- **A/B Test:** 'Running' on create.

# Things easy to silently drop in a rewrite (flagged)
1. **Auto-sync side effects on page load** (`_sync_ar_invoices`, `_sync_lots`, `_sync_loc_stock`). `_sync_loc_stock` **DELETEs and rebuilds** `tbl_location_stock` every load — purely derived table.
2. **Credit-term digit extraction** (`filter(str.isdigit)`, default 30) for AR due dates.
3. **Effective-price formula** (Special_Price overrides discount %), duplicated in 2 tabs — keep consistent.
4. **Return-to-stock flag → stock_movements** insertion; DOs do NOT move stock but Returns/Transfers/Scan-commit do.
5. **RBAC override model**: individual `Permissions` string overrides role defaults; empty string = inherit; Admin always-full hardcoded. The exact `PERM_GROUPS` key taxonomy and `ALL_PERMISSIONS` keys are load-bearing for menu gating.
6. **Two different password hashers** (`make_hash` in admin user mgmt vs raw `hashlib.sha256` in customer sub-user creation) — must produce identical hashes or sub-users can't log in.
7. **Cross-page session coupling:** `st.session_state['loyalty_discount']` set on redeem, consumed by POS later.
8. **Loyalty config single-row (id=1)** with `INSERT OR REPLACE`; gating of `nav_loyalty` on `Enabled`.
9. **Marketing customer segmentation thresholds** (`_segment`) and **abandon-rate formula**.
10. **Multi-tenant scoping** via `Owner_Customer`/`Customer_Name` on every My-Business and customer-facing page — dropping the WHERE clause leaks tenants.
11. **Positional `INSERT ... VALUES(?,...)`** in several places (AR invoice 11 cols, DO 11, Return 11, Promotion 18, Creditor 16, My-PO 7) — column order is implicit and must match the schema exactly; named-column inserts are used elsewhere (mixed style).
12. **Heavy Thai-only UI** in Marketing tab4, Survey, Loyalty customer view, and all My-Business pages (no `is_en` branches) — these will look "untranslated" but are intentional; a rewrite must keep TH text.