# Master Blueprint (STRICT) — Tier 1 Operating Spine

**Audience:** the implementing AI (Claude Sonnet). **Authority:** this document is normative. Where it
says MUST, there is no discretion. Where a concrete identifier is given, use it verbatim.
**Companion:** detailed per-feature notes live in
[docs/17-tier1-spine-implementation-blueprint.md](17-tier1-spine-implementation-blueprint.md). If 17 and
18 disagree, **18 wins**.

> ⚠️ **Stack correction.** An earlier template referenced *Streamlit* `session_state`. That is the legacy
> MCP prototype, NOT this repo. **This project is NestJS + Next.js + Drizzle + PostgreSQL.** There is no
> Streamlit, no `session_state`. Section 2 below defines the real data-flow + client-state rules.

---

## 1. System Architecture & Tech-Stack Rules

### 1.1 Monorepo layout (MUST NOT restructure)

```
apps/
  api/                      # NestJS (Fastify adapter) — the ONLY place business logic + GL postings live
    src/
      modules/<domain>/     # one folder per bounded context (menu, pos, ledger, inventory, payments, hcm, payroll, finance, bi, reports, portal, costing, …)
        <domain>.module.ts
        <domain>.service.ts # business logic
        <domain>.controller.ts
        dto.ts / *.dto.ts   # request/response DTOs (class-validator)
      common/
        decorators.ts       # @Permissions(...) lives here
        guards.ts           # PermissionsGuard
        filters.ts          # AllExceptionsFilter (wraps body as { error: { code, ... } })
    drizzle/                # hand-written/journaled migrations NNNN_*.sql + meta/_journal.json
  web/                      # Next.js (App Router) + React
    src/
      app/<route>/page.tsx
      lib/nav.ts            # nav groups/subgroups + role gating (sidebar)
      components/           # shared UI toolkit (DataTable, FormField, SearchInput, notify toasts, ModulePage)
packages/
  shared/src/permissions.ts # PERMISSIONS[], Role, DEFAULT_ROLE_PERMISSIONS — single source of truth
tools/cutover/             # CI harnesses (basics, compliance, e2e, …) — the gates
compliance/                # build_rcm.py (RCM xlsx generator), policies/, readiness plan
docs/                      # process-narratives/, user-manual/, uat/  (doc-sync MANDATORY)
```

**Rules**
- **R1.1** New backend logic MUST live in `apps/api/src/modules/<domain>/`. Never put business logic in
  controllers or in `apps/web`.
- **R1.2** GL/COGS postings MUST go through existing posting services — never write raw `INSERT` into
  `journal_entries`. Use `LedgerService.postEntry` (Draft+approve, **GL-05**) or
  `CostingService.onIssue/onReceipt`.
- **R1.3** Every new tenant table MUST be RLS-enabled in the same migration (append the standard RLS
  policy loop used by sibling tenant tables) and MUST be journaled in `meta/_journal.json`.
- **R1.4** Frontend reads data ONLY through the API (same-origin proxy). No direct DB access from `web`.
- **R1.5** Money is `numeric` in Postgres and handled as integer-safe decimal strings server-side; never
  use JS `number` for currency math that posts to GL (use the existing decimal helpers in the module).
- **R1.6** Business timezone is **Asia/Bangkok (UTC+7)**. All "business day" dating MUST use the existing
  `ymd()`/`bizYmdDash` helpers, never raw UTC.

### 1.2 Pinned versions (MUST NOT bump in these PRs)

| Dependency | Pin | Rule |
|-----------|-----|------|
| `drizzle-orm` | `^0.36.4` | **MUST NOT** bump (0.45 regresses an insert path — see `compliance/vulnerability-triage.md`). |
| `pnpm` | `11.8.0` via `package.json#packageManager` | MUST NOT also pin `version:` in `pnpm/action-setup`. |
| Node | repo `.nvmrc`/CI | harnesses run with `NODE_OPTIONS=--experimental-sqlite`. |

New runtime deps are **disallowed** unless a step explicitly authorizes one. Prefer existing utilities
(`ReportPdfService` for PDF, BI scheduler for cron-style jobs, `notify` toasts on web).

### 1.3 Build / verify commands (the only accepted "green")

```
pnpm --filter @ierp/shared build      # build first if a harness imports dist
pnpm --filter @ierp/api build
pnpm --filter @ierp/web build
pnpm -r typecheck
NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover basics       # PRIMARY gate for finance/GL/inventory/POS
NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover compliance   # ICFR controls
```

A PR is **not** done until the relevant subset above is green locally AND the PR's CI checks are green.

---

## 2. Data Flow & Client-State Rules (real stack — NOT Streamlit)

### 2.1 End-to-end data flow (one direction, no shortcuts)

```
PostgreSQL (RLS, tenant-scoped)
  ⇅ Drizzle query builder (typed: eq/gte/lte/and — NEVER raw sql`${param}` at user-input sinks)
NestJS Service  (business logic, GL posting, validation, maker-checker)
  ⇄ NestJS Controller  (@Permissions guard, DTO validation via class-validator)
HTTP (JSON)  →  Next.js same-origin API proxy (NEXT_PUBLIC_API_URL = web origin; API_PROXY_TARGET = api origin)
  →  React Server/Client component fetch
  →  UI (DataTable / FormField / ModulePage)
```

- **D2.1** Tenant scoping is enforced by RLS + the JwtUser tenant context. Service methods MUST accept and
  honor the caller's tenant; HQ/Admin callers MUST pass an explicit `tenant_id` for cross-tenant
  aggregations (GL-05 rule).
- **D2.2** Errors surface to the client as `{ error: { code, message, ... } }` (wrapped by
  `AllExceptionsFilter`). The web layer reads `json.error.code`, never `json.code`.
- **D2.3** Drizzle date filters from user input MUST use typed builders (`gte/lte/eq/and`), never a raw
  `sql\`${col} >= ${param}\`` template (CodeQL `js/sql-injection` + the Date-param prod crash).
- **D2.4** A raw JS `Date` MUST NOT be passed into a Drizzle `sql` template (crashes postgres-js in prod
  though PGlite tolerates it). Pass an ISO string or use typed builders.

### 2.2 Client-state conventions (Next.js/React — replaces the "session_state" section)

There is **no global mutable session bag**. State is layered and named by these rules:

- **S2.1 Server state (the default).** Remote data MUST be fetched per-route through the API proxy and
  rendered server-side where possible. Client-side fetching MUST follow the existing pattern in
  neighbouring `apps/web` pages (do not introduce a new data-fetching library). Cache/query keys MUST be
  namespaced `"<domain>:<resource>:<scope>"`, e.g. `"inventory:food-cost-variance:branch-12"`.
- **S2.2 URL state.** Tab/filter selection MUST live in the query string (`?tab=`, `?branch_id=`,
  `?period=`) — consistent with the existing finance cycle tabs. Never store filter state only in memory.
- **S2.3 Local component state** (`useState`) is for ephemeral UI only (open/closed, form draft). Naming:
  `const [<noun>, set<Noun>]`. Initial state MUST be explicit and typed — never `undefined` for a value
  the UI renders (use `null`, `[]`, `''`, or `false`).
- **S2.4 Cross-device user prefs** (sidebar favourites, nav fold-state) go through
  `GET/PUT /api/user-prefs` (existing `UserPrefsModule`). Per-device prefs (recents) stay in
  `localStorage`. Do NOT add new global stores for these.
- **S2.5 Toasts/notifications** MUST use the existing `notify` toast helper; do not roll a new mechanism.
- **S2.6 Permission gating in UI** MUST read the same permission strings as the API (`packages/shared`),
  via the existing nav/role mechanism — never hardcode role names in components.

---

## 3. Data Models (exact, additive only)

All tables below are **new or altered** by this programme. Types are Postgres. Every new table is
tenant-scoped (`tenant_id bigint NOT NULL`), RLS-enabled, and journaled. `id bigserial PRIMARY KEY` and
`created_at timestamptz NOT NULL DEFAULT now()` are implied on new tables unless noted.

### 3.1 Modifier COGS (alter)
- `modifier_options` ADD: `cogs_delta numeric(14,2) NOT NULL DEFAULT 0`,
  `recipe_ref_id bigint NULL REFERENCES menu_recipes(id)`.

### 3.2 X/Z reports
- `xz_reports`: `tenant_id, branch_id bigint, till_session_id bigint, report_type text CHECK in ('X','Z'),
  generated_at timestamptz, generated_by bigint, period_start timestamptz, period_end timestamptz,
  total_sales numeric(14,2), total_cash numeric(14,2), total_card numeric(14,2),
  total_void numeric(14,2), total_discount numeric(14,2), total_refund numeric(14,2),
  cash_expected numeric(14,2), cash_counted numeric(14,2), variance numeric(14,2),
  status text NOT NULL DEFAULT 'DRAFT' CHECK in ('DRAFT','SIGNED'),
  html_snapshot text, content_hash text`.
- `xz_report_denominations`: `report_id bigint, denomination numeric(10,2), count int, total numeric(14,2)`.

### 3.3 BOM yield (alter) + food-cost variance
- `menu_recipe_lines` ADD: `yield_factor numeric(5,4) NOT NULL DEFAULT 1.0000`,
  `waste_factor numeric(5,4) NOT NULL DEFAULT 0.0000`. (Gross qty derived in service:
  `qty_per / NULLIF(yield_factor - waste_factor, 0)`.)
- `food_cost_variance_sessions`: `tenant_id, branch_id bigint, period_date date,
  theoretical_cost numeric(14,2), actual_cogs numeric(14,2), variance_thb numeric(14,2),
  variance_pct numeric(7,4)`.
- `food_cost_variance_lines`: `session_id bigint, tenant_id, ingredient_item_id bigint, station text,
  theoretical_qty numeric(14,4), actual_qty numeric(14,4), variance_qty numeric(14,4),
  unit_cost numeric(14,4),
  reason_code text CHECK in ('WASTE','OVERSTOCK','SPOILAGE','PORTIONING','THEFT','OTHER')`.

### 3.4 Par levels + replenishment
- `location_par_levels`: `tenant_id, branch_id bigint, item_id bigint, par_level numeric(14,4),
  reorder_point numeric(14,4), reorder_qty numeric(14,4), lead_time_days int, supplier_id bigint NULL`;
  UNIQUE(`tenant_id, branch_id, item_id`).
- `replenishment_suggestions`: `tenant_id, branch_id bigint, item_id bigint, current_stock numeric(14,4),
  par_level numeric(14,4), suggested_qty numeric(14,4),
  status text NOT NULL DEFAULT 'PENDING' CHECK in ('PENDING','APPROVED','PO_CREATED','DISMISSED'),
  approved_by bigint NULL, po_no text NULL`.

### 3.5 Period-close checklist (+ alter fiscal_periods)
- `period_close_checklist_items`: `tenant_id, period_code text, item_key text, label text,
  required_role text, sort int`.
- `period_close_sign_offs`: `tenant_id, period_code text, item_key text, signed_by bigint,
  signed_at timestamptz, notes text`.
- `fiscal_periods` ADD: `close_locked_by bigint NULL, close_locked_at timestamptz NULL`.

### 3.6 Thai tax filings
- `thai_tax_filings`: `tenant_id, filing_type text CHECK in ('PP30','ND53','ND1','ND3'),
  period_month int, period_year int,
  status text NOT NULL DEFAULT 'DRAFT' CHECK in ('DRAFT','SUBMITTED','ACCEPTED'),
  submitted_at timestamptz NULL, submission_ref text NULL,
  output_vat_thb numeric(14,2), input_vat_thb numeric(14,2), net_vat_thb numeric(14,2),
  payload text, created_by bigint`; UNIQUE(`tenant_id, filing_type, period_month, period_year`).

### 3.7 Labor OT rules + alerts
- `labor_ot_rules`: `tenant_id, rule_type text CHECK in ('REGULAR_OT','HOLIDAY','HOLIDAY_OT','NIGHT'),
  multiplier numeric(4,2), daily_trigger_hours int, weekly_trigger_hours int, effective_from date`.
- `labor_alerts`: `tenant_id, branch_id bigint, shift_date text,
  alert_type text CHECK in ('LABOR_PCT_EXCEEDED','OT_CAP_APPROACHING','SCHEDULE_GAP'),
  threshold_pct numeric(7,4), actual_pct numeric(7,4), resolved_at timestamptz NULL`.

### 3.8 Clock-in integrity (+ alter timesheets)
- `timesheets` ADD: `clock_in_method text DEFAULT 'PIN' CHECK in ('PIN','QR','FACE_HASH','SUPERVISOR')`,
  `clock_in_lat numeric(9,6) NULL, clock_in_lng numeric(9,6) NULL, geofence_pass boolean NULL`.
- `geofence_zones`: `tenant_id, branch_id bigint, lat numeric(9,6), lng numeric(9,6), radius_m int`.

### 3.9 Feature flags
- `feature_flags`: `tenant_id, flag_key text, enabled boolean NOT NULL DEFAULT false, label text,
  description text, tier text NOT NULL DEFAULT 'LABS' CHECK in ('CORE','LABS')`;
  UNIQUE(`tenant_id, flag_key`).

---

## 4. Edge Cases & Error Handling (normative)

For each, the code MUST behave exactly as stated. Error codes are returned as `{ error: { code } }`.

| # | Failure | Required handling |
|---|---------|-------------------|
| E1 | Division by zero in gross-qty (`yield_factor - waste_factor = 0`) | Use `NULLIF(...,0)`; if null, treat ingredient as **100% yield** (gross = qty_per) and emit a `LABOR`/`DATA` warning row — never throw, never NaN. |
| E2 | NULL `unit_cost` on a recipe line / cost layer | Coalesce to `0`, flag the line `cost_missing=true` in the variance output; do NOT post a GL entry with NaN. |
| E3 | Modifier with no `cogs_delta` and no `recipe_ref_id` | `cogs_delta` defaults to `0` → COGS unchanged (safe). No error. |
| E4 | Z-report when till already `Closed` | Reject with `TILL_ALREADY_CLOSED`. Do not double-post variance. |
| E5 | Z-report denomination count missing/!= expected schema | Reject with `INVALID_DENOMINATIONS`; do not close till. |
| E6 | PDF render unavailable (Chromium absent) | `ReportPdfService.renderHtmlToPdf` returns `null` → fall back to serving the stored `html_snapshot`; the Z-report stays SIGNED regardless (PDF is presentational). |
| E7 | Replenishment for an item with no par level | Skip silently (no suggestion); never null-deref `par_level`. |
| E8 | JE/posting into a `Closed` or `close_locked` period | Reject with `PERIOD_CLOSED`. Only `emergencyReopenPeriod` (CFO role) can reopen, and it MUST write an `audit_log` row. |
| E9 | `lockPeriod` called with incomplete checklist | Reject with `CLOSE_CHECKLIST_INCOMPLETE`; list missing `item_key`s. |
| E10 | PP30 with zero invoices in period | Return a valid filing with all amounts `0`, `status='DRAFT'`; never throw. |
| E11 | OT calc beyond 48h/week cap | Cap at the weekly limit, log overflow to `labor_alerts` (`OT_CAP_APPROACHING`); do not silently pay over cap. |
| E12 | Duplicate clock-in within 15 min | Reject with `DUPLICATE_PUNCH`. Supervisor override path is the only bypass and is audit-logged. |
| E13 | Geofence configured but no GPS supplied | `geofence_pass=null`, accept the punch but flag for review (do not hard-reject — kiosk devices may lack GPS). |
| E14 | DB timeout / transient error on a scheduled BI job | Job is idempotent per (job, period); on failure it MUST NOT half-post — wrap multi-row posts in a transaction; let the scheduler retry on next `runDue`. |
| E15 | Concurrent migration number collision on merge | Renumber `.sql` + `_journal.json` idx to the next free number; the `migrations-journaled` gate fails on duplicates. |
| E16 | Cross-tenant aggregation by HQ/Admin without `tenant_id` | Require explicit `tenant_id`; otherwise scope to caller. Never leak across tenants. |

**General rules:** every multi-row GL/inventory mutation MUST run in a single transaction; partial writes
are forbidden. Validation failures return a stable error `code` (SCREAMING_SNAKE) that UAT asserts on.

---

## 5. Sequential Implementation Plan (one PR per step)

Each Step is one self-contained PR: branch → migration → service → controller → web → RCM → docs →
green gates → squash-merge to `main`. Steps are ordered so the app never breaks between merges (all
schema changes are additive with safe defaults). Reserve migration numbers but take the **next free**
number at implementation time.

> Per-step "Definition of Done" (applies to EVERY step): (a) migration journaled + RLS loop for new
> tenant tables; (b) permission string added to `packages/shared/src/permissions.ts` + granted in
> `DEFAULT_ROLE_PERMISSIONS`; (c) endpoint(s) `@Permissions`-gated; (d) web page wired into `nav.ts`;
> (e) RCM control added in `build_rcm.py` + xlsx regenerated; (f) process-narrative + user-manual + UAT
> (positive + negative) updated with exact error codes + revision history bumped; (g) `basics`
> (+`compliance` if controls changed) + typecheck + api/web build green; (h) one commit/tight series with
> code AND docs; (i) PR merged only when CI green.

- **Step 1 — Modifier COGS deltas** (mig 0155). Alter `modifier_options`; extend
  `menu/recipe.service.ts#applyDeduction` to add `Σ(cogs_delta×qty)` (+ optional `recipe_ref_id`
  mini-recipe deduction); web modifier form gets a COGS-delta field. No new RCM control. Gates: `basics`.
- **Step 2 — X/Z report + EoD close** (mig 0156). New `xz_reports`/`xz_report_denominations`; new
  `modules/pos/xz-report.service.ts` (`generateXReport`, `generateZReport` reusing
  `payments.service.ts#closeTill` variance→GL 5830/1000); store `html_snapshot`+`content_hash`; endpoints
  `POST /api/pos/tills/:id/x-report|z-report`, `GET /api/pos/xz-reports/:id/pdf`; web `/pos/close-of-day`
  wizard; permission `pos_close`; RCM `POS-07`.
- **Step 3 — BOM yield/waste factors** (mig 0157). Alter `menu_recipe_lines`; compute gross qty in
  `menu/food-cost.service.ts`; web recipe-line editor exposes yield/waste with derived gross cost. (No
  variance UI yet — additive, safe.)
- **Step 4 — Food-cost variance** (mig 0158). New variance tables; extend `FoodCostService`
  (`computeTheoreticalConsumption`, `getFoodCostVariance`, `runVarianceSession`); register BI job type
  `food_cost_variance`; endpoint `GET /api/inventory/food-cost-variance`; web `/inventory/food-cost`;
  RCM `INV-11`.
- **Step 5 — Par levels + replenishment** (mig 0159). New tables; `modules/inventory/replenishment.service.ts`
  (`runReplenishmentCheck`, `approveReplenishment`→`portal.myerp.service.ts#createPurchaseOrder`); BI job
  `inventory_replenishment_check`; endpoints + web `/inventory/replenishment`; RCM `INV-12`.
- **Step 6 — Period-close checklist + hard lock** (mig 0160). New checklist/sign-off tables + alter
  `fiscal_periods`; extract `modules/ledger/period-close.service.ts`; replace open `allowClosedPeriod`
  bypass with CFO-only `emergencyReopenPeriod` (audit-logged); endpoints + web `/finance/period-close`;
  permission `gl_close`; RCM `GL-06` + update `GL-05`.
- **Step 7 — Thai tax filing (ภพ.30 / ภงด.53)** (mig 0161). New `thai_tax_filings`;
  `modules/finance/thai-tax.service.ts` (`generatePP30`, `generateND53`, `getRemittanceCalendar`);
  endpoints under `/api/tax/*`; web `/finance/tax`; permission `tax_file`; RCM `TAX-05`;
  `compliance/policies/tax-policy.md`.
- **Step 8 — Labor OT rules + labor-% alerts** (mig 0162). New `labor_ot_rules` (seed Thai defaults) +
  `labor_alerts`; `modules/payroll/ot-rules.service.ts` (`computeOTPay` ladder + 48h cap) and
  `checkLaborPctAlert`; endpoints `/api/labor/*`; web `/labor/alerts`; permission `labor_admin`; RCM
  `HR-04`.
- **Step 9 — Anti-buddy-punch clock-in** (mig 0163). Alter `timesheets` + new `geofence_zones`;
  `modules/hcm/clock-in.service.ts` (`clockIn` geofence + 15-min dup guard; `supervisorOverride`
  audited); web/POS clock-in widget; RCM `HR-05`.
- **Step 10 — Feature flags / Labs** (mig 0164). New `feature_flags`; seed thin modules `tier='LABS',
  enabled=false` for new tenants; add Labs nav group in `lib/nav.ts` (gated); `/settings/labs` toggles;
  Admin-only.

**Tier 2 (after Step 10, separate planning):** BI drill-down + KPI alerts; demand-ML→MRP; AR
collections hard credit-hold; supplier price-list versioning + scorecard.

---

## 6. Non-negotiable guardrails (quick reference)

1. Additive migrations only; safe defaults so a half-deployed schema never breaks the running app.
2. Never bump `drizzle-orm`; never add a runtime dep without explicit authorization.
3. Never edit parity-locked code (`forecasting.service.ts` — "ห้ามเปลี่ยน — parity").
4. Never post GL with raw SQL or with NaN/Date params; typed builders only at user-input sinks.
5. Docs (narrative + user-manual + UAT) ship in the SAME PR as the code — a step is not done otherwise.
6. Merge only on green CI; on a number collision, renumber and re-verify.
