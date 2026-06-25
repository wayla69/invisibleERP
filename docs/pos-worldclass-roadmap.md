# POS — World-Class Upgrade Roadmap

**Date:** 2026-06-22 · **Scope:** elevate the V2 POS (NestJS/Drizzle/Next.js) from "solid ERP-POS" to Square/Toast/Lightspeed/Oracle-Simphony class.

**Already in place (don't rebuild):** multi-tender + `pay-multi` + split-bill (each check = sale+GL+invoice), KDS/tables/QR ordering/channels/fulfillment board, recipe→inventory deduction with `FOR UPDATE`, till open/close + cash movements + X/Z reports, loyalty + gift cards (GL-posted), abbreviated tax invoice, real PromptPay EMVCo QR, offline `saleDate` replay, CFD endpoint, ESC/POS receipt rendering.

Conventions every phase follows (per repo): Drizzle schema + hand-written migration registered in `meta/_journal.json`; tenant-scoped tables get `tenant_id` + the RLS loop re-run; services write GL only via `ledger.postEntry` behind `alreadyPosted`; `FOR UPDATE` + re-check on every balance/stock RMW; POST→201; doc numbers via `DocNumberService`; `ymd()`/Bangkok dates; each phase ships with a `tools/cutover/*` harness (green on PGlite) + web page + nav + `tsc` clean.

Effort key: **S** ≈ 1–2 days · **M** ≈ 3–5 days · **L** ≈ 1–2 weeks (client-heavy).

---

## P0 — the "feels world-class on day one" set

### Phase P0a — Offline-first POS (not just replay)  · Effort **L** · Risk: high (client architecture)
**Goal:** keep selling with the network down; sync deterministically when it returns.
- **Client:** local store (IndexedDB via Dexie, or `@electric-sql/pglite` in-browser) holding menu/price/tax snapshot + an **outbox** of sales with a client-generated **idempotency key** (UUID). Service worker for app-shell + menu caching. UI shows online/offline + pending-sync count.
- **Backend:** extend `POST /api/portal/pos/sales` and `POST /api/pos/orders` to accept `client_uuid`; dedup via a `pos_offline_log` row `UNIQUE(tenant_id, client_uuid)` (mirror existing `pos_offline_sync`), returning the prior `sale_no` on replay (no double GL/stock). Batch endpoint `POST /api/pos/sync` replays an array with per-item savepoints (one bad op doesn't roll back siblings).
- **Conflicts:** stock/loyalty resolved server-side at replay time under lock; surface "adjusted at sync" results to the client.
- **Verify:** harness `offline-pos` — capture N sales offline, replay (incl. duplicate client_uuid) → exactly N sales, GL balanced, idempotent on re-run.
- **Depends on:** nothing. **Highest reliability ROI.**

### Phase P0b — Payment terminal + peripheral bridge · Effort **L** · Risk: high (external PSP + hardware)
**Goal:** real card acceptance + integrated hardware.
- **Terminal/PSP:** implement a real `PaymentGateway` (extend `gateways.ts`) for a Thai acquirer — **Opn (Omise) / 2C2P / GB Prime** — supporting: create-charge, **EMV chip + contactless/tap**, **pre-auth + capture** (bar tabs), tip-on-terminal, void, refund-via-PSP, and a **settlement/batch** endpoint reconciled against `payments`. New tables: `payment_terminals` (pairing), `payment_intents` (PSP ref ↔ sale), `settlement_batches`.
- **Endpoints:** `POST /api/payments/terminal/charge`, `/capture`, `/void`, `POST /api/payments/settlements/reconcile`, webhook `POST /api/payments/psp/webhook` (HMAC-verified, idempotent on PSP event id).
- **Peripheral bridge:** a small local agent (or WebUSB/WebSerial) for **ESC/POS printer** (reuse `receipt.service` ESC/POS output), **cash-drawer kick**, **barcode scanner** (keyboard-wedge handled in web), and a **customer-facing display** screen wired to the existing CFD endpoint. **✅ Delivered (2026-06-25):** the WebUSB/WebSerial bridge (`apps/web/src/lib/peripherals.ts`) is now wired into the register via `apps/web/src/lib/terminal.ts` + the register's **⚙ ตั้งค่าเครื่อง** — receipt printing (print-through-driver **or** direct USB ESC/POS), automatic cash-drawer kick on cash sales, barcode quick-add, and live customer-display push (`POST /api/peripherals/display/:terminal`). PromptPay now also returns a scannable `qr_image`. *Still open:* the real PSP card-terminal (pre-auth/capture/settlement).
- **Verify:** harness against the PSP **sandbox** (charge→capture→refund→settle, over-refund guard already exists); printer/drawer manual-tested.
- **Depends on:** PSP merchant account (external).

### Phase P0c — Cashier speed + control · Effort **M** · Risk: med
**Goal:** the interaction speed that defines world-class.
> **✅ Delivered (2026-06-25) — the touch register `/pos/register`:** menu-grid tap-to-add with category
> chips + name/SKU search + barcode quick-add, a modifier picker, a running cart with qty steppers, a
> full-screen checkout (cash **numeric keypad** + **quick-tender** ฿100/฿500/฿1000 + live change, QR
> PromptPay, card/transfer), **hold/recall** (`/api/pos/hold` + `/held/:no/recall`), and optional
> table-attach (fires to the KDS at checkout). *Still open:* manager-override PIN modal and POS-native
> returns/exchange (below).
- **Web (retail POS page):** hotkeys + numeric keypad, **quick-tender** buttons (exact / ฿100 / ฿500), favorites/quick-keys grid, barcode quick-add, line edit by keyboard.
- **Park/recall & tabs:** `pos_held_orders` table; `POST /api/pos/hold`, `GET /api/pos/held`, `POST /api/pos/held/:id/recall`. Bar tabs ride on P0b pre-auth.
- **Manager override:** `pos_overrides` audit (action, reason_code, requested_by, approver, amount); a PIN/approval modal gates voids, discounts over a tenant threshold, price overrides, no-sale drawer opens, returns. Endpoint `POST /api/pos/override` (records + authorizes).
- **POS-native returns/exchange:** counter-fast wrapper over the existing returns module — scan original `sale_no`, pick lines, refund via P0b, restock toggle.
- **Verify:** harness `pos-control` — hold/recall round-trip; override required + recorded when discount > threshold; POS return refunds + restocks.
- **Depends on:** P0b for card refunds/pre-auth (degrade gracefully to cash if absent).

---

## P1 — pricing, fiscal, audit

### Phase P1a — Pricing engine · Effort **M**
- **Schema/service `pricing`:** `price_rules` (scope: item/category/all; channel: dine_in/takeaway/delivery; location; **time-of-day + day-of-week** windows; type: percent/amount/fixed/BOGO/qty-break; priority/stacking). Explode the existing `combo` menu type into component lines. Auto **service charge** for party-size ≥ N; configurable **satang rounding**; optional card surcharge.
- **Integrate** into `menu.resolveLine` / dine-in `buildSale` / portal POS so every channel prices consistently.
- **Endpoints:** `GET/POST /api/pricing/rules`, `POST /api/pricing/quote` (preview). Web: pricing-rules admin page + happy-hour/combo builder.
- **Verify:** harness `pricing` — happy-hour window applies only in-window; combo explodes; BOGO; service charge on 6-top; rounding to satang.

### Phase P1b — Thai fiscal compliance · Effort **M–L** · Risk: med (RD/ETDA integration)
- **Full tax invoice (ใบกำกับเต็มรูป) at POS on demand** for B2B walk-ins (buyer tax-id/branch capture) — extend `tax-docs` to be POS-callable: `POST /api/pos/orders/:saleNo/full-tax-invoice`.
- **RD e-Tax Invoice & e-Receipt** (ETDA): sign + submit via a provider (e.g. INET/Frank/leading e-Tax SP); store submission status + RD response; **electronic journal** (immutable, append-only, exportable). New tables: `etax_submissions`, `pos_journal` (hash-chained).
- **Web:** "request full tax invoice" on receipt; e-Tax status dashboard.
- **Verify:** provider **sandbox** submission + status callback; journal hash-chain integrity test.

### Phase P1c — POS audit & control · Effort **S–M**
- **Central POS audit log** unifying voids/discounts/price-overrides/no-sale/refunds (actor, reason_code, approver, before/after) — reuse `audit_log` + `status-log.service`, add reason-code masters.
- **Blind drawer close** (count without seeing expected; variance revealed after).
- **Verify:** harness asserts every controlled action writes an audit row with actor+reason; blind-close hides expected until submit.

---

## P2 — scale & ecosystem

### Phase P2a — Multi-terminal & multi-store · Effort **L**
- **Real-time register sync:** ticket/table **locking** (optimistic version column + 409 on stale write) so two servers can't collide; SSE/WebSocket push of table/KDS state.
- **Central menu/price push** per store (extend the BoM-master push pattern to menu/pricing/availability); per-store `is_available` + price tier.
- **Auto-86:** when a recipe ingredient hits 0, flag the menu item unavailable + KDS low-stock badge; `inventory` low-stock → menu availability hook.
- **Verify:** harness — concurrent table edit → one 409; 86 propagates when ingredient depleted.

### Phase P2b — Delivery-aggregator adapters · Effort **M (per platform)**
- Real adapters over the existing channel/webhook base for **Grab / LINE MAN / Foodpanda / Robinhood**: menu sync-out, order inject-in (→ existing dine-in/channel order + KDS), status callbacks, store open/close + item 86 sync. One `channel_adapters` config per tenant+platform; idempotent on `ext_event_id` (already modeled).
- **Verify:** harness simulates each platform's webhook → order lands on the fulfillment board, status round-trips.

### Phase P2c — Loyalty/CRM depth + labor · Effort **M**
- **Tiered loyalty rules** (earn/redeem multipliers per tier — the `tier` field is currently inert), **points expiry** enforcement, birthday/targeted offers, **house accounts** (on-account tender → AR), customer profile at POS (history/allergens). Gift-card **PIN + physical activation + reload + balance check**.
- **Labor / time & attendance:** `time_clock` (clock-in/out, breaks), server-performance + sales-per-labor-hour reporting.
- **Verify:** harness — Gold tier earns 2×; expired points excluded; on-account sale creates AR; clock-in/out totals hours.

---

## Recommended sequence & rationale

1. **P0a Offline-first** → reliability is the #1 thing operators judge a POS on.
2. **P0b Payments terminal + peripherals** → real money acceptance + hardware = the other half of "is this a real POS".
3. **P0c Cashier speed + control** → the felt experience; unlocks bar tabs/returns once P0b lands.
4. **P1a Pricing** then **P1b Fiscal (RD e-Tax)** → revenue levers + the Thai compliance bar.
5. **P1c Audit** (cheap, do alongside P0c/P1a).
6. **P2** as the business scales to multi-store / aggregators / labor.

**Parallelizable:** P1a (pricing) and P1c (audit) can run alongside P0c. P1b and P2b each gate on an external account/sandbox (RD e-Tax SP; each aggregator) — start procurement early.

**Biggest risks:** P0a (client re-architecture — prototype the outbox/idempotency first), P0b & P1b & P2b (external dependencies — secure sandboxes before committing UI). Everything else is in-codebase and follows the existing module/harness pattern.
