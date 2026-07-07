# 37 — VAT Tax-Point Model (design for review · workstream 5.1)

> **Status:** DESIGN — for review before implementation. This is the single largest Thai-tax correctness
> gap from the enterprise evaluation. It changes how VAT is *dated*, so it needs a tax-advisor sign-off
> (Wave 0 · X5) on the rules table below before code lands.
>
> **Problem.** Today every tax document is dated `issueDate = ymd()` (today) and there is no goods-vs-service
> distinction. Thai VAT law dates output/input VAT by the **tax point (จุดความรับผิดในการเสียภาษี)**, not the
> issue date — so VAT can fall in the wrong filing period (ภ.พ.30), which an RD audit assesses.

## 1. The rule (VAT tax point under the Revenue Code)

| Supply type | Tax point = the EARLIEST of… |
|-------------|------------------------------|
| **Goods (สินค้า)** | delivery / transfer of ownership · **or** payment received · **or** tax invoice issued · **or** goods used by self |
| **Services (บริการ)** | payment received · **or** tax invoice issued · **or** service used (for own use) |
| **Advance / deposit (มัดจำ, รับล่วงหน้า) for services** | receipt of the advance is a payment → tax point triggers on that receipt (ties to 5.7) |
| **Goods on approval / consignment / hire-purchase / installments** | special rules — out of scope for phase 1, flagged for the advisor |

The key change: **payment can trigger the tax point *before* the invoice** (services always; goods if paid
first). Our current code assumes invoice-issue = tax point, which under-reports when a deposit/prepayment
precedes the invoice, and mis-periods when delivery precedes invoicing.

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
