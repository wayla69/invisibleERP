# docs/52 — Universal POS Plan: one Point-of-Sale for every business

**Status: DRAFT v0.1 · 2026-07-18** · Owner: Platform · Related: docs/45 (ERP-POS strategy), docs/50
(material/R2R/POS depth), PN-07 (cash & treasury), PN-20 (restaurant operations), PN-01 (order-to-cash).

## 1. Goal

Turn the POS from a *restaurant* engine that other businesses borrow into a **true universal Point-of-Sale**
— one register that a café, retail shop, grocery/convenience store, pharmacy, fashion/apparel outlet,
electronics store, salon/spa, clinic, or professional-services firm can run natively, without the food /
table / kitchen scaffolding getting in the way — while keeping the SOX/ICFR control posture intact.

## 2. Where we are today (the honest baseline)

The money spine is already generic and reusable: `cust_pos_sales` / `cust_pos_items` (every sale path writes
here), `payments` (tenders, refunds, till/drawer, X/Z), gift cards, returns with store credit, house
accounts, customer deposits, FX, the pricing rule engine, and the full peripheral stack (printer, cash
drawer, customer display, scale, barcode). Fiscal compliance (abbreviated + full tax invoice, e-Tax,
hash-chained journal) is done.

**The constraint:** everything *upstream* of the sale record assumes a restaurant.
1. **Every till sale routes through the restaurant engine.** Even a walk-up cash sale rings via
   `POST /api/restaurant/orders` → `…/checkout` → `DineInSaleService.buildSale` — the one place POS revenue
   GL is posted. It reads `dine_in_order_items`, hard-codes `uom:'จาน'` ("plate"), stamps
   `paymentMethod:'Dine-in'`, posts to the `SALE.FOOD` revenue event, and runs recipe/BOM deduction per line.
2. **Two disconnected catalogs.** The register sells from `menu_items` (food-centric: stations, prep time,
   86-ing, `type ∈ food|drink|retail|combo`); the stocked/costed master is `items` (SKU, barcode, UoM, lot).
   The `/shop` page is a *procurement requisition* builder, not a retail POS.

## 3. Gap analysis (ten dimensions)

| # | Dimension | Today | A universal POS still needs |
|---|---|---|---|
| 1 | Product / catalog | food/menu-centric; retail is one enum value | **variants / matrix (size×color)**, **serial/IMEI**, **lot/expiry on the sale line**, first-class service & non-inventory items, general kits/bundles |
| 2 | Checkout flexibility | must create an order/table; weight items ✅; discount cap ✅ | **a plain retail sale path** (no table/KDS/recipe), **age-restricted prompt**, open-price/misc item, line price override w/ approval |
| 3 | Pricing | rule engine ✅ (qty breaks, BOGO, time/channel) | **price lists / customer-tier & per-branch price books**, per-line manual-discount approval routing |
| 4 | Services businesses | deposits ✅; tips pooled | **appointment/booking**, **staff assignment + commission on the line**, time-based services, **packages / session passes / punch-cards** |
| 5 | Inventory ops at POS | branch tag ✅; transfers (back office) | cross-branch stock lookup at the register, **layaway / back-order / special-order**, transfer *request* from POS, negative-stock policy, serial capture |
| 6 | Customer / CRM at POS | loyalty ✅; house accounts ✅; store credit ✅ | **quick customer create at the till**, customer-specific pricing, purchase-history lookup |
| 7 | Payments | strong (PSP, PromptPay, split, FX) | **installments/BNPL**, layaway schedule, multi-tender split at the register, foreign-currency change |
| 8 | Peripherals | **best-covered** (printer/drawer/display/scale/scanner) | confirm barcode scan-to-add on the *retail* register (not just `/shop`) |
| 9 | Restaurant-only surfaces | KDS, tables, courses, buffet, channel adapters all on the mandatory path | **gate them behind a business-type profile**; add a non-restaurant posting path |
| 10 | Business-type config | `tenants.industry` selects a CoA template + onboarding only | **a business-type → POS-feature profile that actually drives the register/checkout** — the linchpin |

## 4. The linchpin: a business-type feature profile

`tenants.industry` already exists (`restaurant|retail|distribution|services|general`) but only picks a
chart-of-accounts template. The first structural piece of work is a **POS feature profile** derived from the
business type (with per-tenant overrides) that the register and checkout **read** to decide:

- which surfaces to show (tables/KDS/courses/buffet **off** for retail/services),
- which **revenue posting event** to use (`SALE.FOOD` → a generic `SALE.GOODS` / `SALE.SERVICE`),
- whether to run **recipe/BOM deduction** (off for general retail; replaced by direct item stock move),
- which sale attributes are required (table vs none; staff/stylist for services; serial/lot for regulated
  goods).

This is what makes the other nine dimensions deliverable **without forking the UI**.

## 5. Phased roadmap (each phase is doc-synced, harness-gated, incremental)

- **Phase 0 — First increment (this change, delivered):** the universal cashier essentials that every
  business needs immediately — **#1 cash tendering / change-due**, **#2 credit note (ใบลดหนี้) auto-issued on
  a return**, **#3 pending-settlement reconciliation worklist**. See §6.
- **Phase 1 — Business-type feature profile + generic checkout path.** *Highest leverage — unblocks every
  non-restaurant tenant.* Split into two shippable slices:
  - **Phase 1a — profile + de-restaurant the register (DELIVERED).** `GET /api/pos/profile`
    (`PosProfileService`) derives the register/checkout feature set from `tenants.industry`
    (restaurant → tables/KDS/courses + `SALE.FOOD`; retail/distribution/general → generic register +
    `SALE.GOODS`; services → `SALE.SERVICE`; unset → restaurant, non-breaking). The internal register reads
    it and hides the table/dine-in affordances (attach-table, floor link, order-type/pax/service-charge) for
    a non-restaurant tenant. New neutral revenue events `SALE.GOODS`/`SALE.SERVICE` (both default `4000` — no
    GL drift — remappable via a GL-24 override). **No money-path change** (the sale still rings through the
    existing engine), so golden/writeflow are untouched. Harness `pos-profile`.
  - **Phase 1b — generic sale-path cutover (DELIVERED).** The non-restaurant register now rings through a
    generic checkout that creates **no** `dine_in_orders` / KDS ticket and posts revenue under
    `profile.revenue_event`. `POST /api/pos/sales` (`PosSaleService`, `pos_sell`) reuses the already-generic
    `PortalPosService.createSale` engine — extended with an optional `tenant` (an internal caller's
    `customerName` is not the tenant code, so it passes the resolved tenant explicitly) and `revenueEvent`
    (default `SALE.FOOD` → **byte-identical GL**; verified by golden 534 / writeflow 36). The register's
    `settle` branches on `sale_path`: generic → `/api/pos/sales`; restaurant → the unchanged dine-in
    checkout. Harness `pos-profile` (13 — the generic sale creates no `dine_in_orders`, posts `SALE.GOODS`→
    4000, decrements stock, and a non-seller is 403). **Still open (Phase 1c / later):** per-tenant
    feature-flag overrides on the industry defaults, and voucher/gift-card at the generic till.
- **Phase 2 — Sellable-item model uplift.** Unify the sellable catalog with the `items` master; add
  **variants / matrix items**, first-class **service** & **non-inventory** items, general **kits/bundles**.
  Split into slices:
  - **Phase 2a — sale-line resolve + service items (DELIVERED).** The POS sale now resolves each `item_id`
    against the shared `items` master (the "catalog behind the sale line" that was missing — `item_id` was
    free-text and unvalidated). A `supplyType='service'` line sells with **no stock move and no COGS**, and
    its revenue posts to `SALE.SERVICE` (a mixed cart splits revenue by line — goods to the caller's event,
    service to `SALE.SERVICE`). An unknown `item_id` (no master row) defaults to **goods** → byte-identical
    to before (golden/writeflow unchanged). `supplyType` is now editable in item-setup; migration `0439`
    registers `SALE.GOODS`/`SALE.SERVICE` in `posting_event_types` so a services tenant can remap
    `SALE.SERVICE` to its own service-income account via GL-24 (closing a Phase 1 gap). Harness `item-service`.
  - **Phase 2b — variants / matrix items (DELIVERED).** Each variant is a real `items` row (own SKU /
    barcode / price / stock) linked by **`items.parent_item_id`** with **`item_variant_attributes`** (axis,
    value); the parent is flagged **`is_matrix_parent`**. `POST /api/item-setup/items/:id/variants` generates
    the size×color matrix from axes (cartesian product → child SKUs `PARENT-S-RED`, inherited price, optional
    per-cell barcode; idempotent — re-running only adds new cells); `GET …/variants` lists them. A variant
    **barcode scans to the exact SKU** for free (variants are `items` rows → `/api/procurement/catalog?barcode=`).
    A **Variants panel** on `/setup/items`. Migration `0440`; harness `item-variants`; catalog-only → golden
    unchanged.
  - **Phase 2c — kits/bundles + non-inventory items (DELIVERED).** A **kit/bundle** parent item sells as ONE
    sale line at ONE price, but on sale its **component** stock (and costed COGS) is consumed — the kit SKU
    itself is never decremented or costed. Components are tenant-scoped **`item_relationships`**
    (`rel_type='kit_component'`, from=kit → to=component) carrying a per-kit **`qty`** (migration `0441`).
    `createSale` explodes each kit line into its components (component stock/`cust_stock_log`/branch-stock +
    `costing.onIssue` COGS × the line qty); a goods line with no kit rows is **byte-identical** to before.
    Revenue posts the kit's own line price to the goods event (not the component-price sum). A **non-inventory**
    item (`supply_type='non_inventory'` — delivery fee, gift-wrap) sells with **no stock move / no COGS** but
    posts to the **goods** revenue event (unlike a `service` item → `SALE.SERVICE`). A **Kit components** panel
    on `/setup/items` edits the BOM (component + qty) via `POST/GET/DELETE …/items/:id/relationships`. Harness
    `item-kit` (9); catalog/BOM-only → golden 534 / writeflow 36 / restaurant / returns / item-service /
    item-variants unchanged.
- **Phase 3 — Regulated-goods capture.** **Serial/IMEI** and **lot/expiry** on the sale line (electronics,
  pharmacy, grocery); **age-restricted** prompt.
- **Phase 4 — Pricing depth.** Customer-tier & per-branch **price books**; per-line manual-discount approval.
- **Phase 5 — Services vertical.** Appointment/booking, staff assignment + **commission**, time-based
  services, **packages / session passes**.
- **Phase 6 — Retail payments & inventory depth.** Layaway / back-order / special-order, installments/BNPL,
  multi-tender split at the register, cross-branch stock lookup & transfer request from POS.
  - **Phase 6a — multi-tender split payment (DELIVERED).** One sale can be settled by several tenders
    (cash + card + QR + voucher …). An optional **`tenders[]`** on `createSale` records **one `PAY` tender per
    leg** (all linked to the sale + open till → each shows in the pending-settlement worklist + drawer count);
    the legs must sum EXACTLY to the total (`TENDER_MISMATCH`), a cash leg may over-tender for change
    (`change_due`), a non-cash leg may not (`NONCASH_OVERTENDER`). The GL asset debit splits across per-method
    **`TENDER.CASH/CARD/QR/VOUCHER/OTHER`** posting events, **all defaulting to `1000`** so an all-default
    split is net-GL-identical to the legacy single `Dr 1000 = total` (GL-24-remappable — a shop banks card/QR
    into a clearing account without a code change). **Absent `tenders[]` ⇒ the single-tender path, byte-identical**
    (golden 534 / writeflow 36 unchanged). A toggle-gated **split panel** on the register checkout. Migration
    `0442` seeds the tender event types; harness `pos-split` (8). No new control (strengthens REV-05 / POS-08).

## 6. Phase 0 — what shipped in this change

| Item | What | Control | Migration | Harness |
|---|---|---|---|---|
| **#1** Cash tendering / change-due | `cash_tendered` → `change_due`; short-cash refused; both persisted for the drawer count | strengthens REV-05 (no new) | `0438` | `payments-gateway` |
| **#2** Credit note on return | a return with an Issued tax invoice auto-issues a ใบลดหนี้ (ม.86/10) that reduces output-VAT, **no** double GL | strengthens TAX-07 (no new) | — | `returns` |
| **#3** Pending-settlement worklist | `GET /api/payments/pending-settlement` surfaces unconfirmed QR/auth/transfer tenders so none sit in limbo | strengthens POS-08 (no new) | — | `promptpay` |

These are business-type-agnostic — they serve a restaurant and a retail shop identically — so they were the
right first step while the profile-driven work (Phases 1+) is scoped.

## 7. Guardrails (unchanged by this plan)

Every phase keeps the Architecture Gatekeeper rules: bounded contexts (a new capability is its own
sub-service/provider, never appended to a facade — the `check-service-size` ratchet enforces it), GL reads
via `LedgerReadService` only (`check-import-boundaries`), atomic multi-table mutations, mandatory tenant
filtering, and docs synced in the same change (narratives, user manual, UAT, RCM).

## 8. Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 0.7 | 2026-07-19 | Platform | **Phase 6a delivered — multi-tender split payment.** An optional `tenders[]` on `createSale` settles one sale across several tenders (cash + card + QR + voucher …): each leg is recorded as its own `PAY` tender linked to the sale + open till (pending-settlement worklist + drawer count), the legs must sum EXACTLY to the total (`TENDER_MISMATCH`), a cash leg may over-tender for change (`change_due`) but a non-cash leg may not (`NONCASH_OVERTENDER`). The GL asset debit splits across per-method `TENDER.CASH/CARD/QR/VOUCHER/OTHER` posting events — all default `1000`, so an all-default split is net-GL-identical to the legacy single `Dr 1000 = total`; a tenant remaps card/QR to a clearing account via GL-24. Migration `0442` seeds the tender event types. Absent `tenders[]` ⇒ single-tender path, byte-identical (golden 534 / writeflow 36 / basics 458 / restaurant 220 / returns 25 / payments-gateway 11 unchanged). Toggle-gated split panel on the register checkout (single-method flow unchanged). Harness `pos-split` (8: single-tender byte-identical; 3-way split → 3 PAY + net Dr 1000; short → TENDER_MISMATCH; cash over-tender → change_due; non-cash over-tender → NONCASH_OVERTENDER; GL-24 remap TENDER.CARD→1010; non-seller 403). No new control (strengthens REV-05 / POS-08; census 298). |
| 0.6 | 2026-07-19 | Platform | **Phase 2c delivered — kits/bundles + non-inventory items.** Migration `0441` adds `item_relationships.qty` (per-component count for a `kit_component` row; existing rows default 1). `createSale` builds a kit map (tenant-scoped `kit_component` rows, from=kit → to=component) and **explodes** each kit line into its components — component `customer_inventory`/`cust_stock_log`/`branch_stock` decrement + `costing.onIssue` COGS × the line qty — while the kit SKU itself is never decremented/costed; revenue posts the kit's own line price to the goods event (not the component-price sum). A `supply_type='non_inventory'` item skips stock/COGS like `service` but keeps the **goods** revenue event. The per-qty stock block was extracted (`processStockQty`) so a plain goods line stays **byte-identical**. A **Kit components** panel on `/setup/items` edits the BOM (`ItemRelBody.qty`; `POST/GET/DELETE …/relationships`). Catalog/BOM-only — golden 534 / writeflow 36 / restaurant 220 / returns 25 / item-service / item-variants unchanged. Harness `item-kit` (9: kit ×1 consumes components not the kit SKU; component-only stock-logs; revenue = kit price → 4000; component COGS 50; kit ×2 multiplies the BOM; non-kit line byte-identical; non_inventory no-stock/no-COGS → 4000; API add+list qty; non-seller 403). No new control (census 298). |
| 0.5 | 2026-07-18 | Platform | **Phase 2b delivered — product variants / matrix items.** Migration `0440` adds `items.parent_item_id` (self-ref) + `is_matrix_parent` + the shared `item_variant_attributes(item_id, axis, value)` table (no tenant_id, like `items`). `POST /api/item-setup/items/:id/variants` generates the matrix from axes (cartesian product → child `items` rows `${parentSku}-${vals}`, inherited price, optional per-SKU barcode, attribute rows; idempotent) + `GET …/variants`. A variant **barcode resolves via `/api/procurement/catalog?barcode=`** (variants are `items` rows). Minimal **Variants panel** on `/setup/items`. Catalog-only — golden 534 / writeflow 36 / basics / item-service unchanged. Harness `item-variants` (7: 2×2 matrix → 4 linked child SKUs + attributes + inherited price; GET lists; idempotent +colour adds only new cells; barcode scans to the exact variant; non-setup 403; empty-axes 400). No new control (census 298). |
| 0.4 | 2026-07-18 | Platform | **Phase 2a delivered — sale-line resolve + service items.** `createSale` now resolves each `item_id` against the shared `items` master to read `supplyType`; a `service` line skips the inventory/`cust_stock_log`/recipe/`costing.onIssue` COGS moves and its revenue posts to `SALE.SERVICE` (mixed carts split revenue by line; the two revenue legs sum exactly to the taxable base). An `item_id` with no master row defaults to goods → byte-identical (golden 534 / writeflow 36 / returns / basics unchanged). `supplyType` editable in item-setup (`ItemProfileDto`). Migration `0439` seeds `SALE.GOODS`/`SALE.SERVICE` into `posting_event_types` so they are GL-24-overridable (a services tenant can remap `SALE.SERVICE` to its service-income account). Harness `item-service` (7): service sale = no stock/COGS + revenue to the remapped account; goods sale unchanged; mixed cart splits; unknown item_id → goods; non-seller 403. No new control (census 298). |
| 0.3 | 2026-07-18 | Platform | **Phase 1b delivered — generic sale-path cutover.** `POST /api/pos/sales` (`PosSaleService`, `pos_sell`) rings a non-restaurant sale through the reused `PortalPosService.createSale` engine — extended with optional `tenant` (internal caller passes the resolved tenant, since its `customerName` ≠ the tenant code) + `revenueEvent` (default `SALE.FOOD`, byte-identical GL). The register's `settle` branches on `sale_path` (generic → `/api/pos/sales`, no `dine_in_orders`; restaurant → unchanged). `PortalModule` exports `PortalPosService`; `PosModule` imports it (no cycle). Harness `pos-profile` 8→13 (generic sale: no dine_in_orders, revenue→4000 via SALE.GOODS, VAT→2100, stock decrement, non-seller 403). golden 534 / writeflow 36 unchanged (defaults preserve the existing money path). No migration, no new control. |
| 0.2 | 2026-07-18 | Platform | **Phase 1a delivered — business-type POS profile + de-restaurant the register.** New `PosProfileService` + `GET /api/pos/profile` derives `{tables,kds,courses,buffet,recipe_deduction,revenue_event,sale_path}` from `tenants.industry` (unset → restaurant, non-breaking). Neutral revenue events `SALE.GOODS`/`SALE.SERVICE` added to `SALES_POSTING_EVENTS` (both default `4000` → no GL drift). The internal register reads the profile and hides table/dine-in affordances for a non-restaurant tenant. No money-path change (golden/writeflow untouched). Harness `pos-profile` (8 checks). Phase 1 split into 1a (this) + 1b (generic sale-path cutover, next). |
| 0.1 | 2026-07-18 | Platform | Initial plan. Gap analysis across ten dimensions; business-type feature profile as the linchpin; six-phase roadmap; Phase 0 (#1/#2/#3) delivered. |
