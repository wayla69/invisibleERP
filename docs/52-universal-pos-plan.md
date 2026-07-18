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
- **Phase 3 — Regulated-goods capture.** **Serial/IMEI** and **lot/expiry** on the sale line (electronics,
  pharmacy, grocery); **age-restricted** prompt.
- **Phase 4 — Pricing depth.** Customer-tier & per-branch **price books**; per-line manual-discount approval.
- **Phase 5 — Services vertical.** Appointment/booking, staff assignment + **commission**, time-based
  services, **packages / session passes**.
- **Phase 6 — Retail payments & inventory depth.** Layaway / back-order / special-order, installments/BNPL,
  multi-tender split at the register, cross-branch stock lookup & transfer request from POS.

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
| 0.3 | 2026-07-18 | Platform | **Phase 1b delivered — generic sale-path cutover.** `POST /api/pos/sales` (`PosSaleService`, `pos_sell`) rings a non-restaurant sale through the reused `PortalPosService.createSale` engine — extended with optional `tenant` (internal caller passes the resolved tenant, since its `customerName` ≠ the tenant code) + `revenueEvent` (default `SALE.FOOD`, byte-identical GL). The register's `settle` branches on `sale_path` (generic → `/api/pos/sales`, no `dine_in_orders`; restaurant → unchanged). `PortalModule` exports `PortalPosService`; `PosModule` imports it (no cycle). Harness `pos-profile` 8→13 (generic sale: no dine_in_orders, revenue→4000 via SALE.GOODS, VAT→2100, stock decrement, non-seller 403). golden 534 / writeflow 36 unchanged (defaults preserve the existing money path). No migration, no new control. |
| 0.2 | 2026-07-18 | Platform | **Phase 1a delivered — business-type POS profile + de-restaurant the register.** New `PosProfileService` + `GET /api/pos/profile` derives `{tables,kds,courses,buffet,recipe_deduction,revenue_event,sale_path}` from `tenants.industry` (unset → restaurant, non-breaking). Neutral revenue events `SALE.GOODS`/`SALE.SERVICE` added to `SALES_POSTING_EVENTS` (both default `4000` → no GL drift). The internal register reads the profile and hides table/dine-in affordances for a non-restaurant tenant. No money-path change (golden/writeflow untouched). Harness `pos-profile` (8 checks). Phase 1 split into 1a (this) + 1b (generic sale-path cutover, next). |
| 0.1 | 2026-07-18 | Platform | Initial plan. Gap analysis across ten dimensions; business-type feature profile as the linchpin; six-phase roadmap; Phase 0 (#1/#2/#3) delivered. |
