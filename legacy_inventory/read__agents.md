I have read all six agent files plus `__init__.py` (which is empty/1 line). Here is the exhaustive structured documentation.

---

# Agent Architecture — `Invisible ERP/agents/*.py`

This is the **AI brain** of the ERP system. It is a self-contained, MCP-server-free agentic layer: the same business logic that the MCP tools expose is duplicated as plain Python functions in `erp_agent.py`, and all agents call those directly. V2 must preserve this so the Streamlit AI Assistant works without a running MCP server.

> **PARITY-CRITICAL TOP-LEVEL FACTS**
> - **Model:** `claude-opus-4-5` (hardcoded as `BaseAgent.DEFAULT_MODEL`). This is the only model string in the layer. Easy to silently downgrade in a rewrite — preserve exactly.
> - **Bilingual (Thai/English):** The orchestrator `ERPAgent.SYSTEM` is written **entirely in Thai**; the 5 sub-agents' system prompts are in **English** but all instruct "Respond in the same language as the user (Thai or English)". The loop's fallback error string is **Thai**.
> - **Currency:** Every monetary value is **THB**, formatted with thousands commas. Enforced by system prompts, not code (code returns raw rounded floats).
> - **No streaming, no tool-call cost guard beyond a 15-turn cap.**
> - `__init__.py` is **empty** (1 line) — agents are imported via their module paths (`from agents.base_agent import BaseAgent`), not re-exported.

---

## 1. `base_agent.py` — `BaseAgent` (shared infrastructure)

**Purpose:** Common Anthropic client + agentic ReAct loop for all 6 agents. Subclasses supply `TOOLS`, `SYSTEM`, and `execute_tool()`.

**Class constants (parity-critical):**
| Constant | Value | Meaning |
|---|---|---|
| `DEFAULT_MODEL` | `"claude-opus-4-5"` | Model used by every agent unless overridden in ctor |
| `MAX_LOOP_TURNS` | `15` | Hard cap on tool-call iterations per user turn (prevents infinite loops) |
| `MAX_HISTORY` | `40` | Rolling window — `messages` truncated to last 40 after each turn |
| `TOOLS` | `[]` | Overridden per subclass |
| `SYSTEM` | `"You are an ERP AI assistant."` | Overridden per subclass |

**Constructor `__init__(model=None, api_key=None)`:**
- `self.model = model or self.DEFAULT_MODEL`
- `self.client = anthropic.Anthropic(api_key=api_key)` — when `api_key` is `None`, the SDK reads `ANTHROPIC_API_KEY` from env.
- Also inserts project root onto `sys.path` at import time (lines 19–21) so `agents.*` / `erp_mcp.*` resolve.

**Public method `chat(user_message, history=None) -> (reply_text, updated_history):`**
- Builds `messages = history + [{"role":"user","content": user_message}]`.
- Calls `_agentic_loop`. **Exception handling is the contract V2 must keep:**
  - `anthropic.AuthenticationError` → **re-raised** (UI catches it to show a re-key/API-key prompt).
  - `anthropic.RateLimitError` → reply = `"⚠️ Rate limit reached. Please wait a moment and try again."`
  - `anthropic.APIStatusError` → `"⚠️ API error ({status_code}): {message}"`
  - Any other `Exception` → `"⚠️ Unexpected error: {e}"`
- Appends `{"role":"assistant","content": reply}` then truncates `messages` to last `MAX_HISTORY` (40).
- **Returns the truncated history** — caller persists this for the next turn.

**Core `_agentic_loop(messages) -> str` (the tool-loop — most parity-sensitive code):**
- Loops up to `MAX_LOOP_TURNS` (15). Each iteration:
  1. `client.messages.create(model, max_tokens=4096, system=SELF.SYSTEM, tools=SELF.TOOLS, messages=messages)`.
  2. Appends the assistant response's raw `content` blocks to `messages`.
  3. If `stop_reason == "end_turn"` → returns `"\n".join(b.text for b in response.content if hasattr(b,"text"))` (concatenates all text blocks with newlines).
  4. Otherwise iterates `response.content`; for each `block.type == "tool_use"`:
     - **Side-effect logging:** `print(f"[{ClassName}] tool: {block.name}({block.input})")` to stdout (visible in Streamlit/Railway logs).
     - Calls `self.execute_tool(block.name, block.input)` → JSON string.
     - Appends `{"type":"tool_result","tool_use_id": block.id, "content": result}`.
  5. If any tool results, appends them as a single `{"role":"user","content": tool_results}` message and loops. If no tool calls and not end_turn → `break`.
- **Fallback if loop exhausts (15 turns) or breaks:** returns the **Thai** string `"ขออภัย ไม่สามารถประมวลผลได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง"` ("Sorry, cannot process right now, please try again"). **Easy to drop — a rewrite that returns an English fallback breaks Thai parity.**
- `max_tokens=4096` is fixed per call.

**`execute_tool` base stub:** returns `{"error":"Tool '<name>' not implemented in <Class>."}` — overridden by every subclass.

**Flag for rewrite:** Tool results are passed as raw strings (not wrapped objects). The loop does **not** set `is_error` on tool_result blocks even when the tool returns `{"error": ...}` — errors are surfaced to the model as ordinary content. Preserve this; do not "improve" it to `is_error=True` without checking prompt expectations.

---

## 2. `erp_agent.py` — `ERPAgent` (737 lines, the orchestrator) + all tool implementations

This file is the heart. It is **not** a router that delegates to the sub-agent classes at runtime — instead it (a) defines the full-access `ERPAgent` with **all 19 tool schemas**, and (b) holds the **module-level implementation functions** (`_m_*`) that *every* agent (including the specialists) imports and calls. The specialists are thin re-exports of subsets of these functions.

### 2a. `ERPAgent` class

- **`SYSTEM` (Thai, lines 18–27):** Identity = "AI Assistant ของ Invisible ERP … สำหรับ Invisible Enterprise". Rules (translated):
  - Use the same language as the user (Thai or English).
  - Show numbers with thousands commas + unit **THB**.
  - **Always use tools to fetch real data before answering.**
  - Be concise, focus on useful insight.
  - **For creating a PO, confirm details before proceeding.**
  - **Immediately alert on low stock or overdue invoices when found.**
- **`TOOLS` (lines 29–218):** 19 tool schemas. Note the descriptions here are **in Thai** (the specialist agents re-declare the same tools with **English** descriptions). Schemas:
  - POS: `get_sales_summary`(start_date,end_date,branch?), `get_recent_orders`(limit?), `get_order_detail`(order_id), `get_open_sessions`().
  - Inventory: `get_stock_levels`(search?,below_reorder_only?,limit?), `get_stock_item`(item_id), `get_supplier_list`(), `create_purchase_order`(supplier,items,expected_delivery_date,notes?,created_by?), `get_purchase_orders`(status?,limit?).
  - Finance: `get_pl_summary`(month,year,branch?), `get_kpi_dashboard`(year,quarter?), `get_cash_position`(), `get_accounts_payable`(overdue_only?), `get_accounts_receivable`(overdue_only?).
  - Reports: `get_available_reports`(), `generate_daily_report`(report_date,branch?,format=excel), `generate_monthly_pl`(month,year,format=excel), `generate_stock_report`(below_reorder_only?).

- **`execute_tool(name, tool_input)` (lines 220–255) — dispatch:**
  - Builds a `_DISPATCH` dict mapping each tool name → one of four **domain routers** (`_call_pos`, `_call_inv`, `_call_fin`, `_call_rpt`).
  - **Important discrepancy to flag:** `_DISPATCH` includes `void_order` (→`_call_pos`) and `adjust_stock` (→`_call_inv`), **but neither tool is in `ERPAgent.TOOLS`**. So the orchestrator can *route* a void/adjust if Claude somehow emits it, but Claude is never *offered* those two write tools via the orchestrator — only the POSAgent/InventoryAgent specialists expose them. This is a deliberate RBAC-ish gate: destructive ops (void, stock adjust) are not in the general assistant's toolset. **Preserve this asymmetry** — exposing `void_order`/`adjust_stock` to the general agent would be a silent privilege escalation.
  - The top-of-function imports of `register_*_tools` (lines 221–224) are **dead/unused** — the dispatch never uses them. Safe to drop in V2 but note it.

- **Domain routers `_call_pos/_call_inv/_call_fin/_call_rpt` (lines 260–302):** each maps tool name → the concrete `_m_*` function, then calls `_dispatch`.
- **`_dispatch(fn_map, name, kw)` (305–313):** looks up fn, calls `fn(**kw)`, returns `json.dumps(result, ensure_ascii=False, default=str)`. `ensure_ascii=False` is **parity-critical** — it preserves Thai characters in tool output. `default=str` lets dates/Decimals serialize. Catches all exceptions → `{"error": str(e)}`.

### 2b. Tool implementations (`_m_*`) — business logic, SQL, and DB tables

All use `erp_mcp.db.fetchall / fetchone / execute` (imported lazily inside each fn). DB is SQLite (`Inventory_Master_DB.sqlite`) but the codebase also has a PostgreSQL path per recent commits — SQL uses `?` placeholders (SQLite style).

**POS:**
- **`_m_pos_sales_summary`** — Reads `tbl_cust_pos_sales` (header) + `tbl_cust_pos_items` (lines). Excludes `Status='Voided'`. Returns: total_orders, total_sales_thb (SUM Total), avg_order_value (total/orders, guarded ÷0), top 5 items by revenue (`GROUP BY Item_Description ORDER BY total_revenue DESC LIMIT 5`), and breakdown by `Payment_Method`. Also computes (but does not return) subtotal/discount/tax aggregates. **`branch` param accepted but NOT used in SQL** — branch filtering is a no-op (returns `branch or "ALL"` label only). Flag: branch scoping is cosmetic, not enforced.
- **`_m_pos_recent_orders`** — `tbl_cust_pos_sales ORDER BY id DESC LIMIT ?` (default 10). Returns selected columns + count.
- **`_m_pos_order_detail`** — header `SELECT *` by `Sale_No` + all lines from `tbl_cust_pos_items`. Returns `{**header, "lines": [...]}`; `{"error":...}` if not found.
- **`_m_pos_open_sessions`** — `tbl_scan_sessions WHERE Status='Open'` + today's (`datetime.now()` local date) sales total/count from `tbl_cust_pos_sales` excluding Voided.
- **`_m_pos_void_order`** (write; **only reachable via POSAgent**) — Guards: not-found and already-Voided. Then `UPDATE tbl_cust_pos_sales SET Status='Voided', Notes=?`. **Notes overwrite pattern:** `f"Voided by {authorized_by or '?'}: {reason}"`. Returns success + ISO timestamp. Flag: this **overwrites** any existing `Notes`; and there is no separate audit table — the only void record is the rewritten Notes field + Status. **Document numbering:** none for voids.

**Inventory** (note the **snapshot model** — `tbl_raw_inventory` is dated snapshots; always uses `MAX(Generate_Date)`):
- **`_m_inv_stock_levels`** — Latest snapshot via `MAX(Generate_Date)`. Filters: `search` → `Item_ID LIKE ? OR Item_Description LIKE ?`; `below_reorder_only` → `AV_QTY <= 0` (**"reorder" is defined as available qty ≤ 0**, there is no per-item reorder point). Selects `"Expired Date"` aliased to `Expiry_Date` (column name has a space — quoted). `ORDER BY AV_QTY ASC LIMIT ?` (default 50). Returns snapshot_date, totals, low_stock_count.
- **`_m_inv_stock_item`** — One item from latest snapshot + last 10 rows of `tbl_stock_movements` (`Move_Date DESC`). `{"error"}` if absent.
- **`_m_inv_suppliers`** — Primary: `tbl_suppliers WHERE Active=1 ORDER BY Supplier_Name`. **Fallback** if empty: `tbl_cust_my_suppliers ORDER BY rowid DESC LIMIT 100`. Two supplier sources — preserve the fallback.
- **`_m_inv_create_po`** (write) — **Document numbering scheme (parity-critical):** `PO_No = f"PO-{YYYYMMDD}-{random 1000–9999}"` (random, not sequential — collision-prone but must match). Computes `total = Σ qty×unit_price`. Inserts `tbl_purchase_orders` (Status fixed `'Draft'`, Created_By default `"AI Agent"`) and one `tbl_po_items` row per line (Received_Qty=0, Status `'Pending'`, default uom `"Unit"`). Returns po_number, total_amount_thb, status, human message.
- **`_m_inv_adjust`** (write; **only via InventoryAgent**) — Looks up item in `tbl_raw_inventory` (latest by Generate_Date). **Doc numbering:** `ADJ-{YYYYMMDDHHMMSS}`. Inserts `tbl_stock_movements`: `Move_Type` = `"Stock In"` if qty≥0 else `"Stock Out"`; From/To locations flip on sign (`Warehouse→Stock` for in, `Stock→Adjustment` for out); Qty stored as `abs(qty)`. Returns signed adjustment.
- **`_m_inv_get_pos`** — `tbl_purchase_orders` (optional `Status=?` filter) `ORDER BY PO_Date DESC LIMIT ?` (default 20), each enriched with its `tbl_po_items`. **PO status workflow values:** Draft / Confirmed / Received / Cancelled (per schema description).

**Finance** (revenue-only — **no COGS/expense data**, stated in FinanceAgent prompt):
- **`_m_fin_pl`** — Month boundaries computed manually (handles Dec→next-year rollover). POS revenue = `SUM(Total)` from `tbl_cust_pos_sales` excluding Voided; SO revenue = `SUM(Total_Price)` from `tbl_sales_orders` where `Status NOT IN ('Cancelled','Rejected')`. Returns pos/so/total revenue + pos_orders. `branch` accepted, unused.
- **`_m_fin_ap`** — `tbl_ap_transactions WHERE Status NOT IN ('Paid','Cancelled')`. `overdue_only` adds `Due_Date < today`. Adds computed `is_overdue` flag per row. Returns total_payable, outstanding (total − Σ Paid_Amount), count, invoices. Non-overdue query capped `LIMIT 100`.
- **`_m_fin_ar`** — identical logic on `tbl_ar_invoices`.
- **`_m_fin_kpi`** — Year or quarter. **Quarter date ranges hardcoded:** Q1 01-01→03-31, Q2 04-01→06-30, Q3 07-01→09-30, Q4 10-01→12-31. POS rev/count/avg + SO rev (same status filters as PL). Returns total_revenue, pos_orders, avg_pos_order.
- **`_m_fin_cash`** — Outstanding AP and AR (Σ Amount − Σ Paid_Amount, excluding Paid/Cancelled). `net_working_capital = AR_outstanding − AP_outstanding`. As-of = today.

**Reports** (Excel via `openpyxl`; all share `_REPORTS_DIR`/`_ensure_reports_dir` from `erp_mcp.tools.report_tools`):
- **`_m_rpt_available`** — Static list of 3 templates (daily_sales, monthly_pl, stock_snapshot).
- **`_m_rpt_daily`** — Orders for date (exclude Voided) → `daily_report_{date}.xlsx`. Header row styled white-on-`#1E3C72` (brand navy). Columns: Sale No, Date, Customer, Subtotal, Discount, Tax, Total, Payment, Status, By. Returns path + total_revenue. `{"success":False}` if openpyxl missing.
- **`_m_rpt_monthly`** — Per-day revenue aggregation for the month → `monthly_{year}_{MM}.xlsx`.
- **`_m_rpt_stock`** — Latest snapshot, optional `AV_QTY<=0` filter, `LIMIT 5000` → `stock_{YYYYMMDD}[_low].xlsx`. Same `#1E3C72` header style. **Brand color `1E3C72` is repeated across reports — a parity token.**

---

## 3. Specialist agents — `pos_agent.py`, `inventory_agent.py`, `finance_agent.py`, `report_agent.py`

All four share an identical pattern: subclass `BaseAgent`, define an **English** `SYSTEM`, a subset of `TOOLS`, a `_DISPATCH` dict mapping tool name → the **imported `_m_*` function from `erp_agent`**, and a 6-line `execute_tool` that calls `fn(**tool_input)` and JSON-dumps (`ensure_ascii=False, default=str`). **They do not run a nested agent loop or call the orchestrator** — they reuse `BaseAgent._agentic_loop` with their own narrower toolset.

| Agent | Class | Tools exposed | Unique system-prompt directives (parity) |
|---|---|---|---|
| `pos_agent.py` | `POSAgent` | get_sales_summary, get_recent_orders, get_order_detail, get_open_sessions, **void_order** | "Flag unusual voids or large discounts"; key numbers up front. **Only place `void_order` (write/destructive, requires `authorized_by`) is offered to the model.** |
| `inventory_agent.py` | `InventoryAgent` | get_stock_levels, get_stock_item, get_supplier_list, create_purchase_order, **adjust_stock**, get_purchase_orders | "Confirm PO details before create_purchase_order"; "Flag AV_QTY ≤ 0 as critical"; present qty with UOM. **Only place `adjust_stock` (write) is offered.** |
| `finance_agent.py` | `FinanceAgent` | get_pl_summary, get_kpi_dashboard, get_cash_position, get_accounts_payable, get_accounts_receivable | "Proactively flag overdue invoices"; **"COGS/expense data is not in the current DB — only revenue figures."** |
| `report_agent.py` | `ReportAgent` | get_available_reports, generate_daily_report, generate_monthly_pl, generate_stock_report | "List available reports first if unsure"; "Confirm date range before generating"; "Tell the user the output file path"; files saved to `reports/`. |

**Tool-schema drift to flag:** specialist tool schemas omit the `branch`/`format` cosmetic params present in `ERPAgent`'s schemas (e.g. ReportAgent's `generate_daily_report` has no `branch`/`format`; ERPAgent's does). Functionally equivalent (those params are unused), but the schemas are not in sync.

---

## Architecture summary & rewrite risks

**Dispatch model (3 layers):** Anthropic tool-loop (`BaseAgent`) → per-agent `execute_tool` name lookup → concrete `_m_*` DB function. `ERPAgent` adds an extra hop (domain router `_call_*`) because it spans all domains; specialists map name→function directly. **All real logic lives once in `erp_agent.py`'s `_m_*` functions** — the specialists and the MCP `tools/*.py` are alternate front-ends to the same logic. V2 should keep a single source of truth here.

**"Orchestration" clarification:** Despite the prompt framing, `erp_agent.py` does **not** spawn/route to the sub-agent *classes* at runtime. It is a flat single-agent-with-all-tools. The "sub-agents" are independent specialist entry points (presumably wired to different Streamlit pages/roles) that import shared `_m_*` logic. There is no agent-to-agent handoff, no router LLM, no nesting.

**Things easy to silently drop in a rewrite (high risk):**
1. **Model `claude-opus-4-5`** and `max_tokens=4096`.
2. **Thai system prompt for `ERPAgent`** + **Thai loop-exhaustion fallback string** + `ensure_ascii=False` (Thai integrity).
3. **`AuthenticationError` re-raise** (UI depends on it for re-keying) vs. swallowing other errors as `⚠️ …` strings.
4. **RBAC-style tool gating:** `void_order` and `adjust_stock` deliberately excluded from `ERPAgent.TOOLS` — only specialists expose writes.
5. **PO numbering `PO-YYYYMMDD-<rand4>`**, ADJ `ADJ-YYYYMMDDHHMMSS`; PO defaults Status=`Draft`, Created_By=`AI Agent`.
6. **Voided exclusion** in every revenue/sales aggregate (`Status != 'Voided'`); SO exclusion (`NOT IN ('Cancelled','Rejected')`); AP/AR exclusion (`NOT IN ('Paid','Cancelled')`).
7. **Inventory snapshot model** (`MAX(Generate_Date)`), `"Expired Date"` quoted column, supplier table **fallback** (`tbl_suppliers`→`tbl_cust_my_suppliers`).
8. **Brand color `#1E3C72`** in all Excel report headers.
9. `MAX_HISTORY=40` rolling window and `MAX_LOOP_TURNS=15` cap.

**DB tables touched (read R / write W):** `tbl_cust_pos_sales` (R/W-void), `tbl_cust_pos_items` (R), `tbl_scan_sessions` (R), `tbl_raw_inventory` (R, snapshot), `tbl_stock_movements` (R/W-adjust), `tbl_suppliers` (R), `tbl_cust_my_suppliers` (R fallback), `tbl_purchase_orders` (R/W), `tbl_po_items` (R/W), `tbl_sales_orders` (R), `tbl_ap_transactions` (R), `tbl_ar_invoices` (R).

**Relevant absolute paths:**
- `C:/Users/ASUS/Invisible ERP/agents/base_agent.py`
- `C:/Users/ASUS/Invisible ERP/agents/erp_agent.py`
- `C:/Users/ASUS/Invisible ERP/agents/pos_agent.py`
- `C:/Users/ASUS/Invisible ERP/agents/inventory_agent.py`
- `C:/Users/ASUS/Invisible ERP/agents/finance_agent.py`
- `C:/Users/ASUS/Invisible ERP/agents/report_agent.py`
- `C:/Users/ASUS/Invisible ERP/agents/__init__.py` (empty)
- Dependencies referenced: `erp_mcp/db.py` (`fetchall`/`fetchone`/`execute`), `erp_mcp/tools/report_tools.py` (`_REPORTS_DIR`, `_ensure_reports_dir`), `erp_mcp/tools/{pos,inventory,finance,report}_tools.py` (register fns imported but unused in `ERPAgent.execute_tool`).