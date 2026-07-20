## Invisible / Invisible ERP — V2 Definitive Architecture

**Decision:** TypeScript end-to-end on **NestJS + Drizzle + PostgreSQL + Next.js**, deployed on Railway, integrating the Anthropic SDK natively. This is Proposal A as the backbone, grafted with Proposal C's operational pragmatism (defer Redis, introspect-first, keep plain REST as the contract) and Proposal B's type-safety discipline (tenant scoping enforced structurally, not by convention). Source-verified against the legacy: 65 tables (15 `tbl_cust_*`), 30 REST endpoints, an HMAC `username|role|customer_name|expiry|sig` token, a 15-turn ReAct loop, openpyxl Excel + **fpdf** Thai PDF, a React Native `mobile/` client, and Postgres already half-adopted in `user_store.py`.

### 1. Stack

| Layer | Choice | Why for this system |
|---|---|---|
| Language | **TypeScript (Node 22 LTS)** | Collapses the verified Python(Streamlit)+JS(React Native) split into one language for a solo/small team. |
| Backend | **NestJS** on the **Fastify** adapter | Legacy's clean POS/Inventory/Finance/Reports split → Nest modules 1:1. Guards = RBAC; a TenantInterceptor = `customer_name` scoping; DI/`@nestjs/schedule` replace hand-rolled auth + cron. |
| API contract | **REST on the existing `/api/*` paths**, Zod-validated | The verified `mobile/` app depends on these paths — preserve them through cutover. tRPC is an *optional later* add for internal pages, not the backbone (avoids C's dual-surface maintenance on day one). |
| ORM | **Drizzle** (`drizzle-kit` introspection) | Top migration accelerator: introspects the 65 ugly-named tables (`\"Expired Date\"`, `AV_QTY`, mixed case) into typed schema; emits SQL close to the legacy's hand-written queries for verifiable line-by-line porting. |
| Database | **PostgreSQL 16** (Railway managed) | Kills the single-writer SQLite WAL ceiling. `jsonb` for marketing/AB/survey blobs, partial indexes for the pervasive `Status NOT IN ('Voided','Cancelled')` filters, and **Row-Level Security** as a tenant backstop the current code has no equivalent of. Already half-adopted via `DATABASE_URL`. |
| Frontend | **Next.js 15 (App Router)** | Replaces the 12,878-line Streamlit monolith. Server Components for read-heavy pages (dashboards, AR/AP aging, stock snapshots) with Thai SSR; Client Components for POS entry, planner, AI chat. |
| AI | **`@anthropic-ai/sdk`** | Direct port of `base_agent.py`'s `messages.create` + `tool_use`/`tool_result` loop. |
| Reports | **ExcelJS** + **Playwright (Chromium) HTML→PDF** with **Sarabun/Noto Sans Thai** | ExcelJS is a near-mechanical port of the verified openpyxl reports. Chromium does Thai line-breaking/diacritics correctly — an *upgrade* over the legacy fpdf path, which embeds the TTF but does no complex-text shaping. |
| Auth | **`@nestjs/jwt`** + **argon2** | Real signed JWT replaces the HMAC token; re-hash the verified bare-`sha256` passwords on next login (verify-sha256-then-upgrade). |
| Jobs | **pg-boss** (Postgres-backed) | Report/PDF generation and analytics scans off the request thread without standing up Redis. Promote to BullMQ+Redis only if throughput demands it. |
| Validation | **Zod** | One schema source for REST DTOs and Anthropic tool input schemas. |

### 2. Backend layering (NestJS, 3-layer per module)

```
apps/api/src/
  common/  guards/(jwt,roles,permissions)  interceptors/tenant  pipes/zod  decorators/(@Roles,@Permissions,@Tenant)
  database/ schema/*.ts (Drizzle, 65 tables by domain)  drizzle.module.ts
  modules/  auth  pos  inventory  finance  customers(portal)  reports  ai  marketing  admin(users/RBAC)
```
- **Controller** = thin HTTP on the exact legacy paths (`GET /api/inventory/stock` → `InventoryController.getStock`).
- **Service** = business logic; the repeated `SELECT MAX(Generate_Date)` latest-snapshot pattern becomes one `InventoryService.latestSnapshotDate()`.
- **Repository** = the only place touching Drizzle; centralizes legacy quirks (`\"Expired Date\"` quoting, voided-status predicates, `Sale_No`→`saleNo` camelCase mapping) and **requires `customerId` as a parameter** on every `tbl_cust_*` query so a missing tenant filter is caught in code review, backed by Postgres RLS.

### 3. Multi-tenant RBAC
- JWT claims `{ sub, role, customerName, permissions[] }` replace the HMAC string.
- `RolesGuard`/`PermissionsGuard` read `@Roles`/`@Permissions` metadata seeded from `tbl_role_permissions`.
- `TenantInterceptor` injects `customerName` request-scope; Postgres RLS (`SET app.current_tenant`) is defense-in-depth so a forgotten `WHERE` cannot leak across the 15 `tbl_cust_*` tables. HQ/Admin bypasses.
- Fix the verified security debt during the port, not after: `allow_origins=[\"*\"]` → explicit origins; `JWT_SECRET` default `\"invisible-erp-secret-change-me\"` → required secret; sha256 → argon2.

### 4. AI agents & analytics
- Port `_agentic_loop` → `AgentService.run()`: same loop, cap at 15 turns; each tool is a Nest provider calling the **same Service layer** the REST endpoints use (agents and humans share one code path) and therefore inherits RBAC + tenant scope automatically.
- Backs `POST /api/chat` and `/api/analytics/{replenishment,anomalies,insight,dashboard-summary}`.
- Port `analytics/` (forecasting, anomalies, `llm_insights`) — keep the **LLM-with-rule-based-fallback** pattern (`_rule_based_*`) so a solo operator can run without an API key; keep Thai-output prompts; keep deterministic math in TS and use Claude only for the narrative layer over computed numbers.
- **Model config:** centralize the id (legacy mixes `claude-opus-4-5` and `claude-sonnet-4-6`) into one env var; default to a **current** model and confirm against the live model catalog rather than copying the legacy ids. Add **prompt caching** on the large system prompt + tool schemas, and **SSE streaming** to the Next chat panel.

### 5. Frontend
- Routes mirror the legacy `nav_*`: `(internal)` for staff (~28 pages), `(portal)` for `nav_cust_*` (~8 tenant pages), `(auth)` login. Menu from `_build_menu_for_role` → typed config filtered by permissions.
- Streamlit `st.tabs` → shadcn/ui Tabs with lazy child routes; data grids → TanStack Table; mutations → TanStack Query (no `st.rerun`). i18n via **next-intl**, TH default, Sarabun bundled.
- Highest-effort rebuilds (flag explicitly): Master Data / BOM upload-and-edit, the warehouse stocktake QR scanner, `st.data_editor` flows.

### 6. Hosting (Railway)
- Services: **`api`** (NestJS), **`web`** (Next.js). **Railway Postgres** plugin. **Object storage (R2/S3)** for generated reports + the Images page (legacy `reports/` doesn't survive container restarts). **Drop the shared SQLite volume.** Jobs run in-process via pg-boss; split to a `worker` service only when report timeouts hurt.
- CI/CD: GitHub → Railway auto-deploy per service; `drizzle-kit migrate` as a predeploy step.

### 7. Migration plan (strangler-fig — mandatory, not big-bang)
1. **ETL**: idempotent, re-runnable SQLite→Postgres script handling SQLite's dynamic typing (text dates, stringly-typed `Total`/`Amount`), the `Generate_Date`-keyed snapshot tables, and the `user_store` lowercase-column collision. Reconcile by row counts + financial totals (sales/AP/AR) old vs new.
2. **Read-only first**: stand up dashboard, `pos/summary`, `inventory/stock`, `finance/*` behind the *existing* `/api/*` paths; diff JSON byte-for-byte against the legacy DB; point the `mobile/` app at the new API.
3. **Writes next**: POS, PO/PR/GR, stock adjust.
4. **Rebuild the 40 pages** in Next.js domain-by-domain (POS → Inventory → Finance → Customer portal → Marketing), keeping Streamlit alive read-only until the last page lands.

### 8. Honest risks
- NestJS boilerplate drops initial velocity for a Python-native solo dev — mitigated by keeping services minimal early and deferring Redis/worker split.
- Hand-mapping every ugly column is tedious and a wrong mapping silently returns nulls — the read-parity diff suite is the guardrail.
- AI cost/latency under server concurrency — prompt caching, streaming, a hard turn/token budget, per-tenant rate limits.
- No offline POS in either legacy or V2 — flag to the product owner as a separate workstream if the shop needs outage resilience.