I have everything needed. `tbl_raw_inventory` is an append-only ETL landing table from Outlook email attachments (HAVI/DAI stock reports), snapshotted by `Generate_Date`. Current stock = latest snapshot. This is the foundational fact confirming the denormalization. Producing the final structured output now.

---

# COMPLETE DATA MODEL — Oshinei Enterprise ERP (Legacy SQLite → Postgres target)

## 0. Cross-cutting facts (parity-critical — easy to silently drop)

- **Backend:** Single SQLite file `Inventory_Master_DB.sqlite` (210 MB; `tbl_raw_inventory` alone = **1,486,886 rows**). 65 `tbl_*` tables + `sqlite_sequence`. Schema is created idempotently via `CREATE TABLE IF NOT EXISTS` in `ERPPOS_Invisible.py` lines **608–1444** (`init_db`).
- **Dual user store:** `tbl_users` exists in **both** SQLite and Postgres. `user_store.py` switches on `USERS_DB_URL`/`DATABASE_URL`/`DATABASE_PUBLIC_URL`. **Postgres returns lowercase column names** (`username`, `role`, `customer_name`, `permissions`) and `_pg_row_to_dict` (user_store.py:73) normalizes back to `Title_Case`. A clean Postgres schema must standardize casing once — the lowercase/PascalCase duality is a live foot-gun. Default admin differs by backend: SQLite seed vs PG seed = `admin/admin123`, `Role='Admin'`, `Customer_Name='HQ'`.
- **No real FKs anywhere.** All relationships are by-name/by-code string joins. Almost every "foreign key" is a **TEXT business code or a name string**, not an integer id. Most child tables use a synthetic `id INTEGER PRIMARY KEY AUTOINCREMENT` and store the parent's *document number* as TEXT.
- **Multi-tenant scoping is by string `Customer_Name`**, not a tenant id. Customer-portal tables filter `WHERE Customer_Name = ?` (e.g. lines 4069, 4178, 4760, 5106, 5253). A second scoping column **`Owner_Customer`** is used by the `tbl_cust_my_*` "tenant-runs-their-own-mini-ERP" tables (lines 1428–1441). **Two different scoping column names for the same concept** — unify to `tenant_id` FK in Postgres.
- **i18n:** `_LANG = {"TH": {...}, "EN": {...}}` dict at line 45; helper `t(key, lang)` at line 232 falls back to **Thai default** (`_LANG.get(lang, _LANG["TH"])`). Real data contains Thai (UTF-8). `tbl_notifications` is the **only table with a denormalized translation column** (`message` + `message_en`); all other localization is UI-layer only. Parity risk: Thai is the default language, not English.
- **RBAC:** Two-layer. `tbl_role_permissions` (role → CSV permission string) is the template; `tbl_users.Permissions` is a **per-user CSV override** (serialized comma-joined string, e.g. `cust_bom,cust_dash,cust_inventory,...`). Permission tokens gate sidebar nav keys (`nav_*`). Should become a proper `permissions` table + `role_permissions`/`user_permissions` join tables with an enum of permission tokens.
- **Document numbering:** Helper `_next_doc_no(prefix, conn)` (line 2251) → `f"{PREFIX}-{YYYYMMDD}-{NNN:03d}"` where NNN = `count of same-day docs + 1` (**race-prone, not atomic** — concurrent inserts collide; replace with a sequence/serial in Postgres). It only maps **PO, GR, ST, MI**; every other prefix is hand-rolled inline (PR, DO, RCP, GRC, SUP, SALE, PRD, PND, MPO, SO, INV, TRF) with inconsistent formats (some `-NNN`, some `%Y%m%d%H%M%S` timestamps, some name-prefixed). Numbering schemes table below.
- **Status workflows** are free-text TEXT columns with code-enforced values (no CHECK constraints) → should be Postgres enums.

### Document-numbering schemes (parity-critical)
| Prefix | Format | Source line | Doc |
|---|---|---|---|
| `PO-` | `PO-YYYYMMDD-NNN` (also `count+1`) | 2251, 8119 | Purchase Order |
| `GR-` | `GR-YYYYMMDD-NNN` | 2251 | Goods Receipt |
| `ST-` | `ST-YYYYMMDD-NNN` | 2251 | Stocktake |
| `MI/TRF-` | `TRF-YYYYMMDDHHMMSS` | 10607 | Stock Movement / transfer |
| `PR-` | `PR-YYYYMMDD-NNN` | 6817–6822 | Purchase Request |
| `DO-` | `DO-YYYYMMDD-NNN` | 10015–10018 | Delivery Order |
| `RCP-` | `RCP-YYYYMMDD-NNN` | 9726–9729 | AR Receipt |
| `GRC-` | `GRC-YYYYMMDD-NNN` | 7993–7997 | GR Claim |
| `INV-` | `INV-{Order_No}` (1:1 derived) | 9585 | AR Invoice |
| `SUP-` | `SUP-YYYYMMDDHHMMSS` | 8310 | Supplier id |
| `SO-` | `SO-YYYYMMDD-HHMM` | 2900 | Sales Order |
| `SALE-` | `SALE-{Cust[:4]}-YYYYMMDDHHMMSS` | 4988 | Customer-POS sale |
| `PRD-` | `PRD-{Cust[:4]}-YYYYMMDDHHMMSS` | 5805 | Production run |
| `PND-` | `PND-{Cust[:6]}-YYYYMMDDHHMMSS` | 4090 | Pending/auto-reorder |
| `MPO-` | `MPO-{Cust[:3]}-YYYYMMDDHHMMSS` | 12420 | Tenant's external PO |

---

## 1. Inventory / Stock

### `tbl_raw_inventory` — **central item + stock fact table (ETL landing, append-only)**
- **Purpose:** Append-only snapshot feed loaded from Outlook email CSV/XLSX attachments (subject `Stock_Inventory_HAVI_DAI`) by `Init_Historical_DB.py` (`to_sql(..., if_exists='append')`). This is the **system's stock source of truth** AND the de-facto **item master** (there is no separate item/product master table).
- **Columns:** `BU_ID`, `Item_ID`, `Item_Description`, `UOM`, `Generate_Date` (TIMESTAMP, snapshot key), `Temperature_Type`, **`Expired Date`** (column name literally contains a space — quirk), `AV_QTY` (available), `Delivery_QTY` (INTEGER), `Total_Stock`.
- **No PK, no index** on 1.48M rows. "Current stock" = `WHERE Generate_Date = (SELECT MAX(Generate_Date) ...) GROUP BY Item_ID, Item_Description` (line 1525, cached 60 s). Every stock read aggregates the latest snapshot live.
- **Parity-critical drops:** the `"Expired Date"` space-name; mixed PascalCase; `BU_ID`/`Temperature_Type` carry HAVI business-unit + cold-chain semantics; `Days_to_Expire` is **dropped on load** (Init line 79). In Postgres: split into `items` master (dedup `Item_ID`) + a partitioned `stock_snapshots` fact table; `Item_ID` becomes the universal FK every other table references by string today.
- **Relationships:** `Item_ID` is referenced (as TEXT, unjoined) by virtually every line table below.

### `tbl_stock_movements` — manual stock moves / transfers (0 rows)
`id` PK; `Move_Date`, `Doc_No` (TRF-…), `Move_Type`, `Item_ID`, `Item_Description`, `UOM`, `Qty`, `From_Location`→`To_Location` (→`tbl_locations.Location_ID`), `Ref_Doc`, `Remarks`, `Created_By`. `Move_Type` & locations should be enums/FKs.

### `tbl_stocktake` — physical count vs system (0 rows)
`id` PK; `ST_No` (doc), `ST_Date`, `Item_ID`, `Item_Description`, `UOM`, `System_Qty`, `Physical_Qty`, `Difference`, `Counted_By`, `Status` DFLT `Draft`, `Remarks`. Status enum: Draft/Posted.

### `tbl_locations` — warehouse/bin master (6 rows)
`Location_ID` PK (e.g. `WH-MAIN`, `WH-COLD`); `Location_Name`, `Zone` DFLT `Main`, `Type` DFLT `Storage`, `Capacity`, `Temperature` DFLT `Ambient` (Ambient/Chilled — cold-chain, ties to `Temperature_Type`), `Active`, `Notes`.

### `tbl_location_stock` — per-location, per-lot balance (0 rows)
`id` PK; `Location_ID`(FK), `Item_ID`, `Item_Description`, `Lot_No`(→lot_ledger), `Qty`, `UOM`, `Expiry_Date`, `Last_Updated`. Denormalizes Item_Description.

### `tbl_lot_ledger` — lot/batch ledger, FEFO + expiry (0 rows)
`id` PK; `Lot_No`, `Item_ID`, `Item_Description`, `UOM`, `Location_ID` DFLT `WH-MAIN`, `GR_No`(→goods_receipt), `Qty_In`/`Qty_Out`/`Balance`, `Mfg_Date`, `Expiry_Date`, `Status` DFLT `Active` (Active/Expired/Quarantine), `Move_Date`, `Ref_Doc`, `Created_By`. Drives expiry/FEFO; `Status` enum.

### `tbl_scan_sessions` / `tbl_scan_lines` — QR/barcode mobile scanning (0/0)
- **scan_sessions:** `id` PK; `Session_No`, `Session_Type`, `Location_ID`, `Doc_Ref`, `Status` DFLT `Open`, `Created_By`, `Created_At`, `Closed_At`.
- **scan_lines:** `id` PK; `Session_No`(→), `Scanned_At`, `QR_Data` (raw payload), `Item_ID`, `Item_Description`, `Lot_No`, `Expiry_Date`, `Qty` DFLT 1, `UOM`, `Action`, `Location_ID`, `Confirmed` DFLT 0. Mobile companion (`mobile/` app). `Action`/`Session_Type` enums.

---

## 2. Sales / POS

### `tbl_sales_orders` — B2B sales order lines + claim tracking (9 rows)
- **Purpose:** Main B2B order table. **One row per order line (denormalized — header fields repeat per line; NO PRIMARY KEY)**. `Order_No` repeats across lines.
- **Columns:** `Order_No`, `Order_Date`, `Customer_Name`(→customers), `Item_ID`, `Item_Description`, `Order_Qty`, `Stock_UOM`, `Unit_Price`, `Total_Price`, `Status`, `Estimated_Delivery`, `Received_Qty`, `Claimed_Qty`, `Claim_Reason`, `Claim_Image_Path`, `Admin_Claim_Status` DFLT `Waiting`, `Reject_Reason`.
- **Parity-critical:** Embeds a **claims sub-workflow inside the order line** (Claimed_Qty/Claim_Reason/Claim_Image_Path/Admin_Claim_Status). Status workflow seen in code: `Shipped`, `Approved`/`Rejected` claim states (lines 1903–1913). Split into `orders` header + `order_lines` + `order_claims` in Postgres; add PK.

### `tbl_cust_pos_sales` / `tbl_cust_pos_items` — customer-portal POS (retail) (1/1)
- **sales (header):** `id` PK; `Sale_No` (SALE-…), `Sale_Date`, `Customer_Name` (tenant), `Subtotal`, `Discount`, `Tax_Amount`, `Total`, `Payment_Method` DFLT `Cash` (Cash/QR Code/…), `Points_Used`, `Points_Earned` (loyalty integration), `Status` DFLT `Completed`, `Notes`, `Created_By`. **Tax_Amount stored as raw float (7% VAT computed inline, e.g. 75.6 on 1080).**
- **items (lines):** `id` PK; `Sale_No`(→), `Item_ID`, `Item_Description`, `Qty`, `UOM`, `Unit_Price`, `Discount_Pct` DFLT 0, `Amount`, `Is_Custom` DFLT 0 (ad-hoc non-catalog line). On sale: decrements `tbl_customer_inventory.Current_Stock` and accrues/redeems loyalty (lines 5006–5020).

### `tbl_sales_returns` / `tbl_return_items` — returns & credit notes (0/0)
- **returns (header):** `Return_No` PK; `Return_Date`, `Customer_Name`, `Order_No`(→), `Return_Type` DFLT `Return`, `Status` DFLT `Draft`, `Total_Amount`, `Remarks`, `Approved_By`, `Created_By`, `Created_At`.
- **return_items:** `id` PK; `Return_No`(→), `Item_ID`, `Item_Description`, `Return_Qty`, `UOM`, `Unit_Price`, `Amount`, `Reason`, `Return_To_Stock` DFLT 1 (restock flag). Return_Type/Status enums.

### `tbl_pending_orders` / `tbl_pending_order_items` — auto-reorder drafts (0/0)
- **pending:** `id` PK; `Pending_No` (PND-…), `Customer_Name`, `Created_At`, `Status` DFLT `Draft`, `Trigger_Type` DFLT `Auto`, `Total_Items`, `Notes`.
- **items:** `id` PK; `Pending_No`(→), `Item_ID`, `Item_Description`, `Suggested_Qty`, `Final_Qty`, `UOM`, `Unit_Price`, `Trigger_Reason`. Generated when `tbl_customer_inventory.Current_Stock < Reorder_Point` (line 4069). Trigger_Type Auto/Manual enum.

---

## 3. Procurement

### `tbl_purchase_requests` / `tbl_pr_items` — PR (0/0)
- **PR (header):** `PR_No` PK; `PR_Date`, `Requested_By`, `Status` DFLT `Draft`, `Approved_By`, `Approved_At`, `Remarks`, `Priority` DFLT `Normal`.
- **pr_items:** `id` PK; `PR_No`(→), `Item_ID`, `Item_Description`, `Request_Qty`, `UOM`, `Required_Date`, `Reason`, `PO_No` DFLT `''` (link once converted to PO), `Status` DFLT `Open`. PR→PO conversion tracked via `PO_No` backref. Priority/Status enums.

### `tbl_purchase_orders` / `tbl_po_items` — PO (0/0)
- **PO (header):** `PO_No` PK; `PO_Date`, `Supplier`(name string, not Supplier_ID), `Status` DFLT `Draft`, `Approved_By`, `Approved_At`, `Remarks`, `Total_Amount`, `Created_By`, `Expected_Date`. Status workflow: Draft→(Approved)→Received.
- **po_items:** `id` PK; `PO_No`(→), `Item_ID`, `Item_Description`, `Order_Qty`, `Unit_Price`, `UOM`, `Amount`, `Received_Qty` DFLT 0, `Status` DFLT `Open` (Open/Partial/Closed). **`Supplier` stored as name, not FK to `tbl_suppliers.Supplier_ID` — naming/normalization gap.**

### `tbl_po_deliveries` — split/scheduled deliveries per PO (0 rows)
`id` PK; `PO_No`(→), `Delivery_No` (INTEGER seq within PO), `Item_ID`, `Scheduled_Qty`, `Scheduled_Date`, `Received_Qty` DFLT 0, `Status` DFLT `Pending`. Supports staggered receipts.

### `tbl_goods_receipt` / `tbl_gr_items` — GRN (0/0)
- **GR (header):** `GR_No` PK; `GR_Date`, `PO_No`(→), `Supplier`, `Received_By`, `Remarks`.
- **gr_items:** `id` PK; `GR_No`(→), `PO_No`, `Item_ID`, `Item_Description`, `PO_Qty`, `Received_Qty`, `UOM`, `Lot_No` (creates `tbl_lot_ledger` entry), `Expiry_Date`, `Unit_Cost`, `Remarks`. GR posting feeds lot ledger + location stock.

### `tbl_gr_claims` — supplier quality/shortage claims at receipt (0 rows)
`id` PK; `Claim_No` (GRC-…), `Claim_Date`, `GR_No`(→), `PO_No`, `Supplier`, `Item_ID`, `Item_Description`, `GR_Qty`, `Claim_Qty`, `UOM`, `Reason`, `Image_Path` (photo evidence), `Status` DFLT `Open`, `Supplier_Action`, `Resolved_By`, `Resolved_At`, `Remarks`. Status enum Open/Resolved.

### `tbl_suppliers` — supplier master (0 rows)
`Supplier_ID` PK; `Supplier_Name`, `Contact`, `Phone`, `Email`, `Address`, `Payment_Terms` DFLT `Cash`, `Lead_Time_Days` DFLT 3, `Rating` DFLT 3.0, `Active`. **Underused: PO/GR reference supplier by name string, bypassing this PK.**

### `tbl_supplier_requests` — supplier-onboarding approval queue (0 rows)
`id` PK; `Req_Date`, `Supplier_Name`, `Contact`, `Phone`, `Email`, `Address`, `Payment_Terms`, `Lead_Time_Days`, `Requested_By`, `Status` DFLT `Pending`, `Approved_By`, `Approved_At`, `Remarks`. On approval → inserts `tbl_suppliers` (`SUP-…` id, line 8310).

---

## 4. Finance — AR / AP

### `tbl_ar_invoices` — customer invoices (0 rows)
`Invoice_No` PK (= `INV-{Order_No}`, 1:1 derived from order); `Invoice_Date`, `Due_Date`, `Customer_Name`(→), `Order_No`(→sales_orders), `Amount`, `Paid_Amount`, `Status` DFLT `Unpaid` (Unpaid/Partial/Paid — used in aging at line 2885), `Remarks`, `Created_By`, `Created_At`. Outstanding AR = `SUM(Amount-Paid_Amount) WHERE Status IN ('Unpaid','Partial')`. Drives `tbl_customers.Outstanding_AR` and credit-hold checks.

### `tbl_ar_receipts` — customer payments (0 rows)
`id` PK; `Receipt_No` (RCP-…), `Receipt_Date`, `Customer_Name`, `Invoice_No`(→), `Amount`, `Method` DFLT `Transfer`, `Ref_No`, `Remarks`, `Created_By`, `Created_At`. Applying a receipt increments invoice `Paid_Amount`. Method enum.

### `tbl_creditors` — AP vendor/creditor master (0 rows)
`Creditor_ID` PK; `Creditor_Name` NOTNULL; `Tax_ID`, `Contact_Name`, `Phone`, `Email`, `Address`, `Bank_Name`, `Bank_Account`, `Payment_Terms` DFLT `Net 30`, `Credit_Limit`, `Currency` DFLT `THB`, `Category` DFLT `Supplier`, `Active`, `Notes`. **Parallel to `tbl_suppliers`** (overlapping vendor concept — consolidate in Postgres). Category enum.

### `tbl_ap_transactions` — AP ledger (0 rows)
`id` PK; `Txn_No`, `Creditor_ID`(→)/`Creditor_Name` (both stored — denorm), `Ref_Doc`, `Txn_Type` (Invoice/Payment), `Invoice_No`, `Invoice_Date`, `Due_Date`, `Amount`, `Paid_Amount`, `Currency` DFLT `THB`, `Status` DFLT `Unpaid`, `Remarks`, `Created_By`, `Created_At`. Txn_Type/Status/Currency enums.

> Note: no GL/journal/chart-of-accounts tables — finance is sub-ledger (AR/AP) only. P&L/KPIs are computed in `erp_mcp/tools/finance_tools.py`, not stored.

---

## 5. BOM / Production

### `tbl_bom_master` / `tbl_bom_master_lines` — central recipe library (0/0)
- **master:** `BoM_Code` PK; `Product_Name`, `Yield_Qty` DFLT 1, `Yield_UOM`, `Labor_Cost`, `Overhead_Cost`, `Other_Cost`, `Selling_Price`, `Notes`, `Created_At`, `Created_By`.
- **lines:** `id` PK; `BoM_Code`(→), `Item_ID`, `Item_Description`, `Buy_UOM`/`Use_UOM`, `Conv_Factor` DFLT 1 (UOM conversion — **parity-critical** dual-UOM costing), `Qty_Use_UOM`, `Qty_Buy_UOM`, `Unit_Cost`, `Line_Cost`, `Notes`. Costed cost-roll-up: Line_Cost = Qty_Buy × Unit_Cost; total = Σlines + Labor + Overhead + Other.

### `tbl_bom_submissions` / `tbl_bom_submission_lines` — tenant→HQ BOM approval (3/0)
- **submissions:** `id` PK; `BoM_Code`, `Customer_Name`, `Product_Name`, `Yield_Qty`, `Yield_UOM`, cost fields, `Selling_Price`, `Notes`, `Submitted_At`, `Status` DFLT `Pending`. Customer-portal BOMs submitted for HQ approval → promoted to master/cust_bom. Status enum Pending/Approved/Rejected. **Only BOM table with live data.**
- **submission_lines:** mirror of master_lines + `Customer_Name`.

### `tbl_cust_bom` / `tbl_cust_bom_lines` — tenant's active recipes (0/0)
- **cust_bom:** `id` PK; `BoM_Code`, `Customer_Name` (tenant), `Product_Name`, `Product_Item_ID`, `Yield_Qty`, `Yield_UOM`, cost fields, `Selling_Price`, `Active` DFLT 1, `Notes`, `Created_At`.
- **cust_bom_lines:** same shape as bom lines + `Customer_Name`. Per-tenant production recipes (queried 5253, 5491, 5757).

### `tbl_cust_prod_runs` / `tbl_cust_prod_items` — production execution (0/0)
- **prod_runs:** `id` PK; `Run_No` (PRD-…), `BoM_Code`(→cust_bom), `Customer_Name`, `Run_Date`, `Batch_Qty` DFLT 1, `Status` DFLT `Completed`, `Total_Cost`, `Created_By`.
- **prod_items:** `id` PK; `Run_No`(→), `Item_ID`, `Item_Description`, `Theoretical_Qty`, `Actual_Qty`, `Variance`, `UOM`. Running a batch consumes `tbl_customer_inventory` (decrement ingredients, increment finished good, lines 5818–5831).

### `tbl_cust_variance` — theoretical-vs-actual yield variance (0 rows)
`id` PK; `Var_Date`, `Customer_Name`, `Item_ID`, `Item_Description`, `BoM_Code`, `Theoretical_Use`, `Actual_Use`, `Variance`, `Variance_Pct`, `UOM`, `Reason`, `Shift` DFLT `Day` (Day/Night enum — food-production shift analytics).

---

## 6. Customer-Portal Multi-Tenant

> Tenant scoping column is **`Customer_Name`** for portal-as-buyer tables and **`Owner_Customer`** for the "tenant runs their own mini-ERP" `cust_my_*` tables. These two names are the central multi-tenant key — must map to one `tenant_id` FK.

### `tbl_customers` — customer/tenant master (2 rows)
`Customer_Name` **PK (the tenant key — a name, not an id; parity-critical)**; `Contact_Name`, `Phone`, `Email`, `Credit_Term`, `Tax_ID`, `Address`, `Credit_Limit`, `Credit_Hold` DFLT 0, `Outstanding_AR` DFLT 0 (denormalized cached AR balance). Credit-hold gating enforced at order entry (line 2873).

### `tbl_customer_items` — tenant product catalog (0 rows)
`id` PK; `Customer_Name`, `Item_ID`, `Item_Name`, `Category`, `Unit_Price`, `UOM`, `Description`, `Created_At`, `Synced_Central` DFLT 1 (flag: pushed to HQ master).

### `tbl_customer_inventory` — tenant stock + reorder rules (0 rows)
`id` PK; `Customer_Name`, `Item_ID`, `Item_Description`, `UOM`, `Current_Stock`, `Reorder_Point`, `Reorder_Qty`, `Last_Updated`, `Notes`. Drives auto-reorder (`tbl_pending_orders`) and is decremented by cust-POS & production.

### `tbl_cust_stock_log` — tenant stock movement audit (1 row)
`id` PK; `Customer_Name`, `Item_ID`, `Item_Description`, `Log_Date`, `Log_Type` (Sale/Production/Adjust), `Qty_Change`, `Balance_After`, `Ref_Doc`, `Notes`, `Created_By`. Log_Type enum.

### `tbl_cust_my_*` — tenant's own embedded mini-ERP (all 0 rows; scoped by `Owner_Customer`)
- **`tbl_cust_my_customers`** — tenant's own customers: `id` PK; `Owner_Customer`, `Customer_Name`, `Phone`, `Address`, `Notes`.
- **`tbl_cust_my_suppliers`** — tenant's own suppliers: `id` PK; `Owner_Customer`, `Supplier_Name`, `Contact_Name`, `Phone`, `Address`.
- **`tbl_cust_my_pos`** (header) — `PO_No` PK (MPO-…); `Owner_Customer`, `PO_Date`, `Supplier_Name`, `Total_Amount`, `Status`, `Remarks`.
- **`tbl_cust_my_po_items`** (lines) — `id` PK; `PO_No`(→), `Item_Description`, `Qty`, `UOM`, `Unit_Price`, `Amount`. **Note: no `Item_ID`** (free-text only — even thinner than HQ PO lines).

---

## 7. Marketing / Loyalty

### `tbl_marketing_campaigns` — popups/tickers/targeted promos (0 rows)
`id` PK; `Campaign_ID`, `Campaign_Name`, `Campaign_Type` DFLT `Popup` (Popup/Ticker/…), `Content_Text`, `Image_Path`, `Ticker_Text`, `Start_Date`, `End_Date`, `Target_Type` DFLT `All` (All/Customer/Group), `Target_Value`, `Priority`, `Active`, `Created_By`, `Created_At`. Target_Type/Campaign_Type enums.

### `tbl_campaign_reads` — per-customer campaign engagement (0 rows)
`id` PK; `Campaign_ID`(→), `Customer_Name`, `Read_At`, `Action` DFLT `Closed` (Closed/Clicked/…).

### `tbl_ab_tests` / `tbl_ab_variants` — A/B testing (0/0)
- **ab_tests:** `id` PK; `Test_ID`, `Test_Name`, `Campaign_ID`(→), `Status` DFLT `Running`, `Start_Date`, `End_Date`, `Winner`, `Created_By`, `Created_At`.
- **ab_variants:** `id` PK; `Test_ID`(→), `Variant`, `Content_Text`, `Image_Path`, `Impressions`/`Clicks`/`Conversions` (counters DFLT 0).

### `tbl_promotions` — discount/promo rules engine (0 rows)
`Promo_ID` PK; `Promo_Name`, `Promo_Type`, `Start_Date`, `End_Date`, `Min_Qty`, `Min_Amount`, `Discount_Pct`, `Discount_Amt`, `Free_Item_ID`, `Free_Qty`, `Customer_Group` DFLT `All`, `Item_IDs` (**CSV of item ids — denormalized**), `Category`, `Max_Uses`, `Used_Count`, `Active`, `Notes`. Promo_Type enum; `Item_IDs` should be a junction table.

### `tbl_price_list` — customer-specific/contract pricing (0 rows)
`id` PK; `List_Name`, `Customer_Name`, `Item_ID`, `Item_Description`, `Base_Price`, `Special_Price`, `Discount_Pct`, `Min_Qty` DFLT 1, `Valid_From`, `Valid_To`, `Active`. Tiered/contract pricing per customer+item.

### `tbl_loyalty_config` — loyalty rules singleton (1 row)
`id` PK; `Enabled` DFLT 0, `Points_Per_Baht` DFLT 1.0, `Baht_Per_Point` DFLT 0.1, `Min_Redeem` DFLT 100, `Expiry_Days` DFLT 365, `Updated_At`. **Single-row config table** (should be a key-value settings store).

### `tbl_loyalty_points` — per-customer point balance (0 rows)
`id` PK; `Customer_Name`, `Balance`, `Lifetime`, `Last_Updated`. Updated on cust-POS sale (earn/redeem, lines 2937–2940, 5017–5020).

### `tbl_loyalty_txn` — point ledger (0 rows)
`id` PK; `Customer_Name`, `Txn_Date`, `Txn_Type` (Earn/Redeem/Expire), `Points`, `Balance_After`, `Ref_Doc`, `Notes`. Txn_Type enum.

### `tbl_abandoned_carts` — cart-recovery (0 rows)
`id` PK; `Customer_Name`, `Cart_Data` (**serialized JSON blob**), `Created_At`, `Notified_At`, `Recovered` DFLT 0. Recovery flips `Recovered=1` (line 2920).

### `tbl_surveys` / `tbl_survey_responses` — NPS/feedback (0/0)
- **surveys:** `id` PK; `Survey_ID`, `Survey_Name`, `Survey_Type` DFLT `NPS`, `Trigger` DFLT `Post-Delivery`, `Active`, `Created_At`.
- **survey_responses:** `id` PK; `Survey_ID`(→), `Customer_Name`, `Order_No`, `Response_Date`, `NPS_Score` (INTEGER), `Q1_Answer`/`Q2_Answer`/`Q3_Answer` (**fixed 3-question denormalization** — not EAV; adding Q4 needs schema change), `Comments`. Survey_Type/Trigger enums.

---

## 8. Logistics / Delivery

### `tbl_delivery_orders` / `tbl_do_items` — DO + proof-of-delivery (0/0)
- **delivery_orders (header):** `DO_No` PK; `DO_Date`, `Customer_Name`, `Address`, `Driver`, `Vehicle`, `Status` DFLT `Pending` (Pending/Delivered), `Delivered_At`, `POD_Image` (proof-of-delivery photo path, captured line 9977), `Remarks`, `Created_By`.
- **do_items:** `id` PK; `DO_No`(→), `Order_No`(→sales_orders), `Item_ID`, `Item_Description`, `Qty`, `UOM`, `Status` DFLT `Pending`. Status enums.

---

## 9. System / Auth / Notifications

### `tbl_users` — auth (4 rows; **dual SQLite+Postgres**)
`Username` PK; `Password_Hash` (**SHA-256, unsalted** — `hashlib.sha256(password).hexdigest()`, user_store.py:36 — security weakness, no salt/bcrypt), `Role`(→role_permissions, but no FK), `Customer_Name` (tenant binding — Customer-role users scoped to their tenant), `Permissions` (**serialized CSV override string**, e.g. `cust_bom,cust_dash,...`). Postgres mirror has identical columns but **lowercase names**; `delete_user` hard-protects `admin`.

### `tbl_role_permissions` — RBAC templates (6 rows)
`Role` PK; `Permissions` (CSV string). Seeded roles & their token sets:
- **Admin:** `pos,dashboard,exec,order_mgt,claim_mgt,crm,users,warehouse,procurement,creditors,ar,delivery,returns,pricelist,lots,locations,promos,mobile,marketing,loyalty,survey,planner,images,masterdata`
- **Sales:** `pos,dashboard,exec,order_mgt,claim_mgt,crm,ar,delivery,returns,pricelist,promos,mobile,marketing,warehouse,procurement,planner`
- **Customer:** `order_cust,cust_dash,cust_inventory,cust_pos,cust_bom,cust_variance,loyalty,survey,track,cust_my_users`
- **Warehouse:** `warehouse,lots,locations,mobile,images,masterdata`
- **Procurement:** `procurement,creditors,ar,delivery,masterdata`
- **Planner:** `dashboard,exec,warehouse,procurement,creditors,planner,masterdata`
Tokens map to `nav_*` sidebar keys. In Postgres: `roles`, `permissions` (enum of ~30 tokens), `role_permissions` join.

### `tbl_doc_status_log` — universal status-change audit (0 rows)
`id` PK; `Doc_Type`, `Doc_No`, `Old_Status`, `New_Status`, `Changed_By`, `Changed_At`, `Remarks`. Single polymorphic audit trail across all doc types (written via `_log_status`, e.g. line 8006). `Doc_Type` enum.

### `tbl_notifications` — in-app alerts (0 rows; **only bilingual data table**)
`id` PK; `target_customer`, `target_role`, `message` (Thai), `message_en` (English), `is_read` DFLT 0, `created_at`. **Lowercase snake_case columns** (inconsistent with the rest of the DB's PascalCase — naming inconsistency). Targeting by customer OR role.

---

## 10. Clean-Postgres recommendations (priority drops/risks)

1. **Add surrogate integer PKs + real FKs everywhere.** Today all joins are TEXT business codes/names. `tbl_sales_orders` has **no PK at all**.
2. **Unify tenant key:** `Customer_Name`(PK on `tbl_customers`) and `Owner_Customer` → single `tenant_id` FK. Same concept, two column names.
3. **Consolidate vendors:** `tbl_suppliers` ⟷ `tbl_creditors` are overlapping vendor masters; PO/GR reference supplier by **name** ignoring `Supplier_ID`.
4. **Replace CSV/serialized fields with relations:** `tbl_users.Permissions`, `tbl_role_permissions.Permissions`, `tbl_promotions.Item_IDs`, `tbl_abandoned_carts.Cart_Data` (JSON → jsonb is acceptable), `tbl_survey_responses.Q1..Q3` (→ answers table).
5. **Enums:** every `Status`/`Type`/`Method`/`Category`/`Shift`/`Action`/`Currency`/`Priority` TEXT column → Postgres enum (no current CHECK constraints).
6. **`tbl_raw_inventory`:** rename `"Expired Date"` (space) → `expiry_date`; fix PascalCase+space mixing; split into `items` master + partitioned `stock_snapshots`; index `Generate_Date`/`Item_ID` (1.48M unindexed rows). It is **simultaneously the item master and the stock fact** — separate them.
7. **Atomic numbering:** replace `_next_doc_no` `count(*)+1` (race condition) and the 12 inconsistent inline schemes with per-doc-type sequences.
8. **Security:** unsalted SHA-256 password hashing → bcrypt/argon2.
9. **De-denormalize header/line tables:** `tbl_sales_orders` repeats header per line; many child tables carry redundant `Item_Description`/`Customer_Name`/`Creditor_Name` copies.
10. **i18n:** Thai is the **default** language (`t()` falls back to TH). Only `tbl_notifications` stores both languages; preserve the `message`/`message_en` pattern or move to a translations table — do not assume English-default.