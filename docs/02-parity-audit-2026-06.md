# 02b — ERPPOS → V2 Parity Audit (endpoint-by-endpoint)

**Date:** 2026-06-22
**Method:** Six parallel domain audits reading the actual code on both sides — legacy `ERPPOS_Invisible.py` (+ `api_server.py`, `erp_mcp/tools/*`, `analytics/*`) vs V2 `apps/api/src/modules/*`, `apps/web/src/app/*`. The self-reported [01-feature-parity.md](01-feature-parity.md) was treated as a **claim to verify**, not ground truth.
**Cross-reconciliation:** single-agent errors were corrected against other agents' evidence (e.g. Price List was flagged "missing" by one agent but another found the real `POST /api/price-list` in the marketing module — resolved to ✅).

> **Confidence.** Verdicts backed by `file:line` evidence are high-confidence. Two items where agents disagreed are listed under **§3 Needs verification** rather than asserted.

Legend: ✅ parity · ⚠️ partial in V2 · ❌ missing in V2 · ➕ V2-only (ahead of legacy).

---

## 0. Headline

V2 is **not behind** ERPPOS overall. On **Finance, Procurement, and Platform** it is a strict **superset** (double-entry GL, 3-way match, supplier scorecards/blocklist, FX, consolidation, revenue recognition, API keys/webhooks/MFA/OIDC, self-serve billing — none exist in ERPPOS). All ~30 legacy `api_server.py` REST endpoints are ported with parity.

Real gaps cluster in **four areas**:
1. **Admin tooling added to ERPPOS on 2026-06-22** — module enable/disable, generic master-data import/export, Fixed-Asset QR. Absent in V2 by definition.
2. **Warehouse / QR operations** — stocktake workflow, printable QR label sheets, scan-to-fill, mobile scan sessions, lot UI.
3. **Claims & Delivery Orders** — no module found on either side.
4. **Customer-portal UI pages** — several backends exist in V2 but the portal page is not wired up.

---

## ✅ Update 2026-06-22 — first 3 gaps IMPLEMENTED in V2

Gaps **#1 (module flags)**, **#2 (master-data import/export)**, **#4 (inventory QR labels)** and **#5 (asset QR tags + scan-update)** are now built and green on PGlite (22-check `tools/cutover/src/module-qr.ts`, no regressions in e2e/tenant-isolation/worldclass). Web UI wired (Settings → Modules tab, nav module-gating, Master Data page, Assets → QR tab).

- **Module flags:** `module_configs` table (global) · `ModuleConfigService` + `ModuleEnabledGuard` (global guard, `users` always-on) · `GET/POST /api/admin/modules` + `GET /api/modules/effective` (nav).
- **Master-data import/export:** `MasterDataService` + `MASTER_REGISTRY` (items, customers, vendors, locations, price_list, promotions, bom_master, assets) · `GET /api/admin/master-data/entities` · `GET :entity/export?format=xlsx|csv` · `GET :entity/template` · `POST :entity/import` (rows|csv, append|replace).
- **QR:** `QrService` (qrcode + Playwright→PDF) · assets `GET :assetNo/qr`, `GET qr/labels`, `POST scan-update` (+ `asset_movements` table, physical-tracking columns) · inventory `POST /api/inventory/qr/labels` · shared `parseQrPayload`/`buildItemQrPayload`/`buildAssetQrPayload` for scan-to-fill.
- **Migration:** `0046_module_qr.sql` (journaled) re-runs the RLS loop for `asset_movements`.

**Gap #3 also done (2026-06-22):** stocktake + goods-issue/transfer built with QR scan-to-fill — `StockOpsService` (uses the existing service-less `stocktakes`/`stock_movements` tables), `POST /api/stocktake` (+`/post`), `POST /api/inventory/issue|transfer`, `GET /api/inventory/movements`; `MI` doc-prefix added; web `/stocktake` + `/goods-issue` pages. Audit model preserved (snapshots untouched). `tools/cutover/src/stock-ops.ts` 13/13.

**ALL remaining gaps closed (2026-06-22):** Claims (sales `order_claims` + supplier `gr_claims`), Delivery Orders (logistics tables, create-from-order + status + POD), Lot/batch read (ledger/expiry-buckets/FEFO), AP/AR aging buckets + AP-aging xlsx export, Mobile scan sessions (open→scan→close-commit), Image manager (`item_images` data-URLs, migration 0047), User-CRUD (`/api/admin/users`), Mini-ERP sub-accounts (`/api/portal/my/users`). Web pages added for all internal ones + portal variance/my-users + nav. `tools/cutover/src/gaps.ts` 33/33. **Deferred slivers** (not blocking): survey portal respondent (backend gated to staff `marketing` perm), portal BoM (no backend endpoint), campaign popups on portal dashboard, finance-page aging widget (aging API + export are done) — left to avoid clobbering the concurrent Phase B/C session editing those files.

## 1. Consolidated gap register (port checklist)

| # | Gap | ERPPOS evidence | V2 status | Pri |
|---|-----|-----------------|-----------|-----|
| 1 | **Module enable/disable (feature flags)** | `tbl_module_config`, `_module_enabled`/`_set_module_enabled`, `ALWAYS_ON_MODULES={'users'}`, "Modules On/Off" tab | No feature-flag system; no `module_configs` table | 🔴 High |
| 2 | **Master-data import/export (in-app, all entities)** | `MASTER_REGISTRY` (items, customers, suppliers, creditors, locations, price_list, promotions, bom_master, bom_master_lines, customer_items, assets); `_md_load_df/_md_template_bytes/_md_import/_table_meta`, `_export_all_master_excel`, "Import/Export ALL" tab | Only one-time `tools/etl`; no recurring admin import/export UI or REST | 🔴 High |
| 3 | **Stocktake / cycle-count workflow** | `ERPPOS_Invisible.py` warehouse Tab 2 (count via data_editor → variance → ST doc, Draft) | Variance *analytics* exist (`anomalies.service.ts:53`) but the count-entry workflow/UI is missing | 🔴 High |
| 4 | **Inventory QR: printable label sheets + scan-to-fill** | `_make_qr_png_b64`, `_make_qr_label_pdf` (Thai font, 4 sizes), `_parse_qr_payload`, `_qr_scan_box` on count/receive/transfer/issue | V2 QR is only restaurant tables/shipments; no inventory QR or printable Thai labels | 🔴 High |
| 5 | **Fixed-Asset QR tags + scan-to-update** | assets Tab 3/4: `_asset_label_items`, ASSET TAG PDF, scan→update + `tbl_asset_movements` | `assets.controller.ts` is accounting-only (acquire/depreciate/dispose); no QR, no movement audit | 🟠 Med |
| 6 | **Claims management (sales + GR/inbound)** | `nav_claim_mgt` (`ERPPOS_Invisible.py` ~4326–4483); GR claims sub-tab; `tbl_gr_claims` | No claims module/controller/table found in V2 | 🟠 Med |
| 7 | **Delivery Orders** | `nav_delivery` (~10827–10971): DO docs, status flow, POD image; `tbl_delivery_orders/_do_items` | No delivery module (WMS `shipments` ≠ DO workflow) | 🟠 Med |
| 8 | **Surveys & Feedback (portal UI)** | `nav_survey` (~13254): NPS/CSAT, fixed Q1–3 ไทย | Backend EXISTS (`surveys`/`survey_responses` tables, `POST /surveys/:id/responses`); **portal page missing** | 🟠 Med |
| 9 | **Lot/batch UI** (expiry buckets, FEFO/FIFO, query) | `nav_lots` 4 tabs (ledger/inquiry/expiry/FEFO) | `lot_ledger` written by WMS but no query endpoints/alerts/UI | 🟡 Low |
| 10 | **Mobile scan sessions** | `nav_mobile`: `tbl_scan_sessions/_scan_lines`, batch-then-commit | WMS putaway is immediate, not session-based | 🟡 Low |
| 11 | **Image Manager** | `nav_images`: upload/gallery, auto-rename to Item_ID | Page stub; "→ object storage" future work | 🟡 Low |
| 12 | **AP/AR aging REST + AP-aging Excel export** | KPIs + color-coded aging + export | Aging computed in web UI only; no `/finance/ar/aging` endpoint; AP-aging export is a stub | 🟡 Low |

---

## 2. Backend-ready, frontend missing (cheap wins)

V2 has API + DB but no portal page wired up:

| Feature | V2 backend | Missing |
|---|---|---|
| Customer BoM/recipe | `bom.controller.ts:77–93` (create/submit, production runs) | `/portal/bom` page |
| Customer variance (EOD) | `portal.controller.ts:114–115` + `portal.service.ts` createVariance | `/portal/variance` page |
| Survey submission | `marketing.controller.ts:94–101`, `surveys`/`survey_responses` schema | `/portal/survey` page |
| Dashboard auto-reorder | inventory reorder logic exists | side-effect not triggered on `/portal/dashboard` load |
| Campaign popups/ticker | `marketing_campaigns` + active-campaign endpoint | not rendered on portal dashboard |

---

## 3. Needs verification (agents disagreed)

- **User Management CRUD API.** The Admin-domain agent found no `POST/PUT/DELETE /api/admin/users`; the CRM agent implied `admin.controller` already does global user management. Confirm before treating as a gap.
- **Claims / Delivery web routes.** Flagged "missing" by module search, but `/claims` appears in the web route list. Confirm whether it's a real stub vs. an overlooked module.

---

## 4. V2 is ahead — do NOT port (V2-only)

Double-entry GL + trial balance / income statement / balance sheet; 3-way match payment gate; supplier scorecards & approval/blocklist; cost centers; FX revaluation; consolidation & intercompany elimination; revenue recognition (deferred); profitability segmentation; RLS multi-tenancy; API keys / webhooks / MFA(TOTP) / OIDC-SSO; self-serve signup + Stripe billing.

---

## 5. Suggested port order

1. **Module flags + master-data import/export + asset/inventory QR** — reference implementations were just written in ERPPOS (2026-06-22); port those three first (highest value, clearest spec).
2. **Stocktake workflow** — genuine inventory-control gap.
3. **Wire the three backend-ready portal pages** (BoM, variance, survey) — cheapest wins.
4. **Claims + Delivery Orders** — net-new modules; verify §3 first.

---

# Appendix — full per-domain tables (with evidence)

## A. SALES (POS / Orders / Claims / Returns / Delivery / Menu)

| Feature / Endpoint | ERPPOS (where) | V2 (where, status) | Verdict |
|---|---|---|---|
| POS create order (`nav_pos`) | `ERPPOS_Invisible.py:3141–3451` (manual+Excel, UOM conv, promo, credit, loyalty) | `modules/pos` + `(internal)/pos` | ⚠️ manual UI + Excel upload + UOM-conv UI thin |
| Excel order upload (Thai headers) | `:3230–3307` | — | ❌ no upload endpoint/handler |
| UOM conversion (large+small) | `:3279–3290` | not in `pos.service.ts` | ❌ no conversion_factor in POS path |
| POS discounts/promos applied | `:3343–3356` `_apply_promotions` | `marketing` promo rules not wired into `pos.service.ts` | ⚠️ promos exist but not applied at checkout |
| Credit-hold / credit-limit check | `:3358–3387` (AR balance, 80% warn) | `pos.service.ts:90–99` (tenant only) | ⚠️ credit gate not implemented in POS create |
| Loyalty earn at sale | `:3415–3439` | `pos.service.ts:100+` hook + `loyalty` | ⚠️ not wired end-to-end |
| Order management 6-state + export | `:4156–4325` (PDF/TXT/CSV) | `pos.controller.ts:52–59` status only | ⚠️ no export endpoints |
| Claim management (`nav_claim_mgt`) | `:4326–4483` | none found | ❌ no claims module/table |
| Track orders+claims (`nav_track`) | `:6875–7165` (composite status, mandatory claim image) | `(portal)/track` basic | ⚠️ claim flow thin |
| Delivery orders (`nav_delivery`) | `:10827–10971` (DO-, POD image) | none found | ❌ no delivery module |
| Sales returns (`nav_returns`) | `:10972–11084` (RTN-, types, return-to-stock) | `returns.controller.ts` | ⚠️ return-type selector/UI partial |
| Customer POS (`nav_cust_pos`) | `:5361–5722` | `(portal)/pos` + `restaurant` kiosk | ⚠️ tax-invoice PDF out of scope |
| Receipt/PDF | `:5526–5591` | `pos/receipt.service.ts` | ✅ |
| Split bill | pos_agent | `pos/split.service.ts` | ✅ |
| KDS / dine-in | (n/a) | `restaurant/kds.service.ts` | ➕ |
| REST `GET /api/pos/summary,/orders,/orders/{no},/sessions` | `api_server.py:232–320` | `pos.service.ts:27–86` | ✅ |
| REST writes (create order, status, returns) | not in api_server (Streamlit) | `pos.controller`, `returns.controller` | ➕ |
| AI tools (pos_tools.py) | `pos_tools.py` | `ai` module 19 tools (see §C of 01) | ⚠️ confirm void_order/RBAC gate |

**Top gaps:** Claims module · Delivery Orders · Excel order upload + UOM-conversion + credit/promo/loyalty wiring at POS checkout.

## B. INVENTORY / WAREHOUSE

| Feature / Endpoint | ERPPOS (where) | V2 (where, status) | Verdict |
|---|---|---|---|
| Goods issue/transfer | warehouse Tab 1 (`:7631–7724`) | `wms.controller.ts:24` putaway only | ⚠️ no manual issue/transfer endpoint |
| Stocktake / cycle count | warehouse Tab 2 (`:7737–7841`) | analytics variance only | ❌ no count workflow/UI |
| QR label sheets (items) | Tab 3 (`:7843–8007`), `_make_qr_label_pdf` | none (restaurant QR ≠ inventory) | ❌ |
| QR scan-to-fill (ops) | `:7652–7668, 7760–7769`, `_qr_scan_box` | putaway has no scan parse | ⚠️/❌ |
| Movement history/audit | Tab 4 (`:8008–8038`) | movements logged, no query/export endpoint | ⚠️ |
| Lot/batch UI | `nav_lots` (`:11197–11413`) | `lot_ledger` written, no query UI | ⚠️ |
| Multi-location + transfer | `nav_locations` (`:11419+`) | bins exist; no inter-location transfer | ⚠️ |
| Fixed Assets register | `nav_assets` (`:9849–10067`) | `assets.controller.ts:15–22` accounting | ⚠️ no QR/scan/movement |
| Asset QR tags | `:9990–10029` | none | ❌ |
| Asset scan & update | `:10032–10066` + `tbl_asset_movements` | none | ❌ |
| Mobile scan sessions | `nav_mobile` (`:11764–11962`) | none | ❌ |
| Image manager | `nav_images` (`:8966–9182`) | stub / object-storage future | ⚠️ |
| REST `/api/inventory/stock(/{id}),/suppliers,/purchase-orders` | `api_server.py:321–375,558–618` | `inventory.controller.ts:11–33` | ✅ |
| AI `adjust_stock` | `inventory_tools.py:188–245` | none | ❌ tool |

**Top gaps:** Stocktake/cycle-count workflow · QR label gen + mobile scan session · Lot ledger query/expiry/FEFO UI.

## C. PROCUREMENT & AP

| Feature / Endpoint | ERPPOS (where) | V2 (where, status) | Verdict |
|---|---|---|---|
| Purchase Requests | `:8644–8750` | `procurement.controller.ts:29–35` | ✅ |
| PR→PO conversion (blanket/splits) | `:8644–8750` | `procurement.service.ts:111–139` direct PO only | ⚠️ |
| Purchase Orders CRUD/approve/cancel | `:8046–8380`; `api_server.py:357–370` | `procurement.service.ts:111–166` | ✅ |
| Goods Receipt (auto-close, lot/expiry) | `:8382–8640` | `procurement.service.ts:168–200` | ✅ |
| GR claims (inbound) | `:8525–8640`, `tbl_gr_claims` | none | ❌ |
| Supplier master | `:8076+` | `vendors` + masterdata | ✅ |
| Supplier approval/blocklist | (none) | `procurement.service.ts:72–108` | ➕ |
| Supplier scorecard | (none) | `procurement.service.ts:98–108` | ➕ |
| Creditors master | `:12004–12150` | `vendors` consolidated | ⚠️ confirm masterdata CRUD |
| AP transactions + pay | `:12156–12283` | `finance.controller.ts:39–43`, `finance.service.ts:150–201` | ✅ (+3-way gate) |
| AP aging buckets (UI) | `:11990+` | `finance.service.ts:54–62` no buckets | ⚠️ |
| 3-way match (PO↔GR↔Invoice) | (none) | `match/three-way-match.service.ts` | ➕ |
| GR QR labels / PO PDF export | `:8484–8500`, `:8154–8248` | none / verify shared exporter | ⚠️/❌ cosmetic |

**Top gaps:** GR claims · AP aging buckets · PO PDF export. **V2 ahead here** (3-way match, scorecards, blocklist, workflow, RLS).

## D. FINANCE & ANALYTICS

| Feature / Endpoint | ERPPOS (where) | V2 (where, status) | Verdict |
|---|---|---|---|
| AR invoices/receipts | `nav_ar` (`:10495–10825`) | `finance.service.ts:65–147` | ✅ (+GL) |
| AR/AP aging as REST | KPI + buckets | UI-only, no endpoint | ⚠️ |
| Price list (multi-tier) | `nav_pricelist` (`:10767+`), `tbl_price_list` | `marketing.controller` `listPriceList/createPriceList`, `POST /api/price-list` | ✅ (corrected; one agent missed it) |
| Sales dashboard | `nav_dashboard` | `dashboard.controller.ts` | ✅ |
| Executive dashboard | `nav_exec` | `(internal)/executive` + reports | ✅ |
| Planner/replenishment | `nav_planner` | `forecasting.service.ts:62–99` | ✅ |
| Anomalies / stocktake variance | `analytics/anomalies.py` | `anomalies.service.ts:13–69` (Z 2.5/3.5, var 20/50%) | ✅ |
| Forecasting / stockout | `analytics/forecasting.py` | `forecasting.service.ts:62–83` (LB60, safety1.5) | ✅ |
| LLM insights | `analytics/llm_insights.py` | `insights.service.ts` | ✅ |
| P&L / KPI / cash position | `finance_tools.py` | `finance.service.ts:37–84` | ✅ |
| Reports (daily/monthly/stock) | `report_tools.py` | `reports-excel.service.ts` (+Playwright PDF) | ✅ |
| AP-aging report export | `report_tools.py` (stub) | not implemented | ❌ (stub→stub) |
| GL / trial balance / statements / FX / cost centers / rev-rec / profitability / consolidation | (none) | `ledger`,`fx`,`revenue`,`profitability`,`consolidation` | ➕ |

**Top gaps:** AR/AP aging REST endpoints · AP-aging Excel export. **V2 far ahead on GL/finance depth.**

## E. CRM / PORTAL / MARKETING

| Feature / Endpoint | ERPPOS (where) | V2 (where, status) | Verdict |
|---|---|---|---|
| Portal dashboard | `nav_cust_dash` (`:4484`) | `portal/dashboard` | ⚠️ no popups/ticker/auto-reorder |
| Portal POS | `nav_cust_pos` (`:5361`) | `portal/pos` | ✅ |
| Portal inventory & reorder | `nav_cust_inventory` (`:6528`) | `portal.service.ts` | ✅ |
| Portal BoM/recipe | `nav_cust_bom` (`:5727`) | `bom.controller.ts:77–93` API only | ❌ portal UI |
| Portal variance (EOD) | `nav_cust_variance` (`:6338`) | `portal.controller.ts:114–115` API only | ❌ portal UI |
| Order tracking | `nav_track` | `portal/track` | ✅ |
| Loyalty (portal) | `nav_loyalty` (`:13182`) | `loyalty.service.ts` me/redeem | ✅ |
| Survey & feedback | `nav_survey` (`:13254`) | `marketing.controller.ts:94–101` API + schema | ❌ portal UI |
| Mini-ERP CRM/suppliers/POs | `nav_cust_my_*` (`:13293+`) | `portal.myerp.service.ts` | ✅ |
| Mini-ERP sub-accounts | `nav_cust_my_users` (`:13440`) | none customer-scoped | ❌ |
| Marketing campaigns/AB/segments/abandoned/promotions/loyalty-config | `nav_marketing` (`:12693+`) | `marketing.controller.ts` | ✅ |
| CRM master (admin) | `nav_crm` | `crm.controller.ts` profile | ✅ |

**Top gaps:** portal pages for BoM, variance, survey · mini-ERP sub-accounts · dashboard popups/ticker/auto-reorder wiring.

## F. ADMIN / PLATFORM / API SURFACE

**REST cross-reference:** all 30 legacy `api_server.py` endpoints → ✅ parity (JWT replaces HMAC); `POST /api/chat` ⚠️ upgraded (now reaches live data via service layer). New write endpoints are V2-only ➕.

| Feature | ERPPOS (where) | V2 (where, status) | Verdict |
|---|---|---|---|
| User management CRUD | `nav_users` (`:12449–12650`) | conflicting evidence — see §3 | ⚠️ verify |
| RBAC role defaults / per-user override | tabs role/perm | `packages/shared/permissions.ts` (~38 keys), `role_permissions`/`user_permissions` tables; admin **endpoints/UI** thin | ⚠️ |
| Module enable/disable | `tbl_module_config`, `_module_enabled`, "Modules On/Off" tab | none | ❌ |
| Master-data import/export (in-app, 11 entities) | `MASTER_REGISTRY`, `_md_import`, `_export_all_master_excel`, "Import/Export ALL" tab | ETL-only (`tools/etl`) | ❌ |
| AI chat UI + 19 tools | `nav_ai_chat`, `agents/*` | `(internal)/assistant`, `agent.service.ts:24–46` | ✅ |
| API keys / webhooks / MFA / OIDC / billing | (none) | `platform`, `billing` | ➕ |

**Top gaps:** Module enable/disable · Master-data import/export · Role/permission admin endpoints+UI (model exists).
