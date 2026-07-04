# 33 — Item Posting Setup: Account/Category/Warehouse/VAT/WHT Linking & Tax Automation — Design & Roadmap

> **Date:** 2026-07-04 · **Status:** v1.0 — PLANNED (PR1 in progress) · **Owner:** ERP / Finance
> **Scope:** Give item posting an explicit, configurable **account-determination** spine so a transaction's
> GL/VAT/WHT accounts are *derived from the item* (via item → category → warehouse → global default) instead
> of hardcoded literals; add a **setup menu** to maintain that mapping; and schedule the existing tax/WHT
> outputs (PP30, PND, 50-ทวิ certificates) as **automated period jobs**.
> **Decision recorded:** Same delivery discipline as `docs/19`–`23` — each phase is an independently-shippable,
> doc-synced PR (migration *if any* + module + permissions/SoD + RCM control + narrative + user-manual + UAT +
> cutover-harness), merged only on a green CI matrix. Global defaults are seeded to **exactly** today's
> hardcoded literals so there is **no behavior change** until a tenant opts in.

---

## 0. Read this first — build on, don't duplicate

The engine mostly **already exists**. This plan wires it together and adds a thin config + UI layer. Do not
rebuild any of the following:

- **Account-determination engine** — `apps/api/src/modules/ledger/posting.service.ts` (`resolveRules`,
  `preview`, `post`, `upsertRule`) over `posting_rules` + `posting_event_types`
  (`apps/api/src/database/schema/posting-rules.ts`), seeded by `apps/api/drizzle/0158_posting_rules.sql`
  (~27 event types incl. `GR.INVENTORY`, `COSTING.RECEIPT/ISSUE/PPV`, `RETURN.STOCK`). Tenant-overridable via
  `POST /api/ledger/posting-rules`. **Gaps:** `PostingService.post()` is never called by the real posting
  paths; the `condition` jsonb is stored but **never evaluated**; keys are only `eventType`+`tenant`.
- **Two valued-inventory GL engines** — `modules/inventory/inventory-ledger.service.ts` and
  `modules/costing/costing.service.ts` post with **hardcoded** account literals (`1200/2000/5000/5500/5810`),
  bypassing the engine.
- **Thai VAT** — `modules/tax/` (`tax.service.ts`, `tax-providers.ts`): 7% VAT, multi-country, inclusive
  back-out. VAT posts to a single account **2100**.
- **Vendor WHT at AP payment** — `modules/finance/finance.service.ts` `approveApPayment` (Dr 2000 / Cr **2361**
  WHT-held / Cr 1000 net), income types incl. labour/service `40(7-8)` ค่าจ้างทำของ, `3tre-service`
  (`tax/documents/wht-rates.ts`).
- **Payroll WHT** — `modules/payroll/payroll.service.ts` `runPayroll` → PND1, GL **2360**.
- **WHT 50-ทวิ certificate + PDF** — `tax/documents/wht.service.ts`, `tax-docs-pdf.service.ts`.
- **Tax reports** — `tax/reports/tax-reports.service.ts`: `outputVat`, `inputVat`, `pp30` (ภ.พ.30), `pnd`
  (ภ.ง.ด.3/53), `pndTieOut` (**TAX-03**), filing register + remittance calendar (**TAX-05**);
  `payroll.service.ts` `pnd1`/`pnd1a`.
- **Master-data import** — `modules/masterdata/master-registry.ts` (items, locations, …).
- **BI scheduler action jobs** — `modules/bi/bi.service.ts` `REPORT_TYPES` + `generateReport()`. **No tax jobs
  exist today.**

## 1. The four gaps this plan closes

1. **Items carry no accounting DNA.** `items` (`inventory.ts:6`) has no revenue/COGS/inventory/valuation
   account, no VAT flag, no WHT flag; `category` is free text with no master table.
2. **The determination engine isn't wired or keyed.** `post()` never runs on real paths, `condition` is never
   evaluated, and there is no keying by item / category / warehouse / tax code.
3. **No auto-issue of the 50-ทวิ certificate from an AP payment** — `pndTieOut` (TAX-03) explicitly reports
   "un-certificated WHT"; issuance is a separate manual step.
4. **No scheduled tax automation** — PP30/PND/certificate runs are all manual/on-demand.

## 2. Data model (PR1)

New tenant-scoped master tables (RLS, `0232` org-clause form) + global default columns on `items`:

- **`item_categories`** (tenant-scoped): `code` (natural key per tenant), `name`/`name_th`,
  `revenue_account`, `cogs_account`, `inventory_account`, `valuation_account`, `vat_code`,
  `wht_income_type`, `default_location_id`, `active`. A category is the primary place a tenant maps a family
  of items to accounts + tax profile.
- **`tax_codes`** (tenant-scoped): `code` (e.g. `VAT7`, `VAT0`, `EXEMPT`, `WHT3`), `kind` (`vat`|`wht`),
  `rate`, `output_account`/`input_account` (VAT), `wht_account` + `wht_income_type` (WHT), `inclusive`,
  `active`. Replaces the lone `tenants.vatRate` column as the configurable tax surface; day-one seed mirrors
  the current 7%→2100 behavior.
- **`items` global-default columns** (accounts are a global canonical universe, so a default account is
  tenant-neutral): `category_id` (FK → `item_categories`), `revenue_account`, `cogs_account`,
  `inventory_account`, `valuation_account`, `vat_code`, `wht_income_type`, `default_location_id`.

**Resolution precedence (implemented in PR2):** item override → item's category → warehouse default →
global `posting_rules` default. Anything null falls through; a fully-unconfigured tenant behaves exactly as
today.

## 3. Phasing

- **PR1 — Config foundation (this PR).** `item_categories` + `tax_codes` tables + `items` posting-profile
  columns; migration `0243` (journaled, RLS org-clause form); register `item_categories`/`tax_codes` in
  `master-registry.ts` for bulk import; extend the `items` import columns. **No posting behavior change.**
  Docs: this plan + master-data user-manual note + `basics` harness sanity check that the tables exist and
  import round-trips.
- **PR2 — Wire the engine.** `PostingService.resolveRules()` evaluates `condition` and adds item/category/
  warehouse/tax-code keys; inventory + costing + sales posting paths call `PostingService.post()` behind a
  per-tenant `posting_determination` flag (defaults off → literals preserved). New detective control
  **GL-20 "Item account determination"** (sub-ledger ↔ resolved-rule reconciliation) → RCM regen
  (`build_rcm.py`), `tools/cutover/src/compliance.ts`, PN GL narrative. Extend `basics`.
- **PR3 — Setup screens.** Web: `/setup/items` (item posting setup), `/setup/item-categories`,
  `/setup/tax-codes`, `/setup/warehouses` (location account defaults), `/setup/posting-rules` (account
  determination editor over the existing engine + Preview). Nav under `nav.group.settings` →
  `nav.sub.master_data` (perm `md_item`) and `nav.sub.ledger` (perm `gl_posting_rules`). SoD: kept clear of
  transactional perms (rule R13). User-manual module guides + UAT (positive + negative/control).
- **PR4 — WHT auto-cert + tax automation.** Auto-issue the 50-ทวิ from an approved AP payment that withheld
  tax (closes the TAX-03 gap; maker-checker preserved). New idempotent BI action jobs:
  `tax_wht_cert_batch`, `tax_pp30_draft`, `tax_pnd_draft`, `tax_remittance_reminder` (deadline 7th/15th via
  the `BiLive` SSE/alert bus). `/tax/automation` schedule screen. TAX-03 tie-out extension + narratives + UAT.

## 4. Permissions / SoD

New setup screens gate behind `md_item` / `md_config` (master-data config) and `gl_posting_rules`
(account determination) — never transactional perms. SoD **R13** (`packages/shared/src/permissions.ts`)
flags `md_item`/`md_config`/`bom_master` held together with `pos_sell`/`procurement`/`creditors`/`ar`, so the
setup duties stay segregated from transacting.

## 5. Doc-sync obligations (per CLAUDE.md)

Each PR updates, proportionately: the affected process narrative + Mermaid workflow + control matrix (new
control **GL-20**; TAX-03 extension) and `compliance/` (RCM regen — currently 169 controls — readiness plan,
`tools/cutover/src/compliance.ts`); the user manual (item-setup / tax-code / posting-rules module guides +
new error codes); UAT (positive + control cases + traceability matrix); and the `basics` cutover harness
(primary AR/AP/GL gate) for the determination path.

## Revision history

| Date | Rev | Change | Author |
|---|---|---|---|
| 2026-07-04 | 1.0 | Initial plan; PR1 (config foundation) in progress. | ERP/Finance |
