I have read the full range (L1-3665). I now have everything needed to produce the exhaustive catalogue.

# ERPPOS_Invisible.py — Reverse-Engineering Catalogue (Lines 1–3665)

Monolithic Streamlit ERP/POS. Single-file router: a sidebar radio sets `menu`, and a long `if/elif _menu_is(menu, ...)` chain dispatches to each page. Routing is **label-based** (compares `menu` against `_LANG[lang][key]` for BOTH TH and EN via `_menu_is`), so renaming any nav label silently breaks routing. **Parity-critical: every `nav_*` label string is load-bearing for routing — do not change label text without updating `_menu_is` calls.**

---

## 1. App / Page Config & Global Setup (L1–599)

**Imports / deps (parity-critical):** `streamlit, pandas, sqlite3, numpy, plotly.express, fpdf (FPDF), bahttext (Thai baht-in-words), reportlab (A4 PDF, QR codes), PIL (Image/Draw/Font), dotenv`. User auth delegated to external `user_store` module (`check_login`, `make_hash`, `init_user_store`, `create_user`, `update_user`, `delete_user`, `get_all_users`).

- **`.env` load** (L14–19): `load_dotenv(__file__.parent/.env)` for `ANTHROPIC_API_KEY` etc.
- **sys.path injection** (L21–24): project root added so agent/MCP imports resolve.
- **`st.set_page_config`** (L447–452): `page_title="Invisible Portal"`, `layout="wide"`, `page_icon` = `assets/logo.png` if exists else 🏢.
- **Theme** (L454–577): brand colors `RUBY="#9B111E"`, `BURGUNDY="#800020"`. Injects large CSS block: Google font **Sarabun** (Thai), burgundy gradient sidebar (forces all sidebar text white), `.main-header`, gradient `.stButton`, KPI card classes (`.kpi-blue/green/orange/purple/red/teal`), status badges (`.badge-pending/processing/shipped/completed/claimed/cancelled`), `.section-title`, `.admin-card`, custom progress bars. **Parity-critical: KPI/badge CSS class names are referenced inline throughout pages.**
- **Config load** (L579–590): reads `config.json` (`company_name`, `company_subtitle`, `db_filename`, `master_csv_filename`, `contact_tel`, `contact_email`). Missing config → `st.stop()`.
- **DB path** (L589): `DB_PATH` env var **overrides** `config['db_filename']`. Master CSV at `Shared_Data/<master_csv_filename>`.
- **Cached DB conn** (L592–599): `@st.cache_resource` SQLite with `PRAGMA journal_mode=WAL`, 32MB cache, temp_store=MEMORY. NOTE: most page code opens its own `sqlite3.connect(db_path)` rather than using this cached conn — mixed pattern.
- **`init_db()`** (L604–1447): idempotent `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN` for ~60 tables (see table inventory below). Seeds default locations, loyalty config row, and **role-permission defaults** (L637–646). Calls `init_user_store()` (Postgres if `USERS_DB_URL` set, else SQLite).

### Login / Auth (L1450–1509)
- `check_login(username,password)` → delegates to `user_store._us_check_login`; returns `(Role, Customer_Name)` tuple or `None`.
- Session keys initialized: `logged_in, role, username, customer_name` (L1462–1464).
- Login page (L1466–1498): centered card, `st.form("login_form")`, Thai placeholders. On success sets session + `st.rerun()`. On fail Thai+EN error. Unauthenticated → `st.stop()`.
- `logout()` (L1501–1508): deletes `logged_in, role, username, customer_name, cart`; **must not** call `st.rerun()` (used as on_click callback). 
- `get_image_path(item_id)` (L1511): probes `images/<id>.{jpg,jpeg,png,JPG,PNG}`.

### Stock loader `load_current_stock()` (L1520–1599, `@st.cache_data ttl=60`)
**Parity-critical business logic:**
- Reads `tbl_raw_inventory` summed by `Item_ID,Item_Description` for the **latest `Generate_Date`** only (`WHERE Generate_Date=(SELECT MAX(Generate_Date)...)`).
- Outer-merges with master CSV (cols: `Item_ID, Item_Description, Unit_Price, Stock_UOM, Conversion_Factor, Category, Base_UOM`).
- `Is_Out_Of_System` = AV_QTY is NaN (item in master but not in inventory snapshot) → AV_QTY filled with **999999** (treated as unlimited/special-order).
- `Available_Selling_Qty = floor(AV_QTY / Conversion_Factor)` — converts base units to sellable (large) UOM.
- `Display_Name = "Item_ID : Item_Description"` (used as selectbox keys everywhere).
- Falls back gracefully if master CSV missing.

---

## 2. Internationalisation `_LANG` (L45–232)

Two-key dict `_LANG = {"TH": {...}, "EN": {...}}`. `T(key)` (L229) looks up `st.session_state["lang"]` (default **"TH"**), falls back to key string itself if missing. Language switched via sidebar radio (L1993–2000): `"TH 🇹🇭"/"EN 🇬🇧"`.

**Full key inventory (every key present in both TH & EN unless noted):**

| Key | TH | EN |
|---|---|---|
| `nav_pos` | 🛒 สร้างออเดอร์ (POS) | 🛒 Create Order (POS) |
| `nav_order_cust` | 🛒 สั่งซื้อสินค้า | 🛒 Place Order |
| `nav_dashboard` | 📊 Sales Dashboard | 📊 Sales Dashboard |
| `nav_exec` | 👔 Executive Dashboard | 👔 Executive Dashboard |
| `nav_cust_dash` | 📊 Dashboard ของฉัน | 📊 My Dashboard |
| `nav_cust_my_crm` | 👥 ฐานข้อมูลลูกค้าของฉัน | 👥 My Customers |
| `nav_cust_my_suppliers` | 🏢 ซัพพลายเออร์ของฉัน | 🏢 My Suppliers |
| `nav_cust_my_pos` | 🛒 สร้างใบสั่งซื้อ (My POs) | 🛒 My Purchase Orders |
| `nav_cust_my_users` | 👥 จัดการบัญชีพนักงาน | 👥 My Users |
| `nav_cust_inventory` | 📦 สต๊อกสินค้า & สั่งซื้อซ้ำ | 📦 My Inventory & Reorder |
| `nav_loyalty` | ⭐ Loyalty Points | ⭐ Loyalty Points |
| `nav_survey` | 📝 Survey & Feedback | 📝 Survey & Feedback |
| `nav_cust_pos` | 🏪 POS ขายสินค้า | 🏪 My POS |
| `nav_cust_bom` | 🔬 สูตรผลิต (BoM) | 🔬 Bill of Materials |
| `nav_cust_variance` | 📊 วิเคราะห์ผลต่าง | 📊 Variance Analysis |
| `nav_marketing` | 📣 การตลาด (Marketing) | 📣 Marketing Dashboard |
| `nav_order_mgt` | 🗂️ จัดการคำสั่งซื้อ (Order Mgt) | 🗂️ Order Management |
| `nav_claim_mgt` | 🛠️ ระบบจัดการเคลม | 🛠️ Claim Center |
| `nav_crm` | 👥 ฐานข้อมูลลูกค้า (CRM) | 👥 Customer Database (CRM) |
| `nav_users` | ⚙️ จัดการผู้ใช้งาน | ⚙️ User Management |
| `nav_images` | 🖼️ จัดการรูปภาพ | 🖼️ Image Manager |
| `nav_masterdata` | 📋 จัดการ Master Data | 📋 Master Data Manager |
| `nav_bom_master` | 🔬 คลังสูตรผลิตกลาง (BoM Master) | 🔬 BoM Master Library |
| `nav_planner` | 📐 Planner / วางแผนสินค้า | 📐 Planner |
| `nav_warehouse` | 🏭 คลังสินค้า (Warehouse) | 🏭 Warehouse |
| `nav_procurement` | 🛒 จัดซื้อ (Procurement) | 🛒 Procurement |
| `nav_creditors` | 🏦 เจ้าหนี้ (AP / Creditors) | 🏦 Creditors (AP) |
| `nav_ar` | 💵 ลูกหนี้ (AR / รับชำระ) | 💵 AR / Collections |
| `nav_delivery` | 🚚 ใบส่งสินค้า (Delivery) | 🚚 Delivery Orders |
| `nav_returns` | ↩️ รับคืนสินค้า (Returns) | ↩️ Sales Returns |
| `nav_pricelist` | 🏷️ ราคาพิเศษลูกค้า (Price List) | 🏷️ Price List |
| `nav_lots` | 🔖 Lot/Batch Tracking | 🔖 Lot/Batch Tracking |
| `nav_locations` | 📍 Multi-Location Stock | 📍 Multi-Location Stock |
| `nav_promos` | 🎁 โปรโมชั่น/แคมเปญ | 🎁 Promotions |
| `nav_mobile` | 📱 Mobile Scanner | 📱 Mobile Scanner |
| `nav_track` | 📦 ติดตามสถานะและเคลมสินค้า | 📦 Track Orders & Claims |
| `nav_ai_chat` | 🤖 AI Assistant | 🤖 AI Assistant |
| `logout` | 🚪 ออกจากระบบ | 🚪 Sign Out |
| `user_label` | 👤 ผู้ใช้งาน | 👤 User |
| `dept_label` | 🏢 สังกัด | 🏢 Department |
| `lang_label` | 🌐 ภาษา / Language | 🌐 Language / ภาษา |

**Non-nav i18n keys (Order Mgt / POS / Claim / Customer dashboard blocks):** `order_mgt_title, select_order, change_status, est_delivery, save_status, export_pdf, export_txt, export_csv, delete_order, order_deleted, status_updated, no_orders, order_items, grand_total, customer, order_date, status, pos_title, order_for, search_item, qty, add_cart, cart_title, clear_cart, confirm_order, order_success, total, claim_title, no_claims, approve, reject, waiting, reject_reason, save_result, export_claim_pdf, reorder_btn, reorder_ok, notif_title, notif_empty, stmt_btn, stmt_month`.

**i18n flags for rewrite:**
- **`nav_cust_my_crm` and `nav_cust_my_suppliers`/`nav_cust_my_pos`/`nav_cust_my_users` are duplicated** in the TH block (L53–56 then L64–67) and once in EN — second definition wins (`nav_cust_my_pos` TH ends as "🛒 สร้างใบสั่งซื้อ (My POs)", `nav_cust_my_users` TH as "👥 จัดการบัญชีพนักงาน"). Easy to silently drop one variant.
- Many page bodies use **hard-coded Thai strings** NOT in `_LANG` (e.g. all subheaders in POS: "1. ข้อมูลผู้สั่งซื้อ", dashboard tab labels "🏠 ภาพรวม" etc.). These are NOT translated when EN is selected — **a faithful rewrite must decide whether to keep this TH-only behavior or fully i18n it.** Executive dashboard mixes `is_en` flag (L3380) but still renders Thai section labels.

---

## 3. RBAC — Two Parallel Systems (L235–441)

**There are TWO overlapping RBAC mechanisms. The second (permission-key based) is the live one used by the sidebar.** The first (`nav_key`-based) is legacy/partially-used. A rewrite must not conflate them.

### 3a. Legacy nav-key RBAC (L240–321) — partially dead
- **`ALL_NAV_KEYS`** (L240–255): 14 nav keys with `{label, group}` (Sales/Analytics/Warehouse/Procurement/Customer/Admin). Subset of the real menu.
- **`ROLE_COLORS`** (L257–264): Admin/Sales/Customer/Warehouse/Procurement/Planner → (text,bg) hex pairs.
- `_get_role_permissions(role)` (L267–288): reads `tbl_role_permissions.Permissions` (comma list); hardcoded fallback defaults per role.
- `_save_role_permissions`, `_can_access(role,nav_key)` (L291–302).
- **`_build_menu_for_role(role)`** (L305–314): returns ordered `T()` strings for a fixed 13-key order: `nav_pos, nav_order_cust, nav_dashboard, nav_cust_dash, nav_order_mgt, nav_claim_mgt, nav_warehouse, nav_procurement, nav_crm, nav_track, nav_images, nav_masterdata, nav_users`. **This function appears superseded by the MENU_GROUPS sidebar builder (§5) and is likely not the actual menu driver — flag as possibly-dead code that a rewrite could mistakenly treat as authoritative.**
- `_role_badge(role)` (L317): HTML pill.

### 3b. Permission-key RBAC (L328–441) — THE LIVE SYSTEM

**`ALL_PERMISSIONS`** (L328–366) — the canonical permission-key registry, `{key: (emoji, display_name_TH/EN_mixed)}`. **Catalogue of ALL 38 permission keys:**

```
pos, dashboard, order_mgt, claim_mgt, crm, users, warehouse, procurement,
creditors, ar, delivery, returns, pricelist, lots, locations, promos, mobile,
images, masterdata, bom_master, planner, exec, order_cust, cust_dash,
cust_inventory, cust_pos, cust_bom, cust_variance, loyalty, survey,
cust_my_crm, cust_my_suppliers, cust_my_pos, cust_my_users, marketing,
track, ai_chat
```
(That is 37 in the list above + `users` = 38 total. Note: `cust_my_users` HAS a permission key but **NO `PERM_TO_NAV` entry and is NOT in MENU_GROUPS Administration** — it appears in the "My Business" group via nav key; see flag.)

**`PERM_TO_NAV`** (L369–393): maps perm key → `nav_*` key. **Incomplete on purpose** — only maps perms that have a 1:1 nav route. Missing mappings (perms with no PERM_TO_NAV entry): `ar, delivery, returns, pricelist, lots, locations, promos, mobile, planner, exec, users, cust_inventory, cust_my_crm, cust_my_suppliers, cust_my_pos, cust_my_users, cust_pos*` — but the sidebar (§5) uses its own `(perm_key, nav_key)` tuples in `MENU_GROUPS`, so `PERM_TO_NAV` is only a secondary lookup. **Flag: PERM_TO_NAV is NOT the source of truth for the menu; do not derive the nav from it.**

**`get_user_perms(username)`** (L395–428) — **core permission resolver, parity-critical precedence:**
1. If `role == "Admin"` → returns **ALL** `ALL_PERMISSIONS.keys()` (admin bypass).
2. Else reads `tbl_users.Permissions` for the user — **individual per-user override** (comma list) takes precedence if non-empty.
3. Else falls back to `tbl_role_permissions.Permissions` for the role.
4. Else hardcoded fallback dict (L421–427):
   - `Customer`: `order_cust, cust_dash, track`
   - `Warehouse`: `warehouse, images, masterdata`
   - `Procurement`: `procurement, masterdata`
   - `Planner`: `dashboard, warehouse, procurement, masterdata`
   - `Sales`: `pos, dashboard, order_mgt, claim_mgt, crm, warehouse, procurement, ai_chat`
   - default (unknown role): `order_cust, cust_dash, track`
- `has_perm(perm_key)` (L431): membership check against `get_user_perms(session.username)`.
- `require_perm(perm_key)` (L436): `st.error("⛔ … Access denied: {perm_key}")` + `st.stop()` (bilingual). **Note: most pages do NOT call require_perm — access is gated only by the sidebar not showing the menu item. A user who can construct the menu label could still route. Security flag.**

**DB-seeded role defaults `DEFAULT_PERMS`** (L637–644, in `init_db`, `INSERT OR IGNORE`) — these are the authoritative role grants written to `tbl_role_permissions`:
- **Admin**: `pos,dashboard,exec,order_mgt,claim_mgt,crm,users,warehouse,lots,locations,mobile,images,procurement,creditors,ar,delivery,returns,pricelist,promos,marketing,loyalty,survey,planner,masterdata,bom_master`
- **Sales**: `pos,dashboard,exec,order_mgt,claim_mgt,crm,ar,delivery,returns,pricelist,promos,marketing,planner`
- **Customer**: `order_cust,cust_pos,cust_dash,cust_inventory,cust_bom,cust_variance,loyalty,survey,track,cust_my_crm,cust_my_suppliers,cust_my_pos,cust_my_users`
- **Warehouse**: `warehouse,lots,locations,mobile,images,masterdata`
- **Procurement**: `procurement,creditors,ar,delivery,masterdata`
- **Planner**: `dashboard,exec,warehouse,procurement,planner,masterdata`

**RBAC flags for rewrite:**
- `Admin` role short-circuits to all perms in `get_user_perms` (code) AND has all perms seeded in DB — admin gating is code-level, not data-driven.
- The DB-default `Sales` set (no `warehouse`/`procurement`) differs from the **code fallback** `Sales` set (includes `warehouse,procurement`, no `ar/delivery/...`). Whichever path executes (DB row exists vs not) yields different menus — **subtle, easy to break in rewrite.**
- `cust_my_users` / `cust_my_crm` / `cust_my_suppliers` / `cust_my_pos` are NOT in `ALL_NAV_KEYS` (legacy) and not all in `PERM_TO_NAV`, but ARE in the live `MENU_GROUPS`.

---

## 4. Sidebar / Navigation (L1983–2242)

Rendered inside `with st.sidebar:`.
- Logo (`assets/logo.png`), language switcher radio (sets `st.session_state["lang"]`).
- User/Dept labels: `T('user_label'): username`, `T('dept_label'): customer_name`. Logout button (on_click=`logout`).
- `user_perms = get_user_perms(username)`; `role = session.role`.
- **Notification badge** (L2013–2021): if `"track" in user_perms or role=="Customer"`, calls `_get_notifications(customer_name, conn)` and computes `n_badge = " 🔴{n}"` appended to the `nav_cust_dash` label.
- **Role badge** (L2024–2033): colored pill, colors `Admin=#ef4444, Sales=#3b82f6, Customer=#10b981, Warehouse=#8b5cf6, Procurement=#f59e0b, Planner=#0d9488`.

### `MENU_GROUPS` (L2040–2105) — THE authoritative menu structure
9 ordered groups, each `(group_label, emoji, [(perm_key, nav_key, badge), ...])`. **Full catalogue (perm_key → nav_key, in render order):**

1. **Customer Portal** 👤: `order_cust→nav_order_cust`, `cust_pos→nav_cust_pos`, `cust_dash→nav_cust_dash` (badge=`n_badge`), `cust_inventory→nav_cust_inventory`, `cust_bom→nav_cust_bom`, `cust_variance→nav_cust_variance`, `loyalty→nav_loyalty`, `survey→nav_survey`, `track→nav_track`
2. **My Business (Mini-ERP)** 💼: `cust_my_crm→nav_cust_my_crm`, `cust_my_suppliers→nav_cust_my_suppliers`, `cust_my_pos→nav_cust_my_pos`, `cust_my_users→nav_cust_my_users`
3. **Sales** 💰: `pos→nav_pos`, `order_mgt→nav_order_mgt`, `claim_mgt→nav_claim_mgt`, `crm→nav_crm`
4. **Dashboard & Analytics** 📊: `dashboard→nav_dashboard`, `exec→nav_exec`, `planner→nav_planner`
5. **Warehouse** 🏭: `warehouse→nav_warehouse`, `lots→nav_lots`, `locations→nav_locations`, `mobile→nav_mobile`, `images→nav_images`
6. **Procurement** 🛒: `procurement→nav_procurement`
7. **Finance & AR/AP** 💵: `ar→nav_ar`, `creditors→nav_creditors`
8. **Sales Operations** 🚚: `delivery→nav_delivery`, `returns→nav_returns`, `pricelist→nav_pricelist`, `promos→nav_promos`, `marketing→nav_marketing`
9. **Administration** ⚙️: `masterdata→nav_masterdata`, `bom_master→nav_bom_master`, `users→nav_users`, `ai_chat→nav_ai_chat`

- Build loop (L2112–2122): for each group, keep items where `perm_key in user_perms`; skip empty groups; fallback to `[('track', T('nav_track'), 'Customer Portal')]` if nothing visible.
- **Render trick (L2161–2232):** builds one flat `st.radio` with group-header rows prefixed by `★ (U+2605)`. Injected JS (L2177–2215) styles `★`-rows as non-clickable gold headers (hides their radio circle, `pointerEvents:none`), strips the `★`. **Parity-critical & fragile: navigation relies on injected JS + MutationObserver to make section headers non-selectable. A rewrite should use a real grouped/native nav instead.**
- Routing resolution (L2218–2232): if a `★` header somehow selected → jump to first item of that group; strip `n_badge` from label → final `menu` string.
- `_menu_is(menu_val, *keys)` (L2641–2647): the router predicate — true if `menu_val == _LANG[lang][k]` for any lang/key. **This is why labels are load-bearing.**

---

## 5. POS / Order Entry — `nav_pos` & `nav_order_cust` (L2650–2955)

Single handler for both `nav_pos` (staff) and `nav_order_cust` (customer). 

**Purpose:** create sales orders into `tbl_sales_orders`.

**Inputs / flow:**
- "Order on behalf of" (L2667–2680): Admin/Sales pick `Customer_Name` from `tbl_customers`; Customer locked to own `session.customer_name`.
- Two tabs (L2685): **Manual search** & **Excel import**.
  - **Manual** (L2689–2737): selectbox on `Display_Name`; shows product image; stock status — if `Is_Out_Of_System` or `Available_Selling_Qty>=99999` → "นอกระบบ/สั่งพิเศษ (ไม่จำกัด)"; else shows available qty. Add-to-cart warns (non-blocking) if `qty > Available_Selling_Qty`. Cart item dict: `{Item_ID, Item_Description, Order_Qty, Stock_UOM, Unit_Price}` in `st.session_state.cart`.
  - **Excel import** (L2739–2816): downloads template with **Thai column headers** `ประเภทครัว, รหัสสินค้า, ชื่อสินค้า, จำนวนสั่ง_หน่วยใหญ่, หน่วยใหญ่, จำนวนสั่ง_หน่วยเล็ก, หน่วยเล็ก, อัตราแปลง`. Upload parses qty: **`total_order = q_old + q_large + (q_small / Conversion_Factor)`** (small-unit qty converted to large UOM). **Parity-critical: this UOM conversion + the exact Thai header names.**

**Cart / checkout (L2818–2955):**
- Cart table with Thai column renames; `Total_Price = Order_Qty * Unit_Price`; grand total.
- **Promotion check** (L2852–2866): `_apply_promotions(cust, items, total)` — but reads `st.session_state['order_cart']` (a DIFFERENT key than `cart`), so this block is effectively dead in this page (cart is `st.session_state.cart`). **Bug/flag: promo + credit-limit checks reference `order_cart`/`'total'` keys that the POS cart never populates.**
- **Credit limit check** (L2867–2896): reads `tbl_customers.Credit_Hold/Credit_Limit`; if `Credit_Hold` → block message; computes outstanding AR (`SUM(Amount-Paid_Amount)` over Unpaid/Partial invoices) + cart total vs limit; >limit error, >80% warn. Also keyed off `order_cart` (mostly inert here).
- **Submit (L2898–2953):** Document number scheme **`SO-YYYYMMDD-HHMM`** (`SO-{datetime:%Y%m%d-%H%M}`). Inserts each cart line into `tbl_sales_orders` with `Status='Pending'`, `Admin_Claim_Status='Waiting'`, zeroed claim/received fields. 
  - Post-submit: marks abandoned carts recovered (`tbl_abandoned_carts`); **Loyalty award** (L2924–2951) — if `tbl_loyalty_config.Enabled`, `points = order_total * Points_Per_Baht`, upserts `tbl_loyalty_points` (Balance/Lifetime), logs `tbl_loyalty_txn` Txn_Type='Earn'. (Order total recomputed from `tbl_sales_orders` by Order_No when `order_cart` is empty — fallback ensures points still award.)
  - `st.balloons()`, clears cart.

**DB writes:** `tbl_sales_orders` (insert), `tbl_abandoned_carts` (update), `tbl_loyalty_points`/`tbl_loyalty_txn` (upsert/insert). **Reads:** `tbl_customers`, `tbl_promotions`, `tbl_ar_invoices`, `tbl_loyalty_config`, master CSV/`tbl_raw_inventory`.

**Order status workflow seed:** new orders start `Pending`. Full status set used across app: `Pending → Processing → Shipped → Completed`, plus `Claimed`, `Cancelled`.

**Document generators (used by Order Mgt downstream, defined here L1605–1980):**
- `generate_pdf` (L1605): "SALES CONFIRMATION" A4 via FPDF + `THSarabunNew.ttf`; pulls `tbl_customers.Address/Tax_ID`; outputs `<order_no>.pdf`.
- `generate_express_txt` (L1664): Thai "ใบสั่งขาย" fixed-width TXT for **Express accounting import**; **adds 7% VAT** (`tax_amt = total*0.07`), baht-in-words via `bahttext`, encoded `utf-8-sig`. **Parity-critical: exact fixed-width layout + 7% VAT + Express format.**
- `generate_claim_summary_pdf` (L1732) + alias `generate_claim_pdf` (L1886): two-section claim resolution PDF (Approved §1 with evidence images, Rejected §2 with reasons, Waiting note).
- `generate_statement_pdf` (L1926): monthly customer purchase statement PDF.
- `_get_notifications(customer_name, conn)` (L1896): builds list of `(icon,msg)` — Shipped orders not yet received, claim decisions (Approved/Rejected) — drives the sidebar 🔴 badge.

---

## 6. Sales Dashboard — `nav_dashboard` (L2962–3376)

**Purpose:** Admin/Sales analytics over `tbl_sales_orders`. Reads ALL of `tbl_sales_orders`; `df_sales` excludes `Status='Cancelled'`.

6 tabs: **🏠 ภาพรวม | 📦 Orders | 🛠️ Claims | 🚨 Shortage | 📋 Raw Data | 💹 P&L / กำไร** (L2977–2979). Local `kpi_card()` HTML helper (L2971).

- **Overview** (L2982–3039): KPIs — total revenue (`Total_Price.sum`), distinct orders, active customers, **Claim Rate** = claimed-orders/total-orders ×100 (red if >10%), avg order value, completed count. Charts: daily sales area, customer-share donut (top 6), **Order Status Funnel** over `[Pending,Processing,Shipped,Completed,Claimed,Cancelled]`, Top-10 products bar.
- **Orders** (L3042–3077): customer **Leaderboard** (medals 🥇🥈🥉, progress bars by spend), monthly stacked bar by customer (`YearMonth` period).
- **Claims** (L3080–3124): `df_claimed = Claimed_Qty>0`; `Admin_Claim_Status` defaults 'Waiting'; KPIs total/approved/rejected/waiting + **approval rate**; status donut + frequently-claimed products bar; detail table.
- **Shortage** (L3127–3145): for `Pending+Processing` orders, aggregates `Order_Qty` by item, merges current stock; `Actual_Stock=0` if `Is_Out_Of_System`; `Shortage_Qty = Order_Qty - Actual_Stock`; lists positive shortages (red gradient).
- **Raw Data** (L3149–3245): filters (text search across Order_No/Customer/Item desc+ID, Status multiselect, Customer multiselect, date-range `7/30/90 วัน`); filtered KPIs; **order-level drill-down** selectbox → line items + per-order CSV export, or full filtered table + CSV export (`utf-8-sig`).
- **P&L / กำไร** (L3253–3376): merges orders with master (`Unit_Price` renamed to `Cost_Price` — **note: uses master Unit_Price AS cost, a known approximation**). Computes `Revenue=Total_Price`, `COGS=Order_Qty*Cost_Price`, `Gross_Profit`, `Margin_Pct`. Group-by Item/Customer/Category/Month; sort by GP/Revenue/Margin%; margin color-coding (≥30% green, <10% red); grouped Rev/COGS/GP bar + margin% bar with **20% target hline**; CSV export. **Parity-critical: COGS uses master Unit_Price as cost proxy; 20% GM target.**

---

## 7. Executive Dashboard — `nav_exec` (L3379–3661)

**Purpose:** cross-department exec overview. `is_en` flag read (L3380) but section labels stay Thai. Opens one `conn_ex`, closed at L3661. Section radio (horizontal): **🏢 ภาพรวมทั้งหมด | 💰 Sales | 🏭 Warehouse | 🛒 Procurement** (L3387).

- **Overview** (L3394–3488): 6 KPI cards — Total Revenue (`/1e6` → "M"), Total Orders, Active Customers, **PO Value** (`tbl_purchase_orders.Total_Amount` sum), **PO Pending Approval** count, **Active Suppliers** (`tbl_suppliers WHERE Active=1`). Each metric wrapped in try/except (resilient to missing tables). Charts: monthly revenue bar, order-status donut (fixed color map), PO-value-by-status bar. Top-50 orders drill-down table.
- **Sales** (L3491–3557): filters (date 7/30/90, customer, status); KPIs Revenue/Orders/Customers/Avg-per-order; Top-10 customers & products bars; order line drill-down + CSV.
- **Warehouse** (L3560–3600): reads `tbl_stock_movements`, `tbl_stocktake`; KPIs Total Movements, Stocktake Sessions (Doc_No startswith 'ST'), Discrepancies (`Difference!=0`); movement-by-type bar + movement-trend area; filterable raw movements + CSV.
- **Procurement** (L3603–3659): reads `tbl_purchase_orders`, `tbl_goods_receipt`; KPIs Total POs, Total PO Value, Approved POs, GR Count; PO-value-by-supplier bar (top 8) + PO-value-by-status donut; PO filters (status/supplier) + **PO line-item drill-down** (reads `tbl_po_items`) + CSV.

**DB reads (exec):** `tbl_sales_orders, tbl_purchase_orders, tbl_goods_receipt, tbl_stocktake, tbl_suppliers, tbl_stock_movements, tbl_po_items`. No writes.

---

## 8. Document Numbering Schemes (in this range)

- **Sales Order:** `SO-YYYYMMDD-HHMM` (L2900) — **minute-resolution; collision risk if two orders same minute** (no per-minute counter). Flag.
- **`_next_doc_no(prefix, conn)`** (L2251–2268): `PREFIX-YYYYMMDD-NNN` (3-digit counter from count of existing same-day docs). Supports `PO→tbl_purchase_orders.PO_No`, `GR→tbl_goods_receipt.GR_No`, `ST→tbl_stocktake.ST_No`, `MI→tbl_stock_movements.Doc_No`. **Counter = count+1 (not max+1) → gap/reuse risk on deletes.** Flag.

---

## 9. Warehouse/QR & Promo helpers defined in this range (used by later pages)

- `_make_qr_png_b64` (L2271), `_qr_pick_font` (L2288, Thai font priority THSarabunNew→Loma→DejaVu), `_qr_place_text` (L2321, renders Thai text to PNG and embeds in PDF), **`_make_qr_label_pdf`** (L2391): A4 universal-QR label sheet (`label_cols×label_rows`, default 2×4), QR payload `ITEM_ID:{id}|DESC:..|UOM:..|PRICE:..|CAT:..`, "UNIVERSAL QR" teal badge, action strip "GR | Issue | Transfer | Stocktake | Sale | Info". **Note: `ImageReader` used at L2387 but not imported in shown range — potential NameError unless imported later. Flag.**
- `_wh_badge` (L2528), `_wh_kpi` (L2542): status pill + KPI card HTML.
- **`_apply_promotions(customer_name, order_items, order_total)`** (L2552–2592): picks best active promo (`tbl_promotions Active=1` and within Start/End date) matching `Customer_Group` (All or exact name) and `Min_Amount`; discount = `order_total*Discount_Pct/100` OR `Discount_Amt`; returns best-discount promo dict incl. free item/qty.
- `_log_status(doc_type,doc_no,old,new,conn,remarks)` (L2595): audit trail into `tbl_doc_status_log`.
- `_load_master_df` (L2609), `_get_current_stock_wh` (L2620, cached 300s).

---

## 10. Database Schema Created in `init_db` (L604–1444) — table inventory

**~60 tables** (parity-critical — full DDL is in source). Grouped:
- **Core sales:** `tbl_sales_orders` (+ALTERs: Estimated_Delivery, Received_Qty, Claimed_Qty, Claim_Reason, Claim_Image_Path, Admin_Claim_Status, Reject_Reason), `tbl_users` (+Permissions), `tbl_role_permissions` (seeded), `tbl_customers` (+Tax_ID, Address, Credit_Limit, Credit_Hold, Outstanding_AR).
- **Procurement/WH:** `tbl_suppliers, tbl_purchase_orders, tbl_po_items, tbl_goods_receipt, tbl_gr_items, tbl_stocktake, tbl_stock_movements, tbl_purchase_requests, tbl_pr_items, tbl_po_deliveries, tbl_gr_claims, tbl_supplier_requests, tbl_lot_ledger, tbl_locations (seeded 6 locs), tbl_location_stock, tbl_scan_sessions, tbl_scan_lines, tbl_doc_status_log`.
- **Finance:** `tbl_ar_invoices, tbl_ar_receipts, tbl_creditors, tbl_ap_transactions, tbl_delivery_orders, tbl_do_items, tbl_sales_returns, tbl_return_items, tbl_price_list, tbl_promotions`.
- **Customer self-service:** `tbl_customer_inventory, tbl_cust_stock_log, tbl_pending_orders, tbl_pending_order_items, tbl_cust_pos_sales, tbl_cust_pos_items, tbl_cust_bom, tbl_cust_bom_lines, tbl_cust_prod_runs, tbl_cust_prod_items, tbl_cust_variance, tbl_customer_items, tbl_cust_my_suppliers, tbl_cust_my_customers, tbl_cust_my_pos, tbl_cust_my_po_items`.
- **BoM central:** `tbl_bom_master, tbl_bom_master_lines, tbl_bom_submissions, tbl_bom_submission_lines`.
- **Marketing/CRM:** `tbl_marketing_campaigns, tbl_campaign_reads, tbl_ab_tests, tbl_ab_variants, tbl_loyalty_config (seeded id=1), tbl_loyalty_points, tbl_loyalty_txn, tbl_abandoned_carts, tbl_surveys, tbl_survey_responses`.
- **External (not created here, read by load_current_stock):** `tbl_raw_inventory` (cols incl. `Item_ID, Item_Description, AV_QTY, Generate_Date`) — populated elsewhere (Master Data upload page, L6662+).

---

## Top "easy-to-silently-drop / break in rewrite" flags (this range)

1. **Label-based routing** — all `nav_*` label strings are functional keys; `_menu_is` matches against both TH+EN. Renaming a label or dropping an EN variant breaks the page.
2. **JS-injected gold section headers** — sidebar grouping depends on injected `<script>` + MutationObserver; not native Streamlit. Pure-Python rewrites will lose the non-clickable-header UX.
3. **Two RBAC systems** (`ALL_NAV_KEYS`/`_build_menu_for_role` legacy vs `ALL_PERMISSIONS`/`MENU_GROUPS` live). The live menu is `MENU_GROUPS` filtered by `get_user_perms`. `PERM_TO_NAV` is incomplete and NOT the menu source.
4. **`get_user_perms` precedence**: Admin→all; per-user `tbl_users.Permissions` override; then `tbl_role_permissions`; then hardcoded fallback. DB-seeded `Sales` defaults ≠ code-fallback `Sales` defaults.
5. **No `require_perm` gating on pages** — access control is menu-visibility only.
6. **POS promo + credit-limit blocks read `st.session_state['order_cart']`/`'total'`**, but the POS cart is `st.session_state.cart` with `Total_Price` — these checks are effectively inert in `nav_pos`. A rewrite "fixing" this would change behavior (would start enforcing credit limits/promos that today don't fire).
7. **Express TXT 7% VAT** + exact fixed-width Thai layout + `bahttext` baht-in-words + `utf-8-sig` encoding — Express accounting import format.
8. **UOM conversion in Excel order import**: `q_old + q_large + q_small/Conversion_Factor`; `Available_Selling_Qty = floor(AV_QTY/Conversion_Factor)`; "out of system" items = AV_QTY 999999 (unlimited).
9. **Doc numbering**: `SO-%Y%m%d-%H%M` (minute resolution, collision-prone); `_next_doc_no` uses count+1 (gap/reuse on delete).
10. **P&L COGS uses master `Unit_Price` as cost proxy** (no separate Unit_Cost field); 20% GM target line.
11. **TH-only hard-coded UI strings** in page bodies (subheaders, tab names, KPI labels) are NOT in `_LANG` and won't translate under EN — current intended behavior.
12. `ImageReader` referenced (L2387) but not imported in L1–3665 — assumed imported later; verify in rewrite.