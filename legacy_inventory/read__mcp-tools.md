I have everything needed. The grep confirms there is **no** Postgres handling, no `reportlab`, no PDF generation, and no THSarabunNew font anywhere in `erp_mcp/` — those concepts from the task brief do not exist in this code. Here is the exhaustive reverse-engineering report.

---

# Invisible ERP — MCP Server Reverse-Engineering Report

## Scope & Critical Findings Up Front

- **Only 5 Python files** make up the entire MCP backend: `server.py`, `db.py`, and 4 tool modules. There is **no `agent.py`, no `mcp_server.py`, no `streamlit_chat_page.py`** under `erp_mcp/` despite CLAUDE.md referencing them — those paths in the architecture docs are **stale/aspirational**. The real entry point is `erp_mcp/server.py`.
- **PARITY FLAG — Postgres handling does NOT exist.** The task brief asked about "SQLite vs Postgres handling." `db.py` is **pure SQLite (`sqlite3`)**. There is zero `psycopg2`/Postgres code in `erp_mcp/`. (The git log mentions a "shared PostgreSQL user store," but that lives **outside** this MCP package and is not wired into these tools. Do not assume these tools talk to Postgres.)
- **PARITY FLAG — PDF generation does NOT exist.** Reports advertise `"pdf"` in their `formats` list and a docstring says `format: 'excel' (pdf stub)`, but **every generator only ever produces `.xlsx` via `openpyxl`**. The `format` parameter is **accepted and silently ignored** — passing `format="pdf"` still writes an Excel file. **There is no `reportlab`, no `THSarabunNew` Thai font, no PDF code at all.** A rewrite that "implements the PDF path" would be adding net-new functionality, not porting existing behavior.
- **PARITY FLAG — i18n / Thai text:** No translation layer. All labels are hardcoded English. Currency is hardcoded **THB** throughout (field suffixes `_thb`, format strings `{:,.2f} THB`). Thai data may exist in DB columns (`Item_Description`, `Customer_Name`) and is passed through verbatim; `json.dumps(..., ensure_ascii=False)` in `server.py` preserves Unicode.
- **PARITY FLAG — No RBAC, no auth, no multi-tenant scoping.** `authorized_by` / `created_by` / `adjusted_by` are **free-text strings written to columns**, not validated against any user/role table. Any caller can void orders or adjust stock. No `customer_id`/tenant filter anywhere — single-branch, single-tenant assumption is baked in (`branch` params are accepted but **largely ignored**, see per-tool notes).

---

## `erp_mcp/server.py` — MCP Entry Point

- Built on **FastMCP** (`from fastmcp import FastMCP`). Server name `"ERP-POS Agent Server"`, version `"2.0.0"`.
- Inserts project root (`Path(__file__).parent.parent`) onto `sys.path` so it runs both as a module and directly.
- Registers 4 tool domains by calling `register_pos_tools(mcp)`, `register_inventory_tools(mcp)`, `register_finance_tools(mcp)`, `register_report_tools(mcp)`.
- **One MCP resource**: `erp://status` → `get_server_status()` returns a JSON string (`ensure_ascii=False, indent=2`) with `status`, `server`, `version`, `timestamp` (`datetime.now().isoformat()`), `db_path` (str of `DB_PATH`), `domains`, and a **hardcoded list of 20 tool names**. PARITY NOTE: this tool list is maintained **by hand** and can drift from actually-registered tools (e.g. it lists `generate_ap_aging_report` is *not* here, but `get_available_reports` advertises it — see Reports).
- `if __name__ == "__main__": mcp.run()` — default FastMCP stdio transport. The module docstring's `uvicorn mcp.server:mcp` hint uses a wrong module path (`mcp.server`, not `erp_mcp.server`).

---

## `erp_mcp/db.py` — SQLite Connection Helpers

**DB_PATH resolution (precedence order):**
1. **`DB_PATH` env var** — if set, used verbatim as a `Path` (comment: Railway volume e.g. `/data/...`). Overrides everything.
2. Else read **`config.json`** at project root (`_PROJECT_ROOT / "config.json"`); use its `db_filename` key, default `"Inventory_Master_DB.sqlite"`, resolved relative to project root.
3. Else fallback to `_PROJECT_ROOT / "Inventory_Master_DB.sqlite"`.

`_PROJECT_ROOT = Path(__file__).parent.parent` (the `Invisible ERP/` folder, i.e. one level **above** `erp_mcp/`).

**`get_conn()`** — `@contextmanager`:
- `sqlite3.connect(str(DB_PATH))`, `conn.row_factory = sqlite3.Row` (rows act dict-like).
- `PRAGMA journal_mode=WAL` (concurrent-read safe).
- On success **commits**; on any exception **rolls back and re-raises**; always closes in `finally`.

**Helpers:**
| Helper | Signature | Returns |
|---|---|---|
| `fetchall` | `(sql, params=())` | `list[dict]` — `[dict(r) for r in rows]` |
| `fetchone` | `(sql, params=())` | `dict \| None` — first row or `None` |
| `execute` | `(sql, params=())` | `int` — `cur.rowcount` (commit handled by ctx mgr) |

**PARITY FLAGS for db.py:**
- **Pure SQLite only.** No driver abstraction, no Postgres branch. A Postgres rewrite must re-author all SQL — note SQLite-specific syntax in use: `date('now')` (finance), double-quoted identifier `"Expired Date"` / `"Expired Date" AS Expiry_Date` (column literally has a space in its name), `MAX(Generate_Date)` string-date comparison, `BETWEEN ? AND ?` on **text** dates (lexicographic, relies on `YYYY-MM-DD` format).
- `execute()` returns `rowcount` from inside the `with` block but reads `cur.rowcount` **after** the block context — works because commit already ran; fine for SQLite.
- No connection pooling — every call opens/closes a fresh connection.

---

## POS Tools (`tools/pos_tools.py`)

Tables: **`tbl_cust_pos_sales`** (header), **`tbl_cust_pos_items`** (lines), **`tbl_scan_sessions`**.
Key header columns: `Sale_No` (PK-ish, e.g. `"POS-0001"`), `Sale_Date` (text `YYYY-MM-DD`), `Customer_Name`, `Subtotal`, `Discount`, `Tax_Amount`, `Total`, `Payment_Method`, `Status`, `Created_By`, `Notes`, `id` (autoincrement). Line columns: `Sale_No`, `Item_Description`, `Qty`, `Amount`, `id`.
**Status workflow:** sales are filtered with `Status != 'Voided'`; the only state transition implemented is → `'Voided'`.

| Tool | Signature | Logic / tables | Returns |
|---|---|---|---|
| **`get_sales_summary`** | `(start_date:str, end_date:str, branch:Optional[str]=None)` | Header aggregate over `tbl_cust_pos_sales` where `Sale_Date BETWEEN ? AND ?` and `Status!='Voided'`: COUNT, SUM(Subtotal/Discount/Tax_Amount/Total). Top-5 items by `SUM(Amount)` via JOIN to `tbl_cust_pos_items` grouped by `Item_Description`. Payment breakdown grouped by `Payment_Method`. `avg = total_sales/orders` (guards div-by-zero). **`branch` is accepted but NOT used in any query** — only echoed back as `branch or "ALL"`. | `{period, branch, total_orders, total_sales_thb, total_discount_thb, total_tax_thb, avg_order_value_thb, top_items[], by_payment_method[]}` |
| **`get_open_sessions`** | `()` | Reads `tbl_scan_sessions WHERE Status='Open' ORDER BY Created_At DESC`; wraps each row adding a static `note`. Then today's totals from `tbl_cust_pos_sales WHERE Sale_Date=today AND Status!='Voided'` (`today` = `datetime.now()` local). | `{open_sessions[], today_sales_thb, today_orders}` |
| **`get_order_detail`** | `(order_id:str)` | `fetchone` header by `Sale_No=?`; if missing → `{"error":...}`. Else `fetchall` lines `WHERE Sale_No=? ORDER BY id`. | `{**header, lines:[...]}` or `{error}` |
| **`get_recent_orders`** | `(limit:int=10)` | Selects 7 columns `ORDER BY id DESC LIMIT ?`. | `{orders:[...], count}` |
| **`void_order`** | `(order_id:str, reason:str, authorized_by:str)` | Checks existence + current Status; rejects if already `'Voided'`. `UPDATE ... SET Status='Voided', Notes=? WHERE Sale_No=?` where Notes becomes `"Voided by {authorized_by}: {reason}"`. **WRITE op.** **No RBAC** — `authorized_by` is free text, not verified. **Overwrites `Notes`** (does not append). | `{success, order_id, voided_at, reason, authorized_by, message}` or `{success:False, error}` |

PARITY NOTE: `get_open_sessions` returns **scan** sessions (`tbl_scan_sessions`), not cashier till sessions — there is no true open/close-till accounting. Void does **not** reverse stock movements or financials; it only flips the header flag.

---

## Inventory Tools (`tools/inventory_tools.py`)

Tables: **`tbl_raw_inventory`** (snapshot — multiple `Generate_Date` versions), **`tbl_purchase_orders`**, **`tbl_po_items`**, **`tbl_suppliers`**, **`tbl_cust_my_suppliers`** (fallback), **`tbl_stock_movements`**.
Snapshot pattern: inventory tools **always resolve the latest `MAX(Generate_Date)` first**, then filter on it — historical snapshots are ignored. Column `"Expired Date"` (space in name) is aliased to `Expiry_Date`. "Below reorder" is defined as **`AV_QTY <= 0`** (there is **no per-item reorder threshold** — flag this; a real reorder point is silently absent).

| Tool | Signature | Logic / tables | Returns |
|---|---|---|---|
| **`get_stock_levels`** | `(search:Optional[str]=None, below_reorder_only:bool=False, limit:int=50)` | Latest snapshot date; dynamic WHERE: `Generate_Date=?`, optional `(Item_ID LIKE ? OR Item_Description LIKE ?)`, optional `AV_QTY<=0`. `ORDER BY AV_QTY ASC LIMIT ?`. `low_stock_count` computed in Python. | `{snapshot_date, total_items, low_stock_count, items[]}` |
| **`get_stock_item`** | `(item_id:str)` | Latest-snapshot row for `Item_ID`; plus last 10 `tbl_stock_movements` `ORDER BY Move_Date DESC`. Missing → `{error}`. | `{item:{...}, recent_movements[]}` or `{error}` |
| **`get_supplier_list`** | `()` | `tbl_suppliers WHERE Active=1 ORDER BY Supplier_Name`; **if empty, falls back** to `tbl_cust_my_suppliers ORDER BY rowid DESC LIMIT 100`. | `{suppliers[], count}` |
| **`create_purchase_order`** | `(supplier:str, items:list, expected_delivery_date:str, notes:Optional[str]=None, created_by:str="AI Agent")` | **WRITE.** PO number = **`PO-{YYYYMMDD}-{random 1000-9999}`** (random suffix → collision-possible, non-sequential). `total = Σ qty*unit_price`. Inserts header into `tbl_purchase_orders` (`Status='Draft'`, `PO_Date=today`). Loops items → inserts `tbl_po_items` (`Received_Qty=0`, `Status='Pending'`, `Amount=qty*unit_price`). Each `item` dict keys: `item_id, item_description, qty, unit_price, uom`. | `{success, po_number, supplier, items_count, total_amount_thb, expected_delivery, status:"Draft", message}` |
| **`adjust_stock`** | `(item_id:str, adjustment_qty:float, reason:str, adjusted_by:str, from_location:str="Warehouse", to_location:str="Adjustment")` | **WRITE.** Looks up item (latest `Generate_Date`). Doc no = **`ADJ-{YYYYMMDDHHMMSS}`**. `move_type = 'Stock In' if qty>=0 else 'Stock Out'`. Inserts into `tbl_stock_movements` with `Qty=abs(qty)` and location logic: in→`(from_location → 'Stock')`, out→`('Stock' → to_location)`. **Does NOT mutate `tbl_raw_inventory` `AV_QTY`** — only logs a movement row; on-hand isn't recomputed here. | `{success, doc_no, item_id, item_description, adjustment, move_type, reason, adjusted_by, message}` or `{error}` |
| **`get_purchase_orders`** | `(status:Optional[str]=None, limit:int=20)` | Filter by `Status=?` if given, else all; `ORDER BY PO_Date DESC LIMIT ?`. For each PO, attaches its `tbl_po_items` (N+1 query). Docstring lists statuses `Draft/Confirmed/Received/Cancelled`. | `{purchase_orders:[{...,items:[...]}], count}` |

PARITY FLAGS: PO numbering is **random, not a monotonic sequence** — a rewrite using a sequence/counter would change document numbers and could break dedupe. `adjust_stock` writing to movements without updating snapshot quantities is a **data-model quirk to preserve**. PO status lifecycle (`Draft→Confirmed→Received→Cancelled`) is **documented but not enforced** anywhere — only `'Draft'` is ever written; there's no "receive PO" tool that increments `Received_Qty`.

---

## Finance Tools (`tools/finance_tools.py`)

Tables: **`tbl_cust_pos_sales`**, **`tbl_sales_orders`** (`Order_No`, `Order_Date`, `Total_Price`, `Status`), **`tbl_ap_transactions`**, **`tbl_ar_invoices`** (both: `Amount`, `Paid_Amount`, `Due_Date`, `Status`).
Revenue model: **POS net = SUM(Total)**; **SO = SUM(Total_Price)** excluding `Status IN ('Cancelled','Rejected')`. Open-invoice filter: `Status NOT IN ('Paid','Cancelled')`. **COGS/expenses/margins/bank balances are explicitly NOT in the DB** — every finance tool returns a `note` saying so. This is **revenue-only "P&L," not true profit**.

| Tool | Signature | Logic / tables | Returns |
|---|---|---|---|
| **`get_pl_summary`** | `(month:int, year:int, branch:Optional[str]=None)` | Month window `start=YYYY-MM-01`, `end` = first of next month (Dec→`YYYY-12-31`). POS aggregate (Subtotal/Discount/Tax_Amount/Total, count) `Status!='Voided'`. SO revenue `SUM(Total_Price)`, distinct `Order_No`, excl Cancelled/Rejected. `total_revenue = pos_net + so`. **`branch` ignored** (echoed as `branch or "Consolidated"`). | `{period, branch, pos_revenue_thb, so_revenue_thb, total_revenue_thb, pos_order_count, so_count, tax_collected_thb, note}` |
| **`get_accounts_payable`** | `(overdue_only:bool=False)` | `tbl_ap_transactions` where `Status NOT IN ('Paid','Cancelled')`; computes `is_overdue = Due_Date < today` (SQL CASE). overdue_only adds `Due_Date<?`; else `LIMIT 100`. Python sums: total payable, total paid, **overdue = Σ(Amount−Paid_Amount) for overdue rows**. `today = date.today().isoformat()`. | `{total_payable_thb, total_paid_thb, outstanding_thb, overdue_thb, invoice_count, invoices[]}` |
| **`get_accounts_receivable`** | `(overdue_only:bool=False)` | Mirror of AP on `tbl_ar_invoices`. (Note: returns no `overdue_thb` field, unlike AP — asymmetry to preserve.) | `{total_receivable_thb, total_collected_thb, outstanding_thb, invoice_count, invoices[]}` |
| **`get_kpi_dashboard`** | `(year:int, quarter:Optional[int]=None)` | Quarter→date windows via hardcoded maps `q_starts/q_ends` (Q1 01-01→03-31 … Q4 10-01→12-31); else full year. POS revenue/orders/avg + SO revenue + overdue AP (`SUM(Amount−Paid_Amount)` where open and `Due_Date < date('now')`). | `{period, total_revenue_thb, pos_revenue_thb, so_revenue_thb, total_pos_orders, avg_pos_order_thb, overdue_payables_thb, note}` |
| **`get_cash_position`** | `()` | Open AP and AR sums; `outstanding_ap = total_ap−paid_ap`, `outstanding_ar = total_ar−collected_ar`; `net_working_capital = AR−AP`. Used as a **proxy** for cash (note: bank balances not stored). | `{as_of, outstanding_payables_thb, outstanding_receivables_thb, net_working_capital_thb, note}` |

PARITY FLAGS: `get_pl_summary` end-of-month logic for December uses `YYYY-12-31` with a `<` comparison, so **Dec 31 sales are excluded** (off-by-one — Jan–Nov use `< first-of-next-month` which is inclusive of month-end; Dec is not). `get_kpi_dashboard` uses `BETWEEN ? AND ?` with `end=...-12-31`/quarter-end which is **inclusive**, inconsistent with `get_pl_summary`'s exclusive bound. These date-boundary inconsistencies are easy to "fix" in a rewrite and thereby change the numbers — preserve deliberately or document.

---

## Report Tools (`tools/report_tools.py`)

Output dir: **`_REPORTS_DIR = <project_root>/reports/`** (note: `Path(__file__).parent.parent.parent` — three levels up, i.e. the parent of `Invisible ERP/`, **not** inside it; `_ensure_reports_dir()` `mkdir(exist_ok=True)`). All generators import `openpyxl` lazily and return `{success:False, error:"openpyxl not installed..."}` on ImportError. Header styling is consistent: fill color `1E3C72` (dark navy), white bold font.

| Tool | Signature | Logic / tables / sheets | Output file | Returns |
|---|---|---|---|---|
| **`get_available_reports`** | `()` | Static catalog of 5 report templates. | — | `{reports:[{id,name,description,frequency,formats,tool}×5]}` |
| **`generate_daily_report`** | `(report_date:str, branch:Optional[str]=None, format:str="excel")` | Orders for the day (`Status!='Voided'`), day totals, top-10 items (JOIN items↔sales). Workbook: sheet **"Daily Sales"** (title A1, summary A2 with `… THB` + generated timestamp, header row 4, 10 cols), sheet **"Top Items"**. `branch` appended to filename only. **`format` IGNORED** → always `.xlsx`. | `daily_report_{date}{_branch?}.xlsx` | `{success, filename, path, orders_included, total_revenue_thb, generated_at, message}` |
| **`generate_monthly_pl`** | `(month:int, year:int, format:str="excel")` | Month window (`end` = next-month-01, or `{year+1}-01-01` for Dec — note: **different/correct** Dec handling vs `get_pl_summary`, another inconsistency). Daily breakdown grouped by `Sale_Date`; month totals. Single sheet "Monthly Revenue". **`format` ignored.** | `monthly_revenue_{year}_{MM}.xlsx` | `{success, filename, path, total_revenue_thb, total_orders, generated_at, message}` |
| **`generate_stock_report`** | `(below_reorder_only:bool=False)` | Latest snapshot; `condition = "AV_QTY <= 0"` or `"1=1"`; `LIMIT 5000`. Sheet "Stock Snapshot", 8 cols, title flags `[LOW STOCK ONLY]`. | `stock_snapshot_{YYYYMMDD}{_low_stock?}.xlsx` | `{success, filename, path, snapshot_date, items_included, generated_at, message}` |

**MAJOR PARITY FLAGS (Reports):**
- **`generate_ap_aging_report` does not exist.** `get_available_reports` advertises a report `id:"ap_aging"` with `tool:"generate_ap_aging_report"`, but **no such tool is registered** (and it is not in `server.py`'s status list). The catalog lies. Either implement or note the gap.
- The `low_stock_alert` catalog entry points at `tool:"generate_stock_report (below_reorder_only=True)"` — a string, not a separate tool; it reuses `generate_stock_report`.
- **No PDF, no Thai font.** Despite `formats:["excel","pdf"]` and the docstring "pdf stub," **PDF output is entirely unimplemented**. There is **no `THSarabunNew`/`reportlab`/font embedding anywhere in `erp_mcp/`.** Any claim of Thai-PDF parity is false for this codebase. If the rewrite needs Thai PDF invoices/receipts, that is **new work**, not a port.
- Reports write to **`<parent-of-project>/reports/`**, a path *outside* the project dir — easy to relocate incorrectly in a rewrite (would break the returned `path`/`message` consumers).

---

## Cross-Cutting Parity Checklist (things easy to silently drop)

1. **No Postgres** — all SQL is SQLite-dialect (`date('now')`, quoted `"Expired Date"`, lexicographic text-date `BETWEEN`). Porting drivers requires SQL rewrites.
2. **No PDF / no THSarabunNew Thai font / no reportlab** — only `.xlsx` via openpyxl; `format` param is a no-op.
3. **Phantom tool** `generate_ap_aging_report` advertised but unimplemented.
4. **Document numbering**: PO = `PO-{YYYYMMDD}-{random4}` (non-sequential, collision-prone); adjustments = `ADJ-{YYYYMMDDHHMMSS}`. No counter tables.
5. **Status workflows are mostly unenforced**: only POS `→Voided` and PO `→Draft` are ever written; documented PO lifecycle (`Confirmed/Received/Cancelled`) and `Received_Qty` increments have **no implementing tool**.
6. **`branch` parameters are decorative** in `get_sales_summary`, `get_pl_summary`, `generate_daily_report` (filename only) — single-branch system; no real multi-branch filtering.
7. **No RBAC/auth/tenant scoping**: `authorized_by`/`created_by`/`adjusted_by` are unvalidated free text persisted to columns.
8. **Finance is revenue-only** (no COGS/margin/EBITDA/bank cash); cash position is an AR−AP proxy. Each tool self-documents this via a `note` field — preserve the note semantics.
9. **Date-boundary inconsistencies** between `get_pl_summary` (Dec off-by-one, exclusive end), `get_kpi_dashboard` (inclusive `BETWEEN`), and `generate_monthly_pl` (correct Dec rollover). Numbers will shift if "cleaned up."
10. **`adjust_stock` and `void_order` do not cascade** — adjustments log a movement without recomputing `AV_QTY`; voids don't reverse stock/finance.
11. **`erp://status` tool list and report catalog are hand-maintained** and already drift from reality.
12. **Stale architecture docs**: CLAUDE.md references `mcp_server.py`, `agent.py`, `streamlit_chat_page.py`, `psycopg2`, mock data — none of these exist in `erp_mcp/`. The real surface is exactly the 5 files documented above.

**Relevant file paths:**
- `C:/Users/ASUS/Invisible ERP/erp_mcp/server.py`
- `C:/Users/ASUS/Invisible ERP/erp_mcp/db.py`
- `C:/Users/ASUS/Invisible ERP/erp_mcp/tools/pos_tools.py`
- `C:/Users/ASUS/Invisible ERP/erp_mcp/tools/inventory_tools.py`
- `C:/Users/ASUS/Invisible ERP/erp_mcp/tools/finance_tools.py`
- `C:/Users/ASUS/Invisible ERP/erp_mcp/tools/report_tools.py`
- DB (default): `C:/Users/ASUS/Invisible ERP/Inventory_Master_DB.sqlite` (overridable via `DB_PATH` env or `config.json` `db_filename`)