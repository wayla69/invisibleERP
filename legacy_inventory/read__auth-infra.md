I have everything needed. Here is the structured documentation.

---

# Operational Target Spec — Invisible ERP (V1 → V2 parity)

Scope: user store, RBAC, deployment topology, dependencies. Source files: `user_store.py`, `api_server.py`, `erp_mcp/db.py`, `ERPPOS_Invisible.py`, `config.json`, `start.sh`, `railway.json`, `nixpacks.toml`, `Procfile`, `requirements.txt`, `Init_Historical_DB.py`.

---

## 1. User Store (`user_store.py`)

**Purpose.** Single shared auth module imported by BOTH the Streamlit app (`ERPPOS_Invisible.py`) and the FastAPI server (`api_server.py`). Dual backend: PostgreSQL (production/Railway, cross-service-instant) or SQLite (local dev fallback). The choice is made ONCE at import time.

### 1.1 Backend selection (parity-critical, easy to silently break)
```python
USERS_DB_URL = os.environ.get("USERS_DB_URL") or os.environ.get("DATABASE_URL") or os.environ.get("DATABASE_PUBLIC_URL")
_USE_PG = bool(USERS_DB_URL and USERS_DB_URL.startswith("postgresql"))
```
- Three env var names are tried in order. If none set → SQLite mode.
- `_USE_PG` is computed at module import. A V2 rewrite that re-reads env per-call, or that only checks `DATABASE_URL`, would change behavior. The `startswith("postgresql")` guard means a `postgres://` (legacy scheme) URL would silently fall back to SQLite — **flag this**: Railway sometimes emits `postgres://`. V1 would NOT use Postgres for that scheme.
- Module-level side effect: prints `[user_store] Using PostgreSQL...` / `...SQLite (local mode)` at import.

### 1.2 Password hashing
```python
def make_hash(password): return hashlib.sha256(password.encode()).hexdigest()
```
- **Plain unsalted SHA-256 hex digest.** No salt, no bcrypt/argon, no work factor. Both backends use identical hashing, so SQLite↔Postgres migration of hashes works directly. **Parity-critical:** any V2 change to the hash algorithm invalidates ALL existing stored passwords (including default `admin`/`admin123`). If V2 upgrades hashing it MUST keep SHA-256 verification as a fallback + rehash-on-login.

### 1.3 Schema — `tbl_users`
Postgres DDL (`_pg_init`):
| Column | Type | Notes |
|---|---|---|
| `Username` | TEXT PRIMARY KEY | |
| `Password_Hash` | TEXT NOT NULL | SHA-256 hex |
| `Role` | TEXT NOT NULL DEFAULT 'Staff' | NB default is `'Staff'`, a role NOT in the Streamlit role list (see §2) |
| `Customer_Name` | TEXT | multi-tenant scoping key |
| `Permissions` | TEXT DEFAULT '' | CSV of permission keys, individual override |

SQLite version of this table is created in `ERPPOS_Invisible.py:init_db()` (lines 629–635) WITHOUT `Permissions`, then `ALTER TABLE ... ADD COLUMN Permissions TEXT DEFAULT ''` (idempotent try/except). **Schema drift to watch:** Postgres creates `Permissions` inline; SQLite adds it via migration. V2 must guarantee the column exists in both.

### 1.4 Postgres case-normalization (parity-critical bug-prone area)
Postgres folds unquoted identifiers to lowercase, so `SELECT Role ...` returns key `role`. The code defends against this:
- `_pg_check_login` / `_pg_get_all_users` query with **lowercase** column names (`role, customer_name, permissions`) and use `RealDictCursor`, then re-map to Title_Case dict keys (`Role`, `Customer_Name`, `Permissions`).
- `_pg_row_to_dict` (lines 73–82) does dual lookup (`row.get("username", row.get("Username"))`) — defensive but currently only `_pg_*` query results pass through.
- **The public contract is Title_Case keys** (`Role`, `Customer_Name`, `Permissions`). All callers depend on this. V2 must preserve Title_Case output keys regardless of backend. This was the subject of recent commit `6bd3a45 "normalize PostgreSQL lowercase column names"`.

### 1.5 Init / seed (`init_user_store()`)
Called once at startup (FastAPI `@app.on_event("startup")`; Streamlit calls `init_db()` separately). Only does work when `_USE_PG`:
1. `_pg_init()` — `CREATE TABLE IF NOT EXISTS`; seeds **default admin** if absent: `("admin", make_hash("admin123"), "Admin", "HQ")`. **Hardcoded default credential admin / admin123, Customer_Name="HQ".** Parity + security flag.
2. `_pg_migrate_from_sqlite()` — one-time SQLite→PG copy. Guard: only runs if Postgres `tbl_users` has `COUNT(*) <= 1` (i.e. only the default admin). Reads SQLite path from `DB_PATH` env or `config.json:db_filename`. Inserts each user `ON CONFLICT (Username) DO NOTHING`. Failures are swallowed with a printed message (`SQLite migration skipped`). In SQLite mode `init_user_store()` is a **no-op** — table creation relies on `init_db()` in the Streamlit app. **Flag:** if FastAPI runs in SQLite mode WITHOUT the Streamlit app having created the table, login queries will fail.

### 1.6 Public API (the surface V2 must reproduce)
| Function | Returns / effect | Backend dispatch |
|---|---|---|
| `make_hash(pw)` | SHA-256 hex | shared |
| `init_user_store()` | create table + migrate (PG only) | PG only |
| `check_login(user, pw)` | `{Role, Customer_Name, Permissions}` or `None` | PG: `_pg_check_login`; SQLite: `_sqlite_check_login` via `erp_mcp.db.fetchone` |
| `get_all_users()` | `list[{Username, Role, Customer_Name, Permissions}]` sorted by username | both |
| `create_user(user, pw, role, customer_name="", permissions="")` | INSERT; PG `ON CONFLICT DO NOTHING`, SQLite `INSERT OR IGNORE` | both |
| `update_user(user, role=None, customer_name=None, new_password=None, permissions=None)` | conditional UPDATE per non-None field; password only updated if truthy | both |
| `delete_user(user)` | DELETE — **`admin` is protected** (`AND Username != 'admin'`) in both backends | both |

- SQLite path imports `from erp_mcp.db import fetchone/fetchall/execute` lazily inside functions (avoids hard dep when PG mode). V2 must keep these importable.
- `update_user`: `new_password` is only applied `if new_password:` (empty string = no change); `role`/`customer_name`/`permissions` applied `if not None` (empty string DOES overwrite). Subtle, parity-critical.

---

## 2. RBAC Model

Two distinct, overlapping permission systems exist. **This is a major parity trap** — they are NOT the same key space.

### 2.1 System A — Streamlit nav-key RBAC (`ERPPOS_Invisible.py`, `tbl_role_permissions`)
- Keys are `nav_*` strings (`nav_pos`, `nav_dashboard`, `nav_users`, …) — see `ALL_NAV_KEYS` (13 keys).
- `tbl_role_permissions(Role, Permissions)` — `Permissions` is a CSV. Read by `_get_role_permissions(role)`; written by `_save_role_permissions`. `_can_access(role, nav_key)` and `_build_menu_for_role(role)` drive the sidebar.

### 2.2 System B — fine-grained permission keys (`ALL_PERMISSIONS`, used by `has_perm`/`require_perm`)
- ~45 permission keys (`pos, dashboard, exec, order_mgt, claim_mgt, crm, users, warehouse, procurement, creditors, ar, delivery, returns, pricelist, lots, locations, promos, mobile, images, masterdata, bom_master, planner, order_cust, cust_dash, cust_inventory, cust_pos, cust_bom, cust_variance, loyalty, survey, cust_my_crm, cust_my_suppliers, cust_my_pos, cust_my_users, marketing, track, ai_chat`, …). Full list with Thai/English labels in `ALL_PERMISSIONS` (lines 328–366).
- `PERM_TO_NAV` maps a subset of these to `nav_*` keys.
- These keys are ALSO stored in `tbl_role_permissions.Permissions` and in `tbl_users.Permissions` (per-user override) — the SAME columns System A uses, so the two key vocabularies are mixed in one column. **Flag:** the seed in `init_db()` (§2.4) writes System-B keys into `tbl_role_permissions`, while `_get_role_permissions` fallback defaults write System-A `nav_*` keys. V2 must preserve this dual encoding or unify carefully.

### 2.3 Permission resolution order (`get_user_perms`, lines 395–428) — parity-critical
1. If `role == "Admin"` → **all** `ALL_PERMISSIONS` keys (Admin bypasses everything).
2. Else read `tbl_users.Permissions` for the user; if non-empty → that CSV is the **individual override** (takes precedence over role).
3. Else read `tbl_role_permissions.Permissions` for the role.
4. Else hardcoded fallback dict (lines 421–428).
- `has_perm(key)` = `key in get_user_perms(...)`. `require_perm(key)` shows bilingual error `"⛔ คุณไม่มีสิทธิ์เข้าถึงส่วนนี้ | Access denied: {key}"` and `st.stop()`s.

### 2.4 Canonical role → permission seed (`init_db()` DEFAULT_PERMS, lines 637–646)
Seeded via `INSERT OR IGNORE` (won't overwrite existing rows — so editing in UI persists):

| Role | Default permission CSV |
|---|---|
| **Admin** | `pos,dashboard,exec,order_mgt,claim_mgt,crm,users,warehouse,lots,locations,mobile,images,procurement,creditors,ar,delivery,returns,pricelist,promos,marketing,loyalty,survey,planner,masterdata,bom_master` |
| **Sales** | `pos,dashboard,exec,order_mgt,claim_mgt,crm,ar,delivery,returns,pricelist,promos,marketing,planner` |
| **Customer** | `order_cust,cust_pos,cust_dash,cust_inventory,cust_bom,cust_variance,loyalty,survey,track,cust_my_crm,cust_my_suppliers,cust_my_pos,cust_my_users` |
| **Warehouse** | `warehouse,lots,locations,mobile,images,masterdata` |
| **Procurement** | `procurement,creditors,ar,delivery,masterdata` |
| **Planner** | `dashboard,exec,warehouse,procurement,planner,masterdata` |

**Recognized roles:** `Admin, Sales, Customer, Warehouse, Procurement, Planner` (the User Management `selectbox` lists exactly these six — lines 11463, 11494). NOTE the mismatch: `tbl_users.Role` Postgres DEFAULT is `'Staff'`, which is **not** a recognized role and would fall through `get_user_perms` to the `{'order_cust','cust_dash','track'}` default. **Flag for V2.**

### 2.5 Multi-tenant scoping (`Customer_Name`) — parity-critical
- `Customer_Name` on the user is the tenant key. Role `Customer` is scoped to its own data; `Customer_Name` is propagated into the API auth token (`_make_token`) and into `/api/login` response. Many Streamlit queries filter by `Customer_Name`. Dropping this column in V2 breaks tenant isolation silently (users would see all customers' data).

### 2.6 RBAC in the API layer (`api_server.py`)
**Flag — major gap:** the FastAPI endpoints do **NOT** enforce RBAC. `_verify_token` validates the HMAC token and returns `{username, role, customer_name}`, but no endpoint calls it as a dependency except `/api/auth/me`. All `/api/dashboard`, `/api/pos/*`, `/api/inventory/*`, `/api/finance/*`, `/api/chat`, `/api/analytics/*` are **unauthenticated and un-scoped** — any caller gets HQ-wide data. If V2 is meant to reach parity-or-better, this is the thing to fix, not replicate. Document it but treat as a defect, not a target.

---

## 3. Auth token scheme (`api_server.py`) — parity-critical
Custom HMAC token (NOT real JWT, despite the env var name):
```
payload = f"{username}|{role}|{customer_name}|{expiry}"      # expiry = now + 30 days
sig     = hmac_sha256(JWT_SECRET, payload).hexdigest()
token   = f"{payload}|{sig}"
```
- `_verify_token` splits on `|`, recomputes HMAC with `hmac.compare_digest`, checks `expiry > now`. Returns `{username, role, customer_name}`.
- **Pipe-delimited, no escaping** — a `Username`/`Customer_Name` containing `|` corrupts the token (`payload = "|".join(parts)` reassembly is forgiving on extra pipes in middle fields only because of the `*parts, sig` unpack, but the 4-field `username, role, customer_name, expiry = parts` unpack will raise if any field contains `|`). **Flag:** parity risk if customer names contain pipes.
- Secret: `JWT_SECRET` env, default `"invisible-erp-secret-change-me"`. **Insecure default** — must be set in prod.

---

## 4. Deployment Topology

### 4.1 Dual-service Railway, one repo, routed by `SERVICE_TYPE` (`start.sh`)
- `nixpacks.toml` → `[start] cmd = "bash start.sh"`. `railway.json` → builder `NIXPACKS`, healthcheck `GET /` (timeout 60s), restart `ON_FAILURE` max 3.
- `start.sh` logic:
  1. **Shared Volume DB seed:** if `$DB_PATH` set → `mkdir -p $(dirname DB_PATH)`; if file absent → `cp` repo's `Inventory_Master_DB.sqlite` → `$DB_PATH` (else "fresh DB will be created"). Both services share a Railway Volume mounted at `/data`, both set `DB_PATH=/data/Inventory_Master_DB.sqlite`.
  2. **Routing:**
     - `SERVICE_TYPE == "streamlit"` → `streamlit run ERPPOS_Invisible.py --server.port $PORT --server.address 0.0.0.0 --server.headless true --server.enableCORS false --server.enableXsrfProtection false`
     - else (default / API) → `python api_server.py`
- **`Procfile` says `web: python3 api_server.py`** — this is the legacy/alternate single-service path and is INCONSISTENT with `nixpacks.toml`'s `bash start.sh`. On Railway/Nixpacks, `nixpacks.toml` wins. **Flag:** the `Procfile` only ever starts the API, never Streamlit, never seeds the volume. V2 should consolidate.

### 4.2 DB path resolution (`erp_mcp/db.py`) — parity-critical precedence
```
DB_PATH env  >  config.json:db_filename (relative to project root)  >  "Inventory_Master_DB.sqlite"
```
- `DB_PATH` env overrides everything (Railway volume). `WAL` journal mode enabled for safe concurrent reads across the two services sharing one SQLite file on the volume. `row_factory=sqlite3.Row` → dict-like rows. `fetchall/fetchone/execute` are the only DB primitives for the API + SQLite user path.
- **Flag:** two processes writing one SQLite file over a network volume is fragile; WAL helps reads but write contention across services is a real risk. This is the operational reality V2 inherits — Postgres for users (`user_store`) was the migration step away from this; business data is still SQLite-on-volume.

### 4.3 Environment variables (operational target)
| Var | Used by | Purpose / default |
|---|---|---|
| `SERVICE_TYPE` | `start.sh` | `"streamlit"` → UI service; anything else/unset → API service |
| `DB_PATH` | `start.sh`, `erp_mcp/db.py`, `user_store` migration | shared SQLite path, e.g. `/data/Inventory_Master_DB.sqlite` |
| `USERS_DB_URL` / `DATABASE_URL` / `DATABASE_PUBLIC_URL` | `user_store.py` | Postgres URL (must start `postgresql`) → enables PG user store |
| `JWT_SECRET` | `api_server.py` | HMAC token secret; default `invisible-erp-secret-change-me` (insecure) |
| `ANTHROPIC_API_KEY` | `api_server.py` (`/api/chat`), `analytics/llm_insights.py` | Claude API; `/api/chat` 500s if unset. Chat model hardcoded `claude-opus-4-5`, `max_tokens=1024`, history truncated to last 10 in / last 20 out |
| `PORT` | both | injected by Railway/Render |
| `RAILWAY_ENVIRONMENT` / `RENDER` | `api_server.py` | cloud-mode detection → disables uvicorn `reload` |
- `api_server.py` also `load_dotenv(secret.env)` then `load_dotenv(.env)` from project root for local secrets.

---

## 5. Dependencies (`requirements.txt`)
Single file for BOTH services (Nixpacks auto-detects):
- **Web/API:** `fastapi>=0.111`, `uvicorn[standard]>=0.29`, `pydantic>=2.0`, `psycopg2-binary>=2.9.9` (Postgres user store)
- **UI:** `streamlit>=1.32`
- **AI:** `anthropic>=0.40`
- **Data/charts:** `pandas>=2.0`, `numpy>=1.26`, `plotly>=5.18`, `openpyxl>=3.1`
- **PDF/reports:** `fpdf2>=2.7`, `reportlab>=4.0`
- **Thai:** `bahttext>=1.0` (Thai baht amount-in-words — invoice/receipt parity)
- **Image:** `Pillow>=10.0`
- **Misc:** `python-dotenv>=1.0`
- **Flag:** `win32com` (used by `Init_Historical_DB.py`) and `python-pptx` (mentioned in CLAUDE.md) are NOT in requirements — Windows-only / dev-only deps not deployable.

---

## 6. `Init_Historical_DB.py` (Windows-only ETL, NOT part of deploy)
- **Purpose:** one-off historical backfill — scrapes Outlook inbox (`win32com`) for emails whose subject contains `"Stock_Inventory_HAVI_DAI"`, received on/after **2025-09-01**, downloads `.csv`/`.xlsx` attachments to `Raw_Data/Hist_{YYYYMMDD_HHMM}_{filename}`, and `append`s into SQLite table **`tbl_raw_inventory`** (the inventory-snapshot source table queried by the dashboard/inventory endpoints via `Generate_Date`).
- **Logic details:** sorts inbox newest-first, `break`s when an email older than the start date is reached; skips non-mail items (`message.Class != 43`); parses `Generate_Date` with `dayfirst=True`, drops `Days_to_Expire` column before insert; per-message errors are swallowed (`continue`).
- **Parity note:** all console output is **Thai** (emoji + Thai strings). This is a manual operator tool, Windows + Outlook-bound; **not** runnable on Railway/Linux. V2 needs a portable replacement (IMAP/upload) if historical ingest must continue. The schema it writes (`tbl_raw_inventory`, columns incl. `Generate_Date`, `AV_QTY`, `Total_Stock`, `Item_ID`, `Item_Description`, `UOM`, `Temperature_Type`, `BU_ID`, `"Expired Date"`) is consumed by `api_server.py` inventory endpoints — keep these column names/spelling (note the **space** in `"Expired Date"`).

---

## 7. Top parity risks to NOT silently drop in V2
1. **SHA-256 unsalted hashing** — changing it invalidates all existing passwords incl. `admin/admin123`.
2. **Title_Case dict-key contract** from `user_store` despite Postgres lowercasing.
3. **`postgres://` vs `postgresql://`** scheme guard — `_USE_PG` silently false for legacy scheme.
4. **Dual permission key vocabularies** (`nav_*` System A vs fine-grained System B) co-stored in the same `Permissions` columns.
5. **Permission precedence:** Admin-all → per-user override → role default → hardcoded fallback.
6. **`Customer_Name` multi-tenant scoping** — dropping it leaks cross-tenant data.
7. **`admin` user is delete-protected** in both backends.
8. **API layer has NO RBAC/auth enforcement** on data endpoints (defect — fix, don't replicate).
9. **`SERVICE_TYPE` routing + `/data` shared-volume SQLite seed** is the entire deploy contract; `Procfile` contradicts it (API-only, no seed).
10. **Insecure defaults:** `JWT_SECRET=invisible-erp-secret-change-me`, `admin/admin123`, `Role DEFAULT 'Staff'` (unrecognized role → minimal perms).
11. **`"Expired Date"` column name has a literal space**; `tbl_raw_inventory.Generate_Date` is the snapshot key (`MAX(Generate_Date)` = "latest stock").
12. **Bilingual (Thai/English) strings** throughout RBAC errors, permission labels, and notification titles (`AP เกินกำหนด`, etc.) — i18n must be preserved.