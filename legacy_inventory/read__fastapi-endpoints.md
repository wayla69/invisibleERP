# REST Contract — `C:/Users/ASUS/Invisible ERP/api_server.py`

## App-level configuration

- **Framework**: FastAPI (`title="Invisible ERP API"`, `version="1.0.0"`).
- **Startup hook**: `@app.on_event("startup")` → `init_user_store()` (imported from `user_store`). Initializes the user store (PostgreSQL/SQLite shared store per recent commits).
- **Env loading**: `load_dotenv(_ROOT/"secret.env")` then `load_dotenv(_ROOT/".env")`. `_ROOT = Path(__file__).parent`.
- **Config file**: `config.json` loaded at import into `CONFIG`. Keys consumed: `company_name`, `company_subtitle`, `theme_color_primary`, `theme_color_secondary`, `contact_tel`, `contact_email`.
- **DB layer**: `from erp_mcp.db import fetchall, fetchone, execute`. All SQL uses `?` placeholders (SQLite-style). `execute` is imported but **never used** in this file (no write/INSERT/UPDATE endpoints — the API is read-only except login/chat).
- **`ANTHROPIC_API_KEY`**: read from env at import; used only by `/api/chat`.

### CORS — fully open (PARITY-CRITICAL / security)
```python
CORSMiddleware(allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
```
No credentials restriction, wildcard everything. A rewrite must preserve open CORS or the mobile app breaks; but note this is a wide-open policy.

### Server entrypoint (`__main__`)
- `port = int(os.environ.get("PORT", 8000))` — cloud platforms inject `PORT`.
- `is_cloud = RAILWAY_ENVIRONMENT or RENDER` env var presence.
- Cloud mode: prints CLOUD banner. Local mode: resolves hostname/IP, prints LAN URL for mobile app.
- `uvicorn.run("api_server:app", host="0.0.0.0", port=port, reload=not is_cloud)` — **reload enabled locally, disabled in cloud**.

---

## AUTH SCHEME (PARITY-CRITICAL)

Custom HMAC-signed token — **NOT** real JWT despite the `_JWT_SECRET` name.

- **Secret**: `_JWT_SECRET = os.environ.get("JWT_SECRET", "invisible-erp-secret-change-me")` (insecure default — flag for rewrite).
- **Token format**: pipe-delimited string `username|role|customer_name|expiry|sig`
  - `payload = f"{username}|{role}|{customer_name}|{expiry}"`
  - `expiry = int(time.time()) + 86400*30` → **30-day** validity.
  - `sig = hmac.new(_JWT_SECRET, payload, sha256).hexdigest()`.
- **`_make_token(username, role, customer_name)`** → returns `f"{payload}|{sig}"`.
- **`_verify_token(token)`**:
  - Splits on `|`, last element = sig, rest = payload.
  - Recomputes HMAC, compares with `hmac.compare_digest` (constant-time).
  - Unpacks `username, role, customer_name, expiry` from `parts` — **assumes exactly 4 payload fields**. A `customer_name` containing `|` would break unpacking (parity edge case: customer names with pipes corrupt the token).
  - Rejects if `int(expiry) < time.time()`.
  - Returns `{"username", "role", "customer_name"}` or `None` on any failure.
- **`_make_hash(password)`** → delegates to `user_store.make_hash` (defined but unused elsewhere in this file).

### PARITY-CRITICAL AUTH GAP
**Token verification is implemented but almost never enforced.** Only `/api/auth/me` calls `_verify_token`. **No business/data endpoint (dashboard, POS, inventory, finance, analytics, notifications, reports, customers) requires a token or checks RBAC.** There is no `Depends()` auth guard on any data route, and `customer_name`/`role` from the token are **never used for multi-tenant scoping or RBAC**. Despite login returning `role` and `customer_name`, the data layer is globally unscoped. A rewrite that adds proper per-customer scoping/RBAC would change behavior — this current openness is the existing contract.

---

## Pydantic request models

| Model | Fields | Used by |
|---|---|---|
| `LoginRequest` | `username: str`, `password: str` | `POST /api/login` |
| `ChatRequest` | `message: str`, `history: List[dict] = []`, `agent_type: str = "erp"` | `POST /api/chat` (`agent_type` accepted but **ignored**) |
| `InsightRequest` | `type: str`, `data: dict` | `POST /api/analytics/insight` |

---

## ENDPOINTS

Auth column: **None** = no token checked (the default for all data endpoints). Multi-tenant scoping: **none anywhere** unless stated.

### Auth & system

#### `POST /api/login`
- **Body**: `LoginRequest {username, password}`.
- **Logic**: `_user_check_login(username, password)` (from `user_store`). On failure → `401` with Thai detail `"Username หรือ Password ไม่ถูกต้อง"` (i18n-critical, Thai error string). On success builds token via `_make_token(username, row["Role"], row.get("Customer_Name") or "")`.
- **Response**: `{token, username, role, customer_name}` (`customer_name` from `row.get("Customer_Name")`, may be `None`).
- **Auth**: none required.
- **Note**: `row["Role"]` accessed with bracket (must exist) vs `row.get("Customer_Name")` (optional).

#### `GET /api/auth/me`
- **Header**: `Authorization: Bearer <token>` (FastAPI `Header(None)`).
- **Logic**: 401 `"Missing token"` if absent/not `Bearer `-prefixed; 401 `"Invalid or expired token"` if `_verify_token` fails.
- **Response**: `{username, role, customer_name}`.
- **Auth**: token required (only endpoint that enforces it).

#### `GET /`
- **Response**: `{status:"online", app: CONFIG["company_name"], version:"1.0.0"}`. Auth: none.

#### `GET /api/config`
- **Response**: `{company_name, company_subtitle, theme_primary, theme_secondary, contact_tel, contact_email}` (mapped from CONFIG keys `theme_color_primary`→`theme_primary`, `theme_color_secondary`→`theme_secondary`). Auth: none.

---

### Dashboard

#### `GET /api/dashboard` (AGGREGATION — parity-critical)
- **Params**: none. Uses server clock: `today = now %Y-%m-%d`, `month_start = now %Y-%m-01`.
- **Six sub-queries**:
  1. **today.sales/orders** — `tbl_cust_pos_sales`: `SUM(Total), COUNT(*) WHERE Sale_Date = today AND Status != 'Voided'`.
  2. **month.sales/orders** — same table `WHERE Sale_Date BETWEEN month_start AND today AND Status != 'Voided'`.
  3. **low_stock_count** — latest snapshot `MAX(Generate_Date)` from `tbl_raw_inventory`, then `COUNT(*) WHERE Generate_Date = snap AND AV_QTY <= 0`.
  4. **outstanding_ap** — `tbl_ap_transactions`: `SUM(Amount - COALESCE(Paid_Amount,0)) WHERE Status != 'Paid'`.
  5. **top_items_today** — top 5 by revenue: join `tbl_cust_pos_items i` ↔ `tbl_cust_pos_sales s` on `Sale_No`, `WHERE s.Sale_Date = today AND s.Status != 'Voided' GROUP BY i.Item_Description ORDER BY revenue DESC LIMIT 5`. Fields: `Item_Description, qty(SUM Qty), revenue(SUM Amount)`.
  6. **recent_orders** — 5 latest by `Sale_No DESC`: `Sale_No, Sale_Date, Total, Status, Payment_Method`.
- **Response**:
```json
{
  "today": {"sales": <num>, "orders": <int>},
  "month": {"sales": <num>, "orders": <int>},
  "low_stock_count": <int>,
  "outstanding_ap": <num>,
  "top_items_today": [{"Item_Description","qty","revenue"}],
  "recent_orders": [{"Sale_No","Sale_Date","Total","Status","Payment_Method"}]
}
```
- **Tables read**: `tbl_cust_pos_sales`, `tbl_cust_pos_items`, `tbl_raw_inventory`, `tbl_ap_transactions`. Auth: none. Scoping: none.
- **Parity note**: "Voided" exclusion and `AV_QTY <= 0` (≤0, includes negative) and the snapshot-date pattern are easy to silently drop.

#### `GET /api/dashboard/sales-trend`
- **Query**: `days: int = 7`.
- **SQL**: `tbl_cust_pos_sales` `WHERE Sale_Date >= date('now', '-{days} days') AND Status != 'Voided' GROUP BY Sale_Date ORDER BY Sale_Date ASC`. Param passed as `f"-{days} days"`.
- **Response**: `{days, trend:[{date, sales, orders}]}`. Auth: none.

---

### POS / Sales

#### `GET /api/pos/summary`
- **Query (required)**: `start_date: str`, `end_date: str`.
- **SQL** on `tbl_cust_pos_sales` (`Status != 'Voided'`, `Sale_Date BETWEEN`):
  - summary: `COUNT(*) total_orders, SUM(Subtotal) subtotal, SUM(Discount) total_discount, SUM(Tax_Amount) total_tax, SUM(Total) total_sales`.
  - top_items (LIMIT 10): join items, `Item_Description, total_qty(SUM Qty), total_revenue(SUM Amount)` ordered by revenue.
  - by_payment: `Payment_Method, order_count(COUNT), amount(SUM Total) GROUP BY Payment_Method ORDER BY amount DESC`.
- **Computed**: `avg_order_value = round(total_sales/total_orders, 2)` (0 if no orders).
- **Response**: `{...summary, avg_order_value, top_items, by_payment}` (summary fields spread at top level). Auth: none.

#### `GET /api/pos/orders`
- **Query**: `limit: int = 20`, `offset: int = 0`, `status: Optional[str] = None`.
- **SQL**: `tbl_cust_pos_sales`, optional `WHERE Status = ?`. Selects `Sale_No, Sale_Date, Subtotal, Discount, Tax_Amount, Total, Payment_Method, Status, Created_By AS Cashier, Customer_Name`. `ORDER BY Sale_No DESC LIMIT ? OFFSET ?`.
- **Param building**: `(status, limit, offset)` if status else `(limit, offset)` (positional, order-sensitive). **Note**: `cond` is f-string-interpolated but only with the literal `WHERE Status = ?` (no injection; status is parameterized).
- **Response**: `{orders:[...], count}`. Auth: none.

#### `GET /api/pos/orders/{sale_no}`
- **Path**: `sale_no: str`.
- **SQL**: `SELECT * FROM tbl_cust_pos_sales WHERE Sale_No = ?` (404 `"Order not found"` if missing); items `SELECT * FROM tbl_cust_pos_items WHERE Sale_No = ?`.
- **Response**: `{order:{...all columns}, items:[{...all columns}]}`. Auth: none. (`SELECT *` — response shape mirrors full table schema; a rewrite must preserve every column.)

#### `GET /api/pos/sessions`
- **Params**: none.
- **SQL**: `tbl_cust_pos_sales WHERE Status = 'Open' GROUP BY Created_By, Sale_Date`. Returns `Cashier(Created_By), Sale_Date, session_total(SUM Total), order_count(COUNT)`.
- **Response**: `{sessions:[...]}`. Auth: none. (Sessions are derived from `Status='Open'` rows, not a separate sessions table — parity note.)

---

### Inventory

#### `GET /api/inventory/stock`
- **Query**: `search: Optional[str]`, `low_only: bool = False`, `limit: int = 50`.
- **Logic**: latest snapshot `MAX(Generate_Date)`. Dynamic WHERE: always `Generate_Date = snap`; if `search` → `(Item_ID LIKE ? OR Item_Description LIKE ?)` with `%search%`; if `low_only` → `AV_QTY <= 0`.
- **SQL fields**: `Item_ID, Item_Description, UOM, Temperature_Type, AV_QTY, Total_Stock, "Expired Date" AS Expiry_Date, BU_ID`. `ORDER BY AV_QTY ASC LIMIT ?`.
- **Computed**: `low_stock_count = count of returned rows with AV_QTY <= 0` (post-query, over the limited result set only).
- **Response**: `{snapshot_date, items, total(len), low_stock_count}`. Auth: none.
- **Parity**: column `"Expired Date"` has a space (quoted identifier) aliased to `Expiry_Date`; `Temperature_Type` (cold-chain) easy to drop.

#### `GET /api/inventory/stock/{item_id}` (drill-down)
- **Path**: `item_id: str`. Uses latest snapshot.
- **Returns**: `item` (same fields as stock list; 404 `"Item {item_id} not found"`), `recent_sales` (LIMIT 15: join items↔sales, `Sale_No, Sale_Date, Customer_Name, Qty, Unit_Price, Amount`, non-Voided, `ORDER BY Sale_Date DESC`), `recent_pos` (LIMIT 15: join `tbl_po_items`↔`tbl_purchase_orders`, `PO_No, PO_Date, Supplier AS Supplier_Name, Status, Order_Qty, Unit_Price, Amount, Received_Qty`), `sales_30d` (`SUM Qty total_qty, SUM Amount total_revenue, COUNT sale_count` where `Sale_Date >= date('now','-30 days')`, non-Voided).
- **Response**: `{item, snapshot_date, recent_sales, recent_pos, sales_30d}`. Tables: `tbl_raw_inventory, tbl_cust_pos_items, tbl_cust_pos_sales, tbl_po_items, tbl_purchase_orders`. Auth: none.

#### `GET /api/inventory/suppliers`
- **SQL**: `tbl_suppliers`: `Supplier_ID, Supplier_Name, Contact AS Contact_Person, Phone, Email, Payment_Terms ORDER BY Supplier_Name`.
- **Response**: `{suppliers, count}`. Auth: none.

#### `GET /api/inventory/suppliers/{supplier_id}` (drill-down)
- **Path**: `supplier_id: str`. 404 `"Supplier not found"`.
- **Logic**: gets `sup`, then `sname = sup["Supplier_Name"]`. Subsequent queries match on **either name or id** (`Supplier = ? OR Supplier = ?` with `(sname, supplier_id)`; AP `(Creditor_Name = ? OR Creditor_ID = ?)`). PARITY-CRITICAL: PO/AP linkage is by supplier **name OR id** because `tbl_purchase_orders.Supplier` may store either.
- **Returns**: `supplier`; `recent_pos` (LIMIT 20: `PO_No, PO_Date, Status, Total_Amount, Expected_Date AS Expected_Delivery`); `ap_balance` (`SUM(Amount-Paid_Amount) outstanding, COUNT open_invoices`, Status≠Paid); `lifetime` (`SUM Total_Amount lifetime_value, COUNT po_count`).
- **Response**: `{supplier, recent_pos, ap_balance, lifetime}`. Auth: none.

#### `GET /api/inventory/purchase-orders`
- **Query**: `limit=20, offset=0, status: Optional[str]`.
- **SQL**: `tbl_purchase_orders po`, optional `WHERE po.Status = ?`. Fields: `PO_No, PO_Date, Supplier AS Supplier_Name, Status, Total_Amount, Expected_Date AS Expected_Delivery`. `ORDER BY po.PO_No DESC LIMIT ? OFFSET ?`.
- **Response**: `{purchase_orders, count}`. Auth: none.

#### `GET /api/inventory/purchase-orders/{po_no}` (drill-down)
- **Path**: `po_no: str`. 404 `"PO not found"`.
- **Returns**: `po` (`PO_No, PO_Date, Supplier AS Supplier_Name, Status, Total_Amount, Expected_Date AS Expected_Delivery, Created_By, Approved_By, Approved_At, Remarks`) + `items` from `tbl_po_items` (`Item_ID, Item_Description, Order_Qty, Unit_Price, UOM, Amount, Received_Qty, Status`).
- **Response**: `{po, items}`. Auth: none. **Parity**: PO approval workflow fields (`Approved_By, Approved_At, Created_By, Remarks`) and per-line `Received_Qty`/`Status` (partial-receipt tracking) easy to drop.

---

### Finance

#### `GET /api/finance/pl`
- **Query (required)**: `month: int`, `year: int`.
- **Date window (PARITY-CRITICAL bug-prone logic)**: `start = f"{year}-{month:02d}-01"`; `end = f"{year}-{month+1:02d}-01"` if `month < 12` else `f"{year}-12-31"`. For December the window is `>= {year}-12-01 AND < {year}-12-31` — **Dec 31 sales are excluded** (uses `<` end and end=Dec-31). A faithful rewrite must replicate this off-by-one to match numbers, or deliberately fix it.
- **POS query**: `tbl_cust_pos_sales` non-Voided in `[start, end)`: `revenue(SUM Subtotal), discounts(SUM Discount), tax_collected(SUM Tax_Amount), net_revenue(SUM Total), order_count`.
- **AP query**: `tbl_ap_transactions` `WHERE Due_Date >= start AND Due_Date < end AND Status = 'Paid'` → `total_paid(SUM Amount)`. Note: expenses keyed on **Due_Date**, not a payment date.
- **Computed**: `gross_profit = net_revenue - expenses_paid`.
- **Response**: `{month, year, revenue, discounts, tax_collected, net_revenue, order_count, expenses_paid, gross_profit}`. Auth: none.

#### `GET /api/finance/ap`
- **Query**: `status: Optional[str] = "Outstanding"` (default!), `limit=20, offset=0`.
- **SQL**: `tbl_ap_transactions ap`, `WHERE Status = ?` (default filters `Status='Outstanding'`). Fields: `Txn_No AS Transaction_ID, Creditor_ID, Creditor_Name, Amount, (Amount-COALESCE(Paid_Amount,0)) AS Outstanding_Amount, Due_Date, Status, Invoice_No`. `ORDER BY Due_Date ASC`.
- **Computed**: `total_outstanding = sum(Outstanding_Amount of returned rows)` (page-only sum).
- **Response**: `{transactions, count, total_outstanding}`. Auth: none. **Parity**: default status filter is the literal string `"Outstanding"` — must match the status vocabulary used elsewhere (`'Paid'`, `'Open'`, `'Voided'`, `'Outstanding'`).

#### `GET /api/finance/ar`
- **Query**: `limit=20, offset=0` (no status filter).
- **SQL**: `tbl_ar_invoices`: `Invoice_No, Customer_Name, Invoice_Date, Due_Date, Amount, (Amount-COALESCE(Paid_Amount,0)) AS Outstanding_Amount, Status ORDER BY Due_Date ASC`.
- **Computed**: `total_outstanding` (page-only sum).
- **Response**: `{invoices, count, total_outstanding}`. Auth: none.

#### `GET /api/finance/kpi`
- **Params**: none. Server clock.
- **Queries**: MTD (`Sale_Date BETWEEN month-start AND today`, non-Voided → `mtd_revenue, mtd_orders`); YTD (`strftime('%Y',Sale_Date)=year` → `ytd_revenue, ytd_orders`); `ap_outstanding` (`SUM(Amount-Paid_Amount) WHERE Status != 'Paid'` from `tbl_ap_transactions`); `ar_outstanding` (same from `tbl_ar_invoices`).
- **Response**: `{mtd_revenue, mtd_orders, ytd_revenue, ytd_orders, ap_outstanding, ar_outstanding}`. Auth: none.
- **Parity**: YTD uses SQLite `strftime('%Y', Sale_Date)` — SQLite-specific; a Postgres rewrite must translate to `EXTRACT(YEAR ...)`/`to_char`. (Codebase is migrating to PostgreSQL per git log — flag all `date('now',...)`/`strftime` usages.)

---

### Customers

#### `GET /api/customers/{name}`
- **Path**: `name: str` (the customer name itself is the key — no customer id table; **customer identity = `Customer_Name` string**).
- **Returns**: `orders` (LIMIT 20: `Sale_No, Sale_Date, Total, Payment_Method, Status` for that name, all statuses incl. Voided, `ORDER BY Sale_Date DESC, Sale_No DESC`); `stats` (`lifetime_value(SUM Total), order_count, last_order_date(MAX), first_order_date(MIN)` — non-Voided only); `ar_balance` (`SUM(Amount-Paid_Amount) outstanding, COUNT open_invoices` from `tbl_ar_invoices` where name & Status≠Paid).
- **Response**: `{customer_name, orders, stats, ar_balance}`. Auth: none. No 404 (returns empty/zero for unknown names).
- **Parity note**: `orders` list includes Voided rows but `stats` excludes them — intentional asymmetry.

---

### AI Chat

#### `POST /api/chat`
- **Body**: `ChatRequest {message, history=[], agent_type="erp"}` (`agent_type` ignored).
- **Logic**: 500 if `ANTHROPIC_API_KEY` unset. Builds `system_prompt` embedding `CONFIG['company_name']` and today's date; instructs bilingual replies ("Respond in the same language the user uses (Thai or English)") — **i18n-critical**. `messages = history[-10:] + [{"role":"user","content":message}]`.
- **Model**: `claude-opus-4-5`, `max_tokens=1024`. (Note: model id `claude-opus-4-5` — verify against current model catalog; may need update in a rewrite.)
- **Reply**: `response.content[0].text`; `new_history = messages + [{assistant reply}]` truncated to last 20.
- **Response**: `{reply, history}` (history capped at 20). Errors → 500 with `str(e)`.
- **Auth**: none. No DB/tool access — pure LLM passthrough (does NOT call ERP tools despite system prompt claiming "real-time data"; **the chat cannot actually query the ERP** — important parity expectation gap).

---

### Reports

#### `GET /api/reports/daily-sales`
- **Query**: `date: Optional[str]` (defaults to today).
- **SQL**: `tbl_cust_pos_sales s LEFT JOIN tbl_cust_pos_items i ON s.Sale_No=i.Sale_No WHERE s.Sale_Date=? AND s.Status!='Voided' ORDER BY s.Sale_No`. Fields: `Sale_No, Sale_Date, Total, Payment_Method, Status, Item_Description, Qty, Unit_Price, Amount` (one row per line item; LEFT JOIN so item-less orders still appear).
- **Response**: `{date, rows, count}`. Auth: none.

#### `GET /api/reports/stock-summary`
- **Params**: none. Latest snapshot.
- **SQL**: `tbl_raw_inventory WHERE Generate_Date = snap`: `Item_ID, Item_Description, UOM, AV_QTY, Total_Stock, Temperature_Type, "Expired Date" AS Expiry_Date ORDER BY Item_Description`.
- **Response**: `{snapshot_date, items, count}`. Auth: none.

---

### `GET /api/notifications` (GENERATION LOGIC — parity-critical, bilingual)
- **Params**: none. Builds a flat `alerts` list from three sources, each capped LIMIT 30:
  1. **low_stock** — latest snapshot, `AV_QTY <= 0`, `ORDER BY AV_QTY ASC`. Per row:
     - `type:"low_stock"`, `severity:"warning"`, `title = Item_Description or Item_ID`, `subtitle = f"Item: {Item_ID} · Qty: {AV_QTY} {UOM}"`, `ref_id = Item_ID`. (English subtitle, `·` separator.)
  2. **overdue_ap** — `tbl_ap_transactions WHERE Status != 'Paid' AND Due_Date < date('now') ORDER BY Due_Date ASC`. Per row:
     - `type:"overdue_ap"`, `severity:"danger"`, `title = f"AP เกินกำหนด: {Creditor_Name}"` (**Thai** "เกินกำหนด" = overdue), `subtitle = f"Invoice {Invoice_No} · Due {Due_Date} · ฿{Outstanding_Amount:,.2f}"` (**Thai Baht ฿**, thousands sep, 2 decimals), `ref_id = Transaction_ID`, plus full `data` object.
  3. **overdue_ar** — `tbl_ar_invoices WHERE Status != 'Paid' AND Due_Date < date('now') ORDER BY Due_Date ASC`. Per row:
     - `type:"overdue_ar"`, `severity:"danger"`, `title = f"AR เกินกำหนด: {Customer_Name}"`, same subtitle format, `ref_id = Invoice_No`, full `data`.
- **Response**:
```json
{
  "alerts": [ {type, severity, title, subtitle, ref_id, [data]} ],
  "counts": {"low_stock":N, "overdue_ap":N, "overdue_ar":N, "total":N}
}
```
- **PARITY-CRITICAL**: mixed-language alert strings (Thai titles `AP/AR เกินกำหนด:`, ฿ currency formatting `:,.2f`, `·` middot separators), `severity` enum (`warning`/`danger`), and the three `type` codes (`low_stock`/`overdue_ap`/`overdue_ar`) are a hard contract the mobile UI keys on. `low_stock` alerts omit `data`; AP/AR include it. All use `date('now')` (SQLite) for the overdue cutoff.

---

### Analytics (delegates to `analytics/` package)

Imports: `analytics.forecasting.{predict_stockout, get_replenishment_list}`, `analytics.anomalies.get_anomaly_summary`, `analytics.llm_insights.{get_replenishment_insight, get_anomaly_insight, get_bulk_insight}`. The heavy logic lives in those modules (not in this file) — **flag for separate reverse-engineering**.

#### `GET /api/analytics/replenishment`
- **Query**: `limit: int = 50`. → `get_replenishment_list(limit)`.
- **Response**: `{items, count, critical(count urgency=="critical"), warning(count urgency=="warning")}`. Each item is expected to have a `"urgency"` field. Auth: none.

#### `GET /api/analytics/replenishment/{item_id}`
- **Path**: `item_id: str`. `pred = predict_stockout(item_id)`; `insight = get_replenishment_insight(pred)`.
- **Response**: `{**pred, "insight": insight}` (prediction fields spread + LLM `insight` string). Auth: none.

#### `GET /api/analytics/anomalies`
- **Query**: `days: int = 30`. → `get_anomaly_summary(days)` returned **verbatim** (shape defined in `analytics.anomalies`). Auth: none.

#### `POST /api/analytics/insight`
- **Body**: `InsightRequest {type, data}`. If `type=="replenishment"` → `get_replenishment_insight(data)`; if `"anomaly"` → `get_anomaly_insight(data)`; else 400 `"type must be 'replenishment' or 'anomaly'"`.
- **Response**: `{insight: <text>}`. Auth: none.

#### `GET /api/analytics/dashboard-summary`
- **Params**: none. `repl_items = get_replenishment_list(10)`; `anomaly = get_anomaly_summary(7)`; `insight = get_bulk_insight(repl_items, anomaly)`.
- **Response**:
```json
{
  "replenishment": {"critical":N, "warning":N, "top_items": repl_items[:3]},
  "anomalies": anomaly["summary"],
  "insight": <text>
}
```
- Depends on `anomaly` having a `"summary"` key and items having `"urgency"`. Auth: none.

---

## Cross-cutting parity flags (easy to silently drop in a rewrite)

1. **No auth/RBAC/tenant scoping on any data endpoint** — token system exists but is unenforced; `role`/`customer_name` never used to scope data. This is the current contract.
2. **SQLite-isms**: `date('now', ...)`, `strftime('%Y', ...)`, quoted `"Expired Date"` identifier, `?` placeholders. Codebase is migrating to PostgreSQL (per git log) → these must be translated or behavior diverges.
3. **`Status != 'Voided'`** consistently excludes voided sales; **`AV_QTY <= 0`** (≤, includes negatives) defines low-stock; **inventory always keyed to latest `MAX(Generate_Date)` snapshot**.
4. **Bilingual strings**: Thai login error, Thai notification titles (`เกินกำหนด`), ฿ currency formatting, chat "reply in user's language" prompt.
5. **December P&L off-by-one** (`/api/finance/pl` end=`Dec-31` with `<`, excluding Dec 31).
6. **Page-only aggregate sums** in `/api/finance/ap`, `/api/finance/ar` (`total_outstanding` sums only the returned page, not the full set).
7. **Supplier/AP linkage by name OR id** (`tbl_purchase_orders.Supplier` and `tbl_ap_transactions.Creditor_*` may hold either) — drilldowns query both.
8. **Customer identity = `Customer_Name` string** (no customer id); `/api/customers/{name}` keys on the raw name.
9. **`/api/chat` has no tool/DB access** despite a system prompt claiming real-time ERP data — model `claude-opus-4-5`, `max_tokens=1024`, history windowed to 10 in / 20 out.
10. **`execute` imported but unused** — entire REST surface is read-only except `/api/login` (reads user store) and `/api/chat`.
11. **Default `JWT_SECRET`** `"invisible-erp-secret-change-me"` and **wildcard CORS** — security-sensitive defaults baked into the contract.
12. **`/api/finance/ap` default `status="Outstanding"`**, `/api/pos/orders` & `purchase-orders` status passthrough — status vocabulary (`Paid/Open/Voided/Outstanding`) is a shared enum across endpoints.