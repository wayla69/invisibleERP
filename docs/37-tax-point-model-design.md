# 37 — VAT Tax-Point Model (design for review · workstream 5.1)

> **Status:** DESIGN — for review before implementation. This is the single largest Thai-tax correctness
> gap from the enterprise evaluation. It changes how VAT is *dated*, so it needs a tax-advisor sign-off
> (Wave 0 · X5) on the rules table below before code lands.
>
> **Problem.** Today every tax document is dated `issueDate = ymd()` (today) and there is no goods-vs-service
> distinction. Thai VAT law dates output/input VAT by the **tax point (จุดความรับผิดในการเสียภาษี)**, not the
> issue date — so VAT can fall in the wrong filing period (ภ.พ.30), which an RD audit assesses.

## 1. The rule (VAT tax point under the Revenue Code — verified against ประมวลรัษฎากร)

> Reconciled 2026-07-07 against the Revenue Department text (มาตรา 77–79, rd.go.th) and คำสั่ง ป.36/2536.
> The code models the law as **"a default event, unless a listed earlier event occurs first"** — which
> reduces to *earliest-of* the listed events. Citations are load-bearing: the advisor (X5) signs off on THIS
> table, not on prose.

| Supply type | Governing section | Tax point |
|-------------|-------------------|-----------|
| **Goods — ขายสินค้าทั่วไป** | **มาตรา 78 วรรคหนึ่ง (1)** | Default = **ส่งมอบสินค้า** (delivery); but if any of **โอนกรรมสิทธิ์** (transfer of ownership) · **ได้รับชำระราคา** (payment received) · **ออกใบกำกับภาษี** (tax invoice issued) happens *before* delivery, the tax point is that earlier event (ตามส่วน). ⇒ earliest-of {delivery, transfer, payment, invoice}. |
| **Services — การให้บริการทั่วไป** | **มาตรา 78/1 (1)** | Default = **ได้รับชำระราคาค่าบริการ** (payment received); but if **ออกใบกำกับภาษี** or **ได้ใช้บริการ** (service used, self or other) happens *before* payment, the tax point is that earlier event. ⇒ earliest-of {payment, invoice, service-used}. |
| **Hire-purchase / installment sale where ownership has NOT passed at delivery — เช่าซื้อ / ขายผ่อนชำระ** | **มาตรา 78 (2)**, คำสั่ง **ป.36/2536** | Tax point arises **per instalment, on each instalment's due date (ถึงกำหนดชำระราคาแต่ละงวด)**, and a tax invoice is issued each instalment — NOT once at delivery. **Directly relevant to the `realestate` installment-sale module (RE-01..03) and any future installment plan** — must be handled, not deferred. |
| **Advance / deposit (เงินรับล่วงหน้า / มัดจำ)** | มาตรา 78(1)(ข) / 78/1; ป.36/2536 | An advance that is **consideration (ชำระราคา)** triggers the tax point at receipt (goods: payment-before-delivery; services: payment) and a tax invoice is issued then. A **refundable security deposit that is NOT consideration** does not — the classification per the contract is the advisor's call. (Ties to 5.7.) |
| **Consignment/agent · export — ตั้งตัวแทน · ส่งออก** | มาตรา 78 (3)(4) | Separate special rules (agent-sale point; export = customs-clearance/duty point). **Phase 2 — flagged for the advisor**; not needed for the current POS/AR/real-estate paths. |

The key behavioural changes vs. today's `issueDate = tax point`: (a) **payment can trigger the tax point
before the invoice** (services always; goods if paid first) — matters for deposits/prepayments; (b) **delivery
before invoicing** moves the goods tax point earlier; (c) **installment/real-estate sales** must emit a tax
point + tax invoice per instalment due date, not once.

**Sources:** [rd.go.th มาตรา 77–79](https://www.rd.go.th/5205.html) · [rd.go.th หมวด 4 VAT](https://www.rd.go.th/2596.html) · [คำสั่ง ป.36/2536 (เช่าซื้อ/ผ่อนชำระ)](https://www.rd.go.th/3606.html) · [มาตรา 78/1 (Pasee)](https://www.pasee.info/docs/matra78-1)

## 2. Data model changes

1. **`supply_type`** on the sellable master. Add `items.supply_type` = `'goods' | 'service'` (default
   `'goods'`; a service item = `'service'`). `items` has **no `tenant_id`** (shared master) → the migration
   needs **no RLS loop** (mirrors `items.barcode` in 0250). A document line inherits its item's `supply_type`;
   a line with no item (free-text/AR) defaults to the document-level `supply_type` (new column, below).
2. **`tax_point_date`** — distinct from `issue_date` — on:
   - `tax_invoices` (`tax_point_date date`), `ar_invoices` (or the AR posting row), and the abbreviated-slip
     path. Doc tables are tenant-scoped → **append the 0232-form RLS loop** for the new column? No — adding a
     column to an existing RLS'd table needs no new policy; RLS already covers the row. Only *new tables* need
     the loop. So this is a plain `ALTER TABLE … ADD COLUMN`.
   - `supply_type text` at the document level as the fallback classifier.
3. **Backward-compat / grandfather.** For every existing row, `tax_point_date` **defaults to `issue_date`**
   (a `DEFAULT` + a one-time `UPDATE … SET tax_point_date = issue_date WHERE tax_point_date IS NULL`). So
   historical reports are unchanged; only new documents compute a real tax point.

Migration: next free number (**0278** as of `0277_item_merge`), hand-journaled, monotonic `when`.

## 3. Computation — `resolveTaxPoint()`

A pure helper (in `modules/tax`, unit-testable like `mfa-gate.ts`):

```
resolveTaxPoint({ supplyType, deliveryDate?, paymentDate?, invoiceDate, advanceReceiptDate? }): string  // yyyy-mm-dd
  goods   → min(deliveryDate ?? ∞, paymentDate ?? ∞, invoiceDate)
  service → min(paymentDate ?? ∞, advanceReceiptDate ?? ∞, invoiceDate)
  (all dates on the Asia/Bangkok business day via ymd(); ∞ = a sentinel far-future date)
```

Wired at the points that create a tax document / VAT-bearing event:
- `tax-invoice.service.ts issueFull/issueAbbrev` — stamp `tax_point_date` from the sale/invoice's
  delivery + payment + issue dates.
- POS sale (`dine-in.buildSale`) — goods sold + paid at the till ⇒ tax point = sale date (already effectively
  correct; make it explicit).
- Deposit receipt (5.7) — a **service** deposit stamps a tax point at receipt and emits output VAT then.

## 4. Reporting — bucket by tax point

`tax-reports.service.ts`:
- `outputVat` / `inputVat` / `pp30` filter and group by **`tax_point_date`** within the period window
  (currently they use `issueDate` / `invoiceDate`). Because `tax_point_date` defaults to `issue_date`, the
  numbers are unchanged for legacy rows — only newly tax-pointed docs move to the correct period.
- Add a reconciliation flag: a document whose `tax_point_date` falls in a **prior closed period** but was
  issued now → surface as a late-tax-point exception (an RD-audit red flag), not silently absorbed.

## 5. Phasing (each a reviewed PR with ToE + doc-sync)

| Phase | Scope | ToE |
|-------|-------|-----|
| **5.1a** | `resolveTaxPoint()` pure helper + `items.supply_type` + `tax_point_date` columns (migration 0278, default = issue_date) | new `cutover/tax-point` (pure rule matrix: goods/service earliest-of) |
| **5.1b** | Stamp `tax_point_date` at issue (tax-invoice + POS) | extend `taxdocs` (goods delivered-before-invoice → tax point = delivery) |
| **5.1c** | Reports bucket by tax_point_date + late-tax-point exception | extend `taxdocs` (pp30 periods by tax point; legacy rows unchanged) |
| **5.1d** | Service advance/deposit output-VAT trigger (merges 5.7) | extend `taxdocs` (service deposit → output VAT at receipt) |
| **5.1e** | **Installment / real-estate tax point (มาตรา 78(2))** — a tax point + tax invoice per instalment due date in the `realestate` module (RE-01..03), not once at contract | extend `cutover/projects`/`taxdocs` (each instalment due → one tax point; re-run idempotent) |

## 6. Risk & dependencies
- **Advisor sign-off (X5) required** on §1 before 5.1b — a wrong rule bakes mis-periods into the ledger.
- **FX VAT (5.2)** is adjacent: once the tax point is at payment, the BOT rate is the payment-date rate — do
  5.2 right after 5.1 to keep FX conversions consistent.
- Backward-compat is the safety net: `tax_point_date` defaults to `issue_date`, so shipping 5.1a is inert
  until the stamping (5.1b) turns on.
- Controls: add an RCM control for tax-point correctness (bumps the census; regenerate `build_rcm.py`, update
  the tagged spans, `check-rcm-census`). Narrative PN-06, user-manual tax, UAT 06-tax.

## Revision history
| Version | Date | Author | Change |
|---------|------|--------|--------|
| 0.1 | 2026-07-07 | Platform / Tax | Initial design for review — rule table, data model (`supply_type` + `tax_point_date`, default=issue_date grandfather), `resolveTaxPoint()`, report bucketing, 4-phase plan. Pending tax-advisor sign-off on §1. |
| 0.2 | 2026-07-07 | Platform / Tax | **§1 reconciled against the Revenue Code (ประมวลรัษฎากร).** Added the governing sections + source links (มาตรา 78 goods, 78/1 services, 78(2)+ป.36/2536 installments, 78(3)(4) consignment/export). Corrected the framing to the code's "default-unless-earlier-event" structure. **Key correction:** installment/hire-purchase (real-estate RE-01..03) is **in-scope**, not deferred — tax point per instalment due date (มาตรา 78(2)); added phase 5.1e. Still pending advisor sign-off, but now cited. |
