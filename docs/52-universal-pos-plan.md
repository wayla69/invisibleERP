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
  - **Phase 3a — lot/expiry on the sale line (DELIVERED).** An item flagged **`items.is_lot_tracked`** sells
    only from a **real, non-expired, non-held lot**. `createSale` resolves each lot-tracked line **FEFO**
    (earliest expiry first, via the existing `lot_ledger`; an explicit `lot_no` overrides), **fails closed** on
    a bad lot (`LOT_EXPIRED` / `LOT_ON_HOLD` / `NO_LOT_AVAILABLE` / `LOT_INSUFFICIENT` / `LOT_NOT_FOUND`),
    **stamps the consumed lot + expiry** on the `cust_pos_items` line, and writes a **`qty_out` `lot_ledger`
    row** so the sold unit is traceable back to its batch (recall) and forward from the ledger. Consumption
    logic lives in **`LotsService.consumeForSale`** (the lot bounded context — extends INV-5, does not rebuild).
    A **non-tracked** item captures no lot → **byte-identical** (golden 588 / writeflow 36 unchanged). A
    **Lot-tracked** toggle on `/setup/items`. Migration `0444`; harness `pos-lot` (10).
  - **Phase 3b — serial/IMEI on the sale line (DELIVERED).** An item flagged **`items.is_serial_tracked`** is
    sold as a **specific physical unit**: the sale names **one in-stock serial/IMEI per unit**, each moves
    **InStock → Sold** (stamped with the sale), and the (first) serial is stamped on the `cust_pos_items` line —
    so warranty, returns and theft-recovery key on the exact unit. New bounded-context module **`modules/serials`**
    (`SerialsService` + `item_serials` register, tenant-scoped/RLS): `POST /api/serials/items/:id` registers
    units (idempotent), `GET …` lists them; sale-time **`consumeForSale`** fails closed on `SERIAL_REQUIRED` /
    `SERIAL_COUNT_MISMATCH` / `SERIAL_NOT_FOUND` / `SERIAL_NOT_AVAILABLE`. A **non-tracked** item captures no
    serial → **byte-identical** (golden 588 / writeflow 36 unchanged). A **Serial-tracked** toggle + a **Serial
    units** panel on `/setup/items`. Migration `0445`; harness `pos-serial` (12).
  - **Phase 3c — age-restricted prompt (DELIVERED).** An item carries a **minimum buyer age** (`items.min_age`,
    0 = unrestricted; Thailand alcohol/tobacco = 20). A POS sale whose cart contains an age-restricted item is
    **refused until the buyer's age is verified**: the cashier attests they checked ID (`age_ack`) OR a
    `customer_birthdate` proves the buyer meets the highest required age — else `AGE_VERIFICATION_REQUIRED` /
    `AGE_BELOW_MINIMUM`; the sale records `cust_pos_sales.age_verified` for the audit trail. The register
    **confirms and retries** on `AGE_VERIFICATION_REQUIRED` (a native ID-check prompt). A cart with no
    restricted item is **byte-identical** (golden 588 / writeflow 36 unchanged). A **Min buyer age** field on
    `/setup/items`. Migration `0446`; harness `pos-age` (8). **Phase 3 complete.**
- **Phase 4 — Pricing depth.** Customer-tier & per-branch **price books**; per-line manual-discount approval.
  - **Phase 4a — customer-tier & per-branch price books (DELIVERED).** A governed, approved **base-price list**
    the till draws from, so a POS price has an auditable basis instead of being typed freely per line (the POS
    analogue of the CRM-15 "prices typed freely" gap). A **price book** (migration `0447`, tenant-scoped:
    `price_books` + `price_book_entries`, canonical 0232 RLS + tenant-leading indexes) serves a customer **tier**
    (`retail|wholesale|vip|member…`; NULL = any) and/or a **branch** (NULL = any), holds a per-item unit price
    (with an optional book-local `min_qty` break), and is **maker-checker** — staged `PendingApproval` + inactive,
    activated by a **different** user (`SOD_VIOLATION` on self-approval — mirrors the price-rule **G6/R10** gate).
    New `PriceBookService` (a sibling sub-service in the pricing bounded context) + `/api/pricing/books[/…]`
    (maintain `pricelist`/`exec`; approve/reject `exec`/`approvals`) + `GET /api/pricing/book-price` (sellers,
    for till display). `createSale` takes an optional **`price_tier`** and, when an active/approved book prices
    an item under the sale's (tier, branch), **overrides** the line's client `unit_price` *before* the promo
    engine (precedence: priority → specificity → newest; highest `min_qty ≤ qty` wins). **Absent a matching book
    the client price stands ⇒ byte-identical** (golden 588 / writeflow 36 unchanged; the resolver is only
    consulted when a tier or branch is in play). Web: a **สมุดราคา (Price books)** tab on `/pricing` (create +
    entries + approve/reject) and a **Price tier** selector on the register checkout (non-restaurant path).
    Harness `pos-pricebook` (13). No new numbered control (governed base price strengthens the R10 pricing
    control; census 298). **Still open (Phase 4b):** per-line manual-discount approval routing.
  - **Phase 4b — manual-discount / bill-discount approval routing (DELIVERED).** A manual line or bill discount
    above the shop's configured authority must be **authorized by a supervisor at the till** rather than applied
    freely. New per-tenant policy **`pos_discount_settings`** (migration `0448`; `max_line_discount_pct` /
    `max_bill_discount_pct`, **both NULL = no cap → the pre-4b behaviour, byte-identical**; a shop OPTS IN to
    discount governance). A supervisor (authenticated — `POST /api/pos/discount-authorize`, gated to the
    refund/override duty `pos_refund`/`exec`, **segregated from selling** per **SoD R08**) issues a single-use
    **`discount` authorization** (a `pos_overrides` row + new `authorized_pct` column) bounding the % it covers.
    `createSale` takes an optional **`discount_approval_no`**; when a manual `discount_pct` (line) or `discount`
    (bill) exceeds its cap, the sale is **refused** (`DISCOUNT_APPROVAL_REQUIRED`) unless it references a valid
    authorization, which is then **consumed atomically in the sale tx** — fail-closed on
    `DISCOUNT_APPROVAL_INVALID`/`_INSUFFICIENT`/`_CONSUMED`/`_NOT_FOUND` and on `SOD_VIOLATION` (the approver may
    not be the selling cashier). Web: a **อำนาจส่วนลด (Discount authority)** tab on `/pos-control` (set the caps +
    issue an authorization code) and the register **prompts for the OVR- code** on `DISCOUNT_APPROVAL_REQUIRED`
    and retries. Harness `pos-discount-approval` (12). No new numbered control (an enforced discount-authority
    gate strengthens **R08/R10** + POS-08; census 298). **Phase 4 complete.**
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
    `0443` seeds the tender event types; harness `pos-split` (8). No new control (strengthens REV-05 / POS-08).

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
| 0.13 | 2026-07-19 | Platform | **Phase 4b delivered — manual-discount / bill-discount approval routing (Phase 4 complete).** Migration `0448` adds per-tenant **`pos_discount_settings`** (`max_line_discount_pct`/`max_bill_discount_pct`, both NULL = no cap → **byte-identical** default) + an `authorized_pct` column on `pos_overrides`. A supervisor authorizes an over-cap discount via `POST /api/pos/discount-authorize` (gated `pos_refund`/`exec` — SoD R08, segregated from selling), issuing a single-use `discount` authorization (`approved_by` = the authenticated supervisor). `createSale` takes optional `discount_approval_no`; a manual `discount_pct` (line) or `discount` (bill) over its cap is refused (`DISCOUNT_APPROVAL_REQUIRED`) unless it references a valid authorization, **consumed atomically in the sale tx** (guarded `WHERE sale_no IS NULL`) — fail-closed `DISCOUNT_APPROVAL_INVALID`/`_INSUFFICIENT`/`_CONSUMED`/`_NOT_FOUND` + `SOD_VIOLATION` (approver ≠ selling cashier). `PosControlService.getDiscountSettings/setDiscountSettings/authorizeDiscount/consumeDiscountApproval` + `GET/PUT /api/pos/discount-settings`; `PortalModule` imports `PosControlModule`; `discount_approval_no` on `/api/pos/sales` + `/api/portal/pos/sales`. Web: อำนาจส่วนลด tab on `/pos-control` + register prompts for the OVR- code on refusal. Absent caps ⇒ byte-identical (golden 588 / writeflow 36 unchanged). Harness `pos-discount-approval` (12: caps-off byte-identical; over-cap refused; cashier-can't-authorize 403; supervisor authorizes; over-cap sells with authorization; single-use; insufficient; SoD approver≠cashier; at-cap free; bill-discount gated; cross-tenant isolation). No new numbered control (strengthens R08/R10 + POS-08; census 298). |
| 0.12 | 2026-07-19 | Platform | **Phase 4a delivered — customer-tier & per-branch price books.** Migration `0447` adds the tenant-scoped **`price_books`** (tier/branch/priority/validity, maker-checker `status`) + **`price_book_entries`** (per-item price, book-local `min_qty` break), both with the canonical 0232 RLS loop + tenant-leading indexes + `app_user` grant. New **`PriceBookService`** (sibling sub-service in the pricing bounded context; exported from `PricingModule`): CRUD, maker-checker `approveBook`/`rejectBook` (self-approval → `SOD_VIOLATION`, mirrors price-rule G6), and `resolvePriceMany` (active/approved books matching tier/branch/validity; precedence priority → specificity → newest; highest `min_qty ≤ qty` wins). Routes on `PricingController`: `/api/pricing/books[/:id[/entries|/approve|/reject]]` (maintain `pricelist`/`exec`; approve/reject `exec`/`approvals`) + `GET /api/pricing/book-price` (sellers). `createSale` takes optional **`price_tier`** and overrides each line's client `unit_price` with the governed book price *before* promo rules — **absent a matching book ⇒ byte-identical** (golden 588 / writeflow 36 unchanged; resolver consulted only when a tier/branch is present). `price_tier` accepted on `/api/pos/sales` + `/api/portal/pos/sales`. Web: **สมุดราคา** tab on `/pricing` + a **Price tier** selector on the register checkout (non-restaurant). Harness `pos-pricebook` (13: staged pending+inactive; pre-approval byte-identical; self-approve → SOD_VIOLATION; distinct approve → Active; post-approval governed price; no-tier/unknown-tier byte-identical; priority precedence; `/book-price` read; branch-scoped; min_qty break; cross-tenant isolation; non-pricing-role 403). No new numbered control (strengthens R10 pricing governance; census 298). |
| 0.11 | 2026-07-19 | Platform | **Phase 3c delivered — age-restricted prompt (Phase 3 complete).** Migration `0446` adds `items.min_age` (0 = unrestricted, shared master no RLS loop) + `cust_pos_sales.age_verified`. `createSale` computes the highest `min_age` across the cart; when > 0 the sale must be age-verified BEFORE anything persists — a `customer_birthdate` proving the buyer meets it (`AGE_BELOW_MINIMUM` if under) or the cashier's `age_ack` attestation — else `AGE_VERIFICATION_REQUIRED`; the sale stamps `age_verified`. A cart with no restricted item ⇒ **byte-identical** (golden 588 / writeflow 36 / basics / restaurant / pos-lot / pos-serial / pos-split unchanged). `age_ack`/`customer_birthdate` accepted on `/api/pos/sales` + `/api/portal/pos/sales`; the register **confirms + retries** on `AGE_VERIFICATION_REQUIRED` (`px.reg_age_confirm`). **Min buyer age** field on `/setup/items`. Harness `pos-age` (8: no-info → AGE_VERIFICATION_REQUIRED; age_ack → sells age_verified; birthdate ≥ min → sells; birthdate < min → AGE_BELOW_MINIMUM; mixed cart still gated; unrestricted byte-identical; non-seller 403). No new numbered control (statutory-sale gate; census 298). |
| 0.10 | 2026-07-19 | Platform | **Phase 3b delivered — serial/IMEI on the sale line.** Migration `0445` adds `items.is_serial_tracked` (shared master, no RLS loop) + `cust_pos_items.serial_no` + the tenant-scoped **`item_serials`** unit register (canonical 0232 RLS + `(tenant_id,item_id,status)` index + `app_user` grant). New bounded-context module **`modules/serials`** (registered in the supply-chain domain aggregate): `SerialsService.addSerials`/`listSerials` (`POST`/`GET /api/serials/items/:id`, gated md_item/md_config/masterdata/wh_receive/warehouse/exec) register units InStock (idempotent) and list them; tx-aware **`consumeForSale`** validates one in-stock serial per unit (count == qty), marks each **InStock → Sold** + stamps the sale, and stamps the first serial on the `cust_pos_items` line. `createSale` consumes serials for serial-tracked lines (fails the sale closed on `SERIAL_REQUIRED`/`SERIAL_COUNT_MISMATCH`/`SERIAL_NOT_FOUND`/`SERIAL_NOT_AVAILABLE`); `serial_nos[]` accepted on `/api/pos/sales` + `/api/portal/pos/sales`; `PortalModule` imports `SerialsModule`. A non-tracked item ⇒ **byte-identical** (golden 588 / writeflow 36 / basics 460 / restaurant 220 / ext 309 / pos-lot 10 / pos-split 8 unchanged; tenant-idx + rls-coverage gates green for the new table). **Serial-tracked** toggle + **Serial units** panel on `/setup/items`. Harness `pos-serial` (12: register + idempotent + list; serial sale marks Sold + stamps line; re-sell Sold → SERIAL_NOT_AVAILABLE; qty 2 → both Sold; count-mismatch; unknown; missing → SERIAL_REQUIRED; non-tracked byte-identical; cashier-can't-register 403; non-seller 403). No new control (unit-level traceability strengthens warranty/returns; census 298). |
| 0.9 | 2026-07-19 | Platform | **Phase 3a delivered — lot/expiry on the sale line.** Migration `0444` adds `items.is_lot_tracked` (shared master, no RLS loop) + `cust_pos_items.lot_no`/`expiry_date`. `createSale` resolves each lot-tracked line **FEFO** from the existing `lot_ledger` (explicit `lot_no` overrides) via new **`LotsService.consumeForSale`** (tx-aware, in the lots bounded context — extends INV-5), **fails closed** on an expired/held/missing/insufficient lot (`LOT_EXPIRED`/`LOT_ON_HOLD`/`NO_LOT_AVAILABLE`/`LOT_INSUFFICIENT`/`LOT_NOT_FOUND`), **stamps** the consumed lot+expiry on the sale line, and writes a **`qty_out` `lot_ledger` row** (recall/forward traceability). `PortalModule` imports `LotsModule` (no cycle). A non-tracked item captures no lot ⇒ **byte-identical** (golden 588 / writeflow 36 / basics / restaurant / returns / pos-split unchanged). `lot_no` accepted on both `/api/pos/sales` + `/api/portal/pos/sales`; **Lot-tracked** toggle on `/setup/items`. Harness `pos-lot` (10: FEFO skips expired + picks earliest; explicit-lot override; expired→`LOT_EXPIRED`; no-lots→`NO_LOT_AVAILABLE`; over-qty→`LOT_INSUFFICIENT`; unknown→`LOT_NOT_FOUND`; held lot excluded; non-tracked byte-identical; non-seller 403). No new control (recall/traceability strengthens INV-5/INV-18; census 298). |
| 0.8 | 2026-07-19 | Platform | **Phase 6a delivered — multi-tender split payment.** An optional `tenders[]` on `createSale` settles one sale across several tenders (cash + card + QR + voucher …): each leg is recorded as its own `PAY` tender linked to the sale + open till (pending-settlement worklist + drawer count), the legs must sum EXACTLY to the total (`TENDER_MISMATCH`), a cash leg may over-tender for change (`change_due`) but a non-cash leg may not (`NONCASH_OVERTENDER`). The GL asset debit splits across per-method `TENDER.CASH/CARD/QR/VOUCHER/OTHER` posting events — all default `1000`, so an all-default split is net-GL-identical to the legacy single `Dr 1000 = total`; a tenant remaps card/QR to a clearing account via GL-24. Migration `0443` seeds the tender event types. Absent `tenders[]` ⇒ single-tender path, byte-identical (golden 534 / writeflow 36 / basics 458 / restaurant 220 / returns 25 / payments-gateway 11 unchanged). Toggle-gated split panel on the register checkout (single-method flow unchanged). Harness `pos-split` (8: single-tender byte-identical; 3-way split → 3 PAY + net Dr 1000; short → TENDER_MISMATCH; cash over-tender → change_due; non-cash over-tender → NONCASH_OVERTENDER; GL-24 remap TENDER.CARD→1010; non-seller 403). No new control (strengthens REV-05 / POS-08; census 298). |
| 0.7 | 2026-07-19 | Platform | **Profile coverage extended to all 17 business types (no control/migration).** `PosProfileService.forIndustry` + `BusinessType` now map every `INDUSTRY_KEYS` value (not just the original five) to a register shape: **restaurant** (tables/KDS/SALE.FOOD) for restaurant + hospitality; **goods** (generic, SALE.GOODS) for retail/distribution/general/manufacturing/ecommerce/agriculture/automotive/nonprofit; **service** (generic, SALE.SERVICE) for services/construction/healthcare/professional/logistics/education/realestate. Unset/unknown still defaults to restaurant (non-breaking); the web keys on the boolean feature flags, so a new `business_type` string needs no client change. Harness `pos-profile` 13→16 (hospitality→restaurant, manufacturing→goods, healthcare→service). golden/writeflow untouched. UAT-O2C-569; manual 01 v0.70. |
| 0.6 | 2026-07-19 | Platform | **Phase 2c delivered — kits/bundles + non-inventory items.** Migration `0441` adds `item_relationships.qty` (per-component count for a `kit_component` row; existing rows default 1). `createSale` builds a kit map (tenant-scoped `kit_component` rows, from=kit → to=component) and **explodes** each kit line into its components — component `customer_inventory`/`cust_stock_log`/`branch_stock` decrement + `costing.onIssue` COGS × the line qty — while the kit SKU itself is never decremented/costed; revenue posts the kit's own line price to the goods event (not the component-price sum). A `supply_type='non_inventory'` item skips stock/COGS like `service` but keeps the **goods** revenue event. The per-qty stock block was extracted (`processStockQty`) so a plain goods line stays **byte-identical**. A **Kit components** panel on `/setup/items` edits the BOM (`ItemRelBody.qty`; `POST/GET/DELETE …/relationships`). Catalog/BOM-only — golden 534 / writeflow 36 / restaurant 220 / returns 25 / item-service / item-variants unchanged. Harness `item-kit` (9: kit ×1 consumes components not the kit SKU; component-only stock-logs; revenue = kit price → 4000; component COGS 50; kit ×2 multiplies the BOM; non-kit line byte-identical; non_inventory no-stock/no-COGS → 4000; API add+list qty; non-seller 403). No new control (census 298). |
| 0.5 | 2026-07-18 | Platform | **Phase 2b delivered — product variants / matrix items.** Migration `0440` adds `items.parent_item_id` (self-ref) + `is_matrix_parent` + the shared `item_variant_attributes(item_id, axis, value)` table (no tenant_id, like `items`). `POST /api/item-setup/items/:id/variants` generates the matrix from axes (cartesian product → child `items` rows `${parentSku}-${vals}`, inherited price, optional per-SKU barcode, attribute rows; idempotent) + `GET …/variants`. A variant **barcode resolves via `/api/procurement/catalog?barcode=`** (variants are `items` rows). Minimal **Variants panel** on `/setup/items`. Catalog-only — golden 534 / writeflow 36 / basics / item-service unchanged. Harness `item-variants` (7: 2×2 matrix → 4 linked child SKUs + attributes + inherited price; GET lists; idempotent +colour adds only new cells; barcode scans to the exact variant; non-setup 403; empty-axes 400). No new control (census 298). |
| 0.4 | 2026-07-18 | Platform | **Phase 2a delivered — sale-line resolve + service items.** `createSale` now resolves each `item_id` against the shared `items` master to read `supplyType`; a `service` line skips the inventory/`cust_stock_log`/recipe/`costing.onIssue` COGS moves and its revenue posts to `SALE.SERVICE` (mixed carts split revenue by line; the two revenue legs sum exactly to the taxable base). An `item_id` with no master row defaults to goods → byte-identical (golden 534 / writeflow 36 / returns / basics unchanged). `supplyType` editable in item-setup (`ItemProfileDto`). Migration `0439` seeds `SALE.GOODS`/`SALE.SERVICE` into `posting_event_types` so they are GL-24-overridable (a services tenant can remap `SALE.SERVICE` to its service-income account). Harness `item-service` (7): service sale = no stock/COGS + revenue to the remapped account; goods sale unchanged; mixed cart splits; unknown item_id → goods; non-seller 403. No new control (census 298). |
| 0.3 | 2026-07-18 | Platform | **Phase 1b delivered — generic sale-path cutover.** `POST /api/pos/sales` (`PosSaleService`, `pos_sell`) rings a non-restaurant sale through the reused `PortalPosService.createSale` engine — extended with optional `tenant` (internal caller passes the resolved tenant, since its `customerName` ≠ the tenant code) + `revenueEvent` (default `SALE.FOOD`, byte-identical GL). The register's `settle` branches on `sale_path` (generic → `/api/pos/sales`, no `dine_in_orders`; restaurant → unchanged). `PortalModule` exports `PortalPosService`; `PosModule` imports it (no cycle). Harness `pos-profile` 8→13 (generic sale: no dine_in_orders, revenue→4000 via SALE.GOODS, VAT→2100, stock decrement, non-seller 403). golden 534 / writeflow 36 unchanged (defaults preserve the existing money path). No migration, no new control. |
| 0.2 | 2026-07-18 | Platform | **Phase 1a delivered — business-type POS profile + de-restaurant the register.** New `PosProfileService` + `GET /api/pos/profile` derives `{tables,kds,courses,buffet,recipe_deduction,revenue_event,sale_path}` from `tenants.industry` (unset → restaurant, non-breaking). Neutral revenue events `SALE.GOODS`/`SALE.SERVICE` added to `SALES_POSTING_EVENTS` (both default `4000` → no GL drift). The internal register reads the profile and hides table/dine-in affordances for a non-restaurant tenant. No money-path change (golden/writeflow untouched). Harness `pos-profile` (8 checks). Phase 1 split into 1a (this) + 1b (generic sale-path cutover, next). |
| 0.1 | 2026-07-18 | Platform | Initial plan. Gap analysis across ten dimensions; business-type feature profile as the linchpin; six-phase roadmap; Phase 0 (#1/#2/#3) delivered. |
