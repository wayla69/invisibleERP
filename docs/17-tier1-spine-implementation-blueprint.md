# Blueprint 17 — Tier 1 "Operating Spine" implementation plan

**Status:** Ready for implementation (hand-off to Sonnet).
**Author:** planning pass, 2026-06-26.
**Scope:** Deepen the F&B operating spine — inventory/recipe cost control, POS/kitchen ops,
finance close + Thai tax, labor/scheduling — then consolidate thin modules behind a Labs flag.

This document is **self-contained**: every workstream below lists the exact existing tables,
service files, and methods to extend, so each PR can be picked up cold. Verify identifiers still
exist before editing (the repo moves fast). Migrations continue from **0155** (current head: `0154`).

---

## Ground rules (read first)

- **Recipes live in `apps/api/src/modules/menu/`**, NOT `modules/recipes/`. Key services:
  `RecipeService` (`menu/recipe.service.ts`) and an existing `FoodCostService` (`menu/`).
- **Costing lives in `apps/api/src/modules/costing/costing.service.ts`** — `onReceipt()`,
  `onIssue()` (Dr 5000 COGS / Cr 1200 Inventory, idempotent via `source='POS-COGS-V'`).
- **Every new tenant table needs:** RLS loop appended in the migration + a journaled
  `meta/_journal.json` entry (sequential `idx`, ascending `when`) — see CLAUDE.md. Use the **next
  free** 4-digit number; renumber on merge conflict.
- **Permissions:** add new permission strings to `PERMISSIONS` in
  `packages/shared/src/permissions.ts`, grant in `DEFAULT_ROLE_PERMISSIONS`, gate endpoints with
  `@Permissions('...')` (decorator in `apps/api/src/common/decorators.ts`).
- **RCM controls:** add an `add(...)` call (17 positional columns) in `compliance/build_rcm.py`,
  then regenerate: `python3 compliance/build_rcm.py` from repo root. Never hand-edit the `.xlsx`.
- **Docs are part of "done"** (CLAUDE.md doc-sync policy): update the affected
  `docs/process-narratives/<cycle>.md`, `docs/user-manual/`, and `docs/uat/` with each PR.
- **Primary CI gate for finance/GL/inventory:** `pnpm --filter @ierp/cutover basics` (extend it).
  Also keep `compliance` green. Build: `pnpm --filter @ierp/api build`, `pnpm -r typecheck`.

---

## Recommended PR order

| Order | PR | Effort | Why here |
|------|-----|--------|----------|
| 1 | **T1-C** Modifier COGS deltas | ~1d | Fast win, no deps, fixes COGS leak |
| 2 | **T1-D** X/Z report + EoD close | ~2d | Standalone, shippable, operator-mandatory |
| 3 | **T1-A** Yield/waste factors + food-cost variance | ~3d | Highest ROI |
| 4 | **T1-B** Per-location par levels + replenishment | ~2d | Builds on T1-A costing |
| 5 | **T1-F** Period-close hard lock + checklist | ~2d | Compliance |
| 6 | **T1-E** Thai tax filing (ภพ.30 / ภงด.53) | ~3d | Compliance / diligence story |
| 7 | **T1-G** OT premium rules + labor-% alerting | ~2d | Labor cost control |
| 8 | **T1-H** Anti-buddy-punch clock-in integrity | ~1d | Labor control |
| — | **T3** Feature flags / Labs section | ~1d | Parallel any time |
| — | **T2-*** BI / ML-MRP / collections / supplier | after T1 | Tier 2 |

Each PR = one migration (or a tight pair) + service + controller + web page + docs + RCM + tests.

---

## T1-C · Modifier COGS deltas  *(do first)*

**Problem:** `modifier_options` (defined in `0009_menu.sql`) has `price_delta numeric(14,2)` but **no
cost column**. When "extra patty" fires, revenue moves but COGS does not → margins overstated.

**Existing facts:**
- Table `modifier_options` cols: `id, tenant_id, group_id, name, price_delta, is_default, sort, active, created_at`.
- Link table: `menu_item_modifier_groups` (menu_item_id → modifier_groups).
- Sale path: `PortalPosService.createSale()` → `RecipeService.applyDeduction()` (recipe items, Cr 1200
  when `post_cogs=true`); non-recipe items costed via `CostingService.onIssue()`.

**Build:**
1. **Migration `0155_modifier_cogs.sql`**
   - `ALTER TABLE modifier_options ADD COLUMN cogs_delta numeric(14,2) NOT NULL DEFAULT 0;`
   - `ALTER TABLE modifier_options ADD COLUMN recipe_ref_id bigint REFERENCES menu_recipes(id);`
     (optional link to a mini-recipe so the delta can be auto-derived from ingredient cost).
   - No new table → no RLS loop needed, but still journal the migration.
2. **`menu/recipe.service.ts` → `applyDeduction()`**: when a sale line carries modifier option ids,
   add `Σ(cogs_delta × qty)` to the line's COGS before posting. If `recipe_ref_id` is set, deduct
   that mini-recipe's ingredients too (reuse the existing per-line deduction loop).
3. **Web:** modifier edit form (find the menu admin screen under `apps/web/src/app/.../menu`) — add a
   "COGS delta (฿)" `FormField`; if `recipe_ref_id` chosen, show computed cost read-only.
4. **Backfill note:** leave existing rows at `0` (safe default); operators set real deltas via UI.

**Docs:** `process-narratives/inventory.md` (modifier costing line), UAT positive (modifier adds COGS)
+ negative (zero-delta modifier leaves COGS unchanged). No new RCM control required.

---

## T1-D · X/Z report + formal EoD cash-close

**Problem:** `closeTill` (`modules/payments/payments.service.ts:314`) posts variance to GL
(Dr/Cr **5830** Cash Over/Short ↔ **1000** Cash; material variance → DRAFT JE maker-checker) but there
is no structured X-read (mid-shift) / Z-tape (close) with denomination count, payment-method
breakdown, and an archived signed report.

**Existing facts:**
- Tables: `till_sessions` (`session_no, opened_by, opened_at, closing_count, expected_cash, variance,
  status 'Open'|'Closed', denominations jsonb, variance_journal_no, variance_status, ...`),
  `cash_movements` (`movement_no, till_session_id, type 'paid_in'|'paid_out'|'drop', amount, journal_no`).
- PDF: `ReportPdfService.renderHtmlToPdf(html)` in `modules/reports/reports-pdf.service.ts` returns a
  **Buffer** (lazy Playwright Chromium; null fallback to HTML). **There is no persistent PDF store
  today** — reports stream as HTTP downloads. ⚠️ Decision: store the Z-report **HTML + a content hash**
  in the DB row (so it's tamper-evident and reproducible) and render the PDF on demand; do NOT invent a
  blob bucket in this PR.

**Build:**
1. **Migration `0156_xz_reports.sql`**
   - `xz_reports`: `id, tenant_id, branch_id, till_session_id, report_type text ('X'|'Z'),
     generated_at, generated_by, period_start, period_end, total_sales, total_cash, total_card,
     total_void, total_discount, total_refund, cash_expected, cash_counted, variance,
     status text DEFAULT 'DRAFT' ('DRAFT'|'SIGNED'), html_snapshot text, content_hash text`.
   - `xz_report_denominations`: `report_id, denomination numeric, count int, total numeric`.
   - Append RLS loop for both (tenant-scoped) + journal entries.
2. **`modules/pos/xz-report.service.ts`** (new)
   - `generateXReport(tillSessionId, user)` — snapshot of current totals, does **not** close the till.
   - `generateZReport(tillSessionId, denominations[], user)` — reuse `closeTill`'s variance→GL logic
     (call into payments service, don't duplicate), set `status='SIGNED'`, store `html_snapshot` +
     `content_hash` (sha256 of the canonical totals string). Aggregate payment-method totals from the
     session's sales.
3. **API** (new controller or extend pos controller): `POST /api/pos/tills/:id/x-report`,
   `POST /api/pos/tills/:id/z-report`, `GET /api/pos/xz-reports/:id/pdf` (renders via `ReportPdfService`).
   Gate Z with a manager permission (`pos_close` — add to permissions).
4. **Web:** `/pos/close-of-day` wizard — (1) denomination count grid (20/50/100/500/1000 ฿),
   (2) review X summary, (3) confirm → Z + GL + PDF download.

**RCM:** add `POS-07` — *EoD Z-report sign-off* (Det, Manual, Daily, owner "Branch Manager", maps to
cash FSLI). **Docs:** `process-narratives/pos.md` close-of-day workflow + Mermaid; UAT close + over/short.

---

## T1-A · Yield/waste factors on BoM + theoretical-vs-actual food-cost variance  *(highest ROI)*

**Problem:** `menu_recipe_lines` carries `qty_per` but assumes 100% yield, so margins are fiction.
`waste_log` exists but is never reconciled against theoretical consumption → can't say
"Sauce station 8% over theoretical → retrain."

**Existing facts:**
- `menu_recipes`: `id, tenant_id, menu_item_id, sku, yield_qty, post_cogs, active, notes, ...`.
- `menu_recipe_lines`: `id, tenant_id, recipe_id, ingredient_item_id, ingredient_description,
  qty_per, uom, unit_cost`.
- `waste_log`: `..., item_id, qty, uom, reason_code, unit_cost, total_cost, journal_no, ...`
  (`modules/inventory/waste.service.ts` `logWaste`).
- `cost_layers`, `cost_movements`, `item_costing` hold actual perpetual cost; `CostingService.onIssue`
  records actual issue cost per sale.
- `FoodCostService` already exists in `modules/menu/` — **extend it, don't create a parallel service.**

**Build:**
1. **Migration `0157_bom_yield_factors.sql`**
   - `ALTER TABLE menu_recipe_lines ADD COLUMN yield_factor numeric(5,4) NOT NULL DEFAULT 1.0000;`
     (usable fraction after trim, e.g. 0.85 for onion).
   - `ALTER TABLE menu_recipe_lines ADD COLUMN waste_factor numeric(5,4) NOT NULL DEFAULT 0.0000;`
     (expected extra shrink on top of trim).
   - Gross qty is **derived in service** as `qty_per / NULLIF(yield_factor - waste_factor, 0)` — avoid a
     STORED generated column if Drizzle/PGlite parity is risky; compute it in `FoodCostService`.
2. **Migration `0158_food_cost_variance.sql`**
   - `food_cost_variance_sessions`: `id, tenant_id, branch_id, period_date, theoretical_cost,
     actual_cogs, variance_thb, variance_pct, created_at`.
   - `food_cost_variance_lines`: `id, session_id, tenant_id, ingredient_item_id, station text,
     theoretical_qty, actual_qty, variance_qty, unit_cost, reason_code text
     ('WASTE'|'OVERSTOCK'|'SPOILAGE'|'PORTIONING'|'THEFT'|'OTHER')`.
   - RLS loops + journal both.
3. **`modules/menu/food-cost.service.ts` (extend `FoodCostService`)**
   - `computeTheoreticalConsumption(tenantId, branchId, from, to)` — Σ over sales: items sold ×
     recipe gross_qty per ingredient.
   - `getFoodCostVariance(tenantId, from, to, branchId?)` — theoretical vs `cost_movements`/`onIssue`
     actuals, grouped by station/category/ingredient.
   - `runVarianceSession(tenantId, branchId, date)` — materialize a session + lines (call from EoD or
     a BI scheduled job `food_cost_variance` — see BI scheduler note below).
4. **API:** `GET /api/inventory/food-cost-variance?from&to&branch_id&category_id&reason_code`.
5. **Web:** `/inventory/food-cost` — `DataTable` theoretical vs actual, variance% heat-map by station,
   drill to ingredient lines + reason code.

**RCM:** `INV-11` — *Food-cost variance review* (Det, Manual/IT-dependent, Weekly, owner "F&B Controller").
**Docs:** `process-narratives/inventory.md` yield + variance workflow; UAT correct-yield vs over-threshold.

---

## T1-B · Per-location par levels + demand-driven replenishment

**Problem:** stock is costed globally; a multi-branch chain can't set per-site par levels or trigger
site-level POs.

**Existing facts:**
- `createPurchaseOrder(dto: MyPoDto, user)` at `modules/portal/portal.myerp.service.ts:100`
  (`MyPoDto = { supplier_name?, remarks?, items: { item_description, qty, uom?, unit_price }[] }`).
- ATP/on-hand in `item_costing.on_hand`. Branch dimension exists as `branch_id` on inventory tables.
- BI scheduler (`modules/bi/bi.service.ts`): `REPORT_TYPES` (line ~24), `generateReport` (~340),
  `runDue` (~420). Add a new idempotent job type here for nightly checks.

**Build:**
1. **Migration `0159_location_par_levels.sql`**
   - `location_par_levels`: `id, tenant_id, branch_id, item_id, par_level, reorder_point,
     reorder_qty, lead_time_days, supplier_id, created_at` (unique on tenant+branch+item).
   - `replenishment_suggestions`: `id, tenant_id, branch_id, item_id, current_stock, par_level,
     suggested_qty, status text ('PENDING'|'APPROVED'|'PO_CREATED'|'DISMISSED'), created_at,
     approved_by, po_no`.
   - RLS loops + journal.
2. **`modules/inventory/replenishment.service.ts`** (new)
   - `runReplenishmentCheck(tenantId, branchId?)` — compare per-branch on-hand vs `reorder_point`,
     insert PENDING suggestions.
   - `approveReplenishment(id, user)` — maker-checker → `createPurchaseOrder` draft, set `PO_CREATED`.
   - Register a BI job type `inventory_replenishment_check` in `REPORT_TYPES` + dispatch in
     `generateReport` (nightly, idempotent per branch+date).
3. **API:** `GET /api/inventory/replenishment-suggestions?branch_id`,
   `POST /api/inventory/replenishment-suggestions/:id/approve`,
   `POST /api/inventory/replenishment-suggestions/:id/dismiss`.
4. **Web:** `/inventory/replenishment` — pending suggestions grouped by branch, one-click approve→PO.

**RCM:** `INV-12` — *Par-level replenishment authorization* (Prev, maker-checker on approve).
**Docs:** inventory narrative + UAT (below-reorder triggers suggestion; approve creates draft PO).

---

## T1-F · Period-close hard lock + close checklist

**Problem:** `closePeriod(period, tenantId?, opts?)` sets `fiscal_periods.status='Closed'` and
`postEntry` blocks JEs when closed (`ledger.service.ts:329` → `PERIOD_CLOSED`), **but** the
`allowClosedPeriod` bypass on `PostEntryDto` can be set by any admin with no SoD, and nothing forces a
checklist before close.

**Existing facts:**
- `fiscal_periods`: `id, code, start_date, end_date, tenant_id, status ('Open'|'Closed')`.
- `audit_log` is append-only (trigger `audit_log_no_mutate` → `audit_log_immutable()`).

**Build:**
1. **Migration `0160_period_close_checklist.sql`**
   - `period_close_checklist_items`: `id, tenant_id, period_code, item_key, label, required_role,
     sort` — seed template (AR reconciled, AP reconciled, bank reconciled, inventory counted,
     tax filed).
   - `period_close_sign_offs`: `id, tenant_id, period_code, item_key, signed_by, signed_at, notes`.
   - `ALTER TABLE fiscal_periods ADD COLUMN close_locked_by bigint, ADD COLUMN close_locked_at timestamptz;`
   - RLS loops + journal.
2. **`modules/ledger/period-close.service.ts`** (extract close logic out of `ledger.service.ts`)
   - `getCloseChecklist(tenantId, period)`; `signOffChecklistItem(period, itemKey, user)` (role-gated).
   - `lockPeriod(period, user)` — only when **all** items signed; requires `gl_close` permission
     (Controller/CFO); writes `close_locked_by/at`.
   - Replace the open `allowClosedPeriod` bypass with `emergencyReopenPeriod(period, user, reason)` —
     CFO-only, writes an `audit_log` row, sends a notification. Keep year-end closing JEs working
     (they already use a scoped path — preserve it).
3. **RCM:** update `GL-05` (JE posting) note + add `GL-06` *Period close sign-off & lock*.
4. **Web:** `/finance/period-close` — checklist with per-role sign-off buttons; Lock enabled at 100%.

**Docs:** `process-narratives/finance.md` close workflow + Mermaid; UAT (cannot lock with open items;
locked period rejects JE; emergency reopen audited).

---

## T1-E · Thai tax filing — ภพ.30 (VAT return) + ภงด.53 (WHT)

**Problem:** VAT is configured (`tenants.vat_rate`, `tax_country`) and invoices carry VAT
(`tax_invoices.vat_amount/vat_rate`, `tax_invoice_lines`; AP `ap_transactions.vat_amount`), but nothing
aggregates into a filing or remittance calendar.

**Build:**
1. **Migration `0161_thai_tax_filings.sql`**
   - `thai_tax_filings`: `id, tenant_id, filing_type text ('PP30'|'ND53'|'ND1'|'ND3'),
     period_month int, period_year int, status text ('DRAFT'|'SUBMITTED'|'ACCEPTED'),
     submitted_at, submission_ref, output_vat_thb, input_vat_thb, net_vat_thb, payload text,
     created_by, created_at` (unique tenant+type+month+year).
   - RLS loop + journal.
2. **`modules/finance/thai-tax.service.ts`** (new)
   - `generatePP30(tenantId, month, year)` — output VAT from `tax_invoices`, input VAT from
     `ap_transactions.vat_amount`, net payable; render RD ภพ.30 layout (start with a structured JSON/
     printable form; XML per RD schema can be a follow-up).
   - `generateND53(tenantId, month, year)` — aggregate WHT from AP payments by vendor TIN.
   - `getRemittanceCalendar(tenantId, year)` — deadlines (ภพ.30 by 15th of following month; ภงด.1/3/53
     by 7th).
3. **API:** `GET /api/tax/pp30/:year/:month`, `POST /api/tax/pp30/:year/:month/submit`,
   `GET /api/tax/nd53/:year/:month`, `GET /api/tax/remittance-calendar`. Gate with `tax_file` permission.
4. **Web:** `/finance/tax` — remittance calendar + per-return draft/submit + printable download.

**RCM:** `TAX-05` *VAT return preparation & review* (Det, Monthly, owner "Tax Accountant").
**Docs:** `process-narratives/finance.md` Thai-tax section; `compliance/policies/tax-policy.md`;
UAT (PP30 nets output−input correctly; submit locks the period's VAT).

---

## T1-G · Labor OT premium rules engine + labor-% alerting

**Problem:** `overtimePay(otHours, hourlyRate, multiplier=1.5)` (`modules/payroll/payroll-calc.ts`)
hardcodes 1.5×; Thai LPA needs tiered premiums (regular OT 1.5×, holiday 2×, holiday-OT 3×) + 8h/day,
48h/week caps; no real-time labor-% alert. `shift_schedules` (`emp_code, shift_date, hours,
hourly_rate, status`) and `timesheets` (`regular_hours, ot_hours`) exist.

**Build:**
1. **Migration `0162_labor_rules.sql`**
   - `labor_ot_rules`: `id, tenant_id, rule_type text ('REGULAR_OT'|'HOLIDAY'|'HOLIDAY_OT'|'NIGHT'),
     multiplier numeric(4,2), daily_trigger_hours int, weekly_trigger_hours int, effective_from date`.
     Seed Thai defaults (1.5 / 2 / 3 / 1.0-tracked; daily 8, weekly 48).
   - `labor_alerts`: `id, tenant_id, branch_id, shift_date, alert_type text
     ('LABOR_PCT_EXCEEDED'|'OT_CAP_APPROACHING'|'SCHEDULE_GAP'), threshold_pct, actual_pct,
     resolved_at, created_at`.
   - RLS loops + journal.
2. **`modules/payroll/ot-rules.service.ts`** (new) + extend `payroll-calc.ts`
   - `computeOTPay(employeeId, shiftId)` — apply rule ladder, respect 48h weekly cap, log each tier.
   - `checkLaborPctAlert(branchId, date)` — clock-in hours × blended rate vs shift revenue; fire alert
     above per-branch threshold (default 35%). Hook on shift close / nightly BI job.
3. **API:** `GET/PUT /api/labor/ot-rules`, `GET /api/labor/alerts`,
   `POST /api/labor/alerts/:id/resolve`. Permission `labor_admin`.
4. **Web:** `/labor/alerts` — labor-% gauge per branch + OT-cap warnings per employee.

**RCM:** `HR-04` *Overtime authorization & labor-cost monitoring*. **Docs:** add a labor cycle narrative
section + UAT (OT crosses 8h→1.5×; holiday→2×; labor% over threshold fires alert).

---

## T1-H · Anti-buddy-punch clock-in integrity

**Build:**
1. **Migration `0163_clock_integrity.sql`**
   - `ALTER TABLE timesheets ADD COLUMN clock_in_method text DEFAULT 'PIN'
     ('PIN'|'QR'|'FACE_HASH'|'SUPERVISOR'), ADD COLUMN clock_in_lat numeric(9,6),
     ADD COLUMN clock_in_lng numeric(9,6), ADD COLUMN geofence_pass boolean;`
   - `geofence_zones`: `id, tenant_id, branch_id, lat, lng, radius_m`. RLS + journal.
2. **`modules/hcm/clock-in.service.ts`** (new)
   - `clockIn(employeeId, method, lat?, lng?)` — geofence check if a zone is configured; reject a
     duplicate punch within 15 min; record method.
   - `supervisorOverride(timesheetId, supervisorId, reason)` — audit-logged, supervisor role.
3. **Web/POS:** PIN-pad clock-in widget with optional geolocation; QR mode for kiosk tablets.

**RCM:** `HR-05` *Time-and-attendance integrity*. **Docs:** UAT (duplicate punch rejected; out-of-fence
flagged; supervisor override audited).

---

## T3 · Feature flags / "Labs" consolidation  *(parallel, any time)*

**Goal:** turn "130 shallow doors" into "tight core + opt-in Labs" without deleting anything.

1. **Migration `0164_feature_flags.sql`**
   - `feature_flags`: `id, tenant_id, flag_key, enabled boolean, label, description,
     tier text ('CORE'|'LABS')`. RLS + journal.
   - Seed thin modules as `tier='LABS', enabled=false` for **new** tenants: consolidation,
     intercompany, manufacturing_mrp, sourcing_rfq, gamification, referrals, wheels, custom_objects,
     etc. Keep genuinely-used ones (leases/IFRS-16) `CORE`/on. Existing tenants keep current state.
2. **Web nav** (`apps/web/src/lib/nav.ts` — supports collapsible `subgroups`): add a bottom **Labs**
   group gated by flags; `AppShell` already renders subgroups.
3. **Settings:** `/settings/labs` — per-flag toggles, Admin role.

**Docs:** `docs/15`/`docs/16` nav docs; note which modules moved to Labs.

---

## Tier 2 (after the spine — not yet sequenced)

| PR | Feature | Anchor |
|----|---------|--------|
| T2-A | BI self-serve drill-down + KPI alerts + scheduled distribution | extend `bi.service.ts` |
| T2-B | Demand-ML → MRP wiring (7/14/28-day MA forecast → reorder qty) | extend `replenishment.service.ts` |
| T2-C | AR collections hard credit-hold + CFO escalation | `modules/finance/collections.service.ts` (dunning exists) |
| T2-D | Supplier price-list versioning + scorecard automation | `modules/procurement/` |

---

## Migration ledger (reserve as you go)

| Mig | Purpose |
|-----|---------|
| 0155 | Modifier COGS deltas (T1-C) |
| 0156 | X/Z report tables (T1-D) |
| 0157 | BOM yield/waste factors (T1-A) |
| 0158 | Food-cost variance tables (T1-A) |
| 0159 | Location par levels + replenishment (T1-B) |
| 0160 | Period-close checklist + lock (T1-F) |
| 0161 | Thai tax filings (T1-E) |
| 0162 | Labor OT rules + alerts (T1-G) |
| 0163 | Clock-in integrity + geofence (T1-H) |
| 0164 | Feature flags / Labs (T3) |

> Numbers are reservations — if `main` advances, take the **next free** number and renumber both the
> `.sql` and its `_journal.json` idx (CLAUDE.md migration-numbering rule).

---

## Per-PR definition of done

1. Migration(s) journaled, RLS loop appended for new tenant tables, **next-free** number.
2. Service + controller + `@Permissions`, permission added to `packages/shared/src/permissions.ts`.
3. Web page wired into `nav.ts` with correct role gate.
4. RCM control added in `build_rcm.py`, xlsx regenerated.
5. Docs: process narrative + Mermaid + control matrix, user-manual module page, UAT (positive +
   negative/control) with exact error codes, revision-history bumped.
6. `pnpm --filter @ierp/cutover basics` extended + green; `compliance` green; `pnpm -r typecheck`;
   `pnpm --filter @ierp/api build`.
7. One commit (or tight series) carrying **both** code and docs.
