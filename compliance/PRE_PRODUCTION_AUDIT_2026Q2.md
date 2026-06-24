# Pre-Production Final Gate-keeping Audit — 2026 Q2 (NASDAQ readiness)

**Scope:** full-codebase audit across four pillars (E2E wiring, DB performance, SOX/ICFR controls,
functional/component testing) of the Invisible ERP + POS single-app platform.
**Date:** 2026-06-24 · **Branch:** `claude/erp-pos-nasdaq-audit-3ovoey`

Verification gates re-run green after changes: `@ierp/parity writeflow`, `@ierp/parity analytics`,
`@ierp/cutover compliance` (57/57 controls), `@ierp/api build`, `@ierp/web typecheck`.

---

## Audit checklist (pass / fixed / flagged)

### Pillar 1 — End-to-End Wiring & Endpoint Validation
| # | Item | Status |
|---|------|--------|
| 1.1 | Central web API client throws on 4xx/5xx, 15s timeout (no infinite spinner), 401→login | ✅ PASS (`apps/web/src/lib/api.ts`) |
| 1.2 | `StateView` loading/error gate used pervasively; `DataTable` empty states | ✅ PASS |
| 1.3 | POS sale → stock deduction → GL posting atomic (one request tx) | ✅ PASS (`dine-in.service.buildSale`) |
| 1.4 | Diner checkout `doBill()` swallowed API errors silently | ✅ **FIXED** — added catch→`setErr` (`qr/[token]/page.tsx`) |
| 1.5 | Member self-service `mapi()` has no request timeout | ⚠️ FLAGGED (low; consumer app) |

### Pillar 2 — Database Performance & Maintenance
| # | Item | Status |
|---|------|--------|
| 2.1 | `journal_lines.entry_id` (GL report join key) unindexed → full scan | ✅ **FIXED** — `idx_jl_entry` (+`idx_jl_tenant`) |
| 2.2 | `journal_entries` no `(tenant_id, entry_date)` / `(status, entry_date)` for period reports | ✅ **FIXED** |
| 2.3 | `payments` no `sale_no` / `(tenant_id, created_at)`; `payment_refunds.payment_no` | ✅ **FIXED** |
| 2.4 | `cust_pos_sales` / `cust_pos_items` (highest-volume retail table) zero indexes | ✅ **FIXED** |
| 2.5 | Inventory ledgers (`stock_movements`, `lot_ledger`, `location_stock`) unindexed | ✅ **FIXED** |
| 2.6 | Procurement FK children + 3-way-match join keys unindexed | ✅ **FIXED** |
| 2.7 | Auto-vacuum / analyze / reindex plan for production peak load | ✅ **ADDED** (`tools/ops/sql/maintenance.sql`) |
| 2.8 | N+1: AR sync, journal-line list, consolidation, costing-on-issue, anomaly report | ⚠️ FLAGGED (recommended batch refactors — see below) |

All new indexes are in a single idempotent migration `apps/api/drizzle/0110_perf_indexes.sql` and mirrored in
the Drizzle schema (`ledger/payments/sales/inventory/procurement`). Verified to apply cleanly on PGlite.

### Pillar 3 — Strict SOX Compliance & Internal Control
| # | Item | Status |
|---|------|--------|
| 3.1 | Manual JE maker-checker — approver ≠ creator enforced (incl. Admin) | ✅ PASS (`ledger.service.approveEntry`) |
| 3.2 | Generic approval engine blocks self-approval + delegate-to-self | ✅ PASS (`workflow.service.act`) |
| 3.3 | `audit_log` append-only — DB trigger + zero UPDATE/DELETE in code | ✅ PASS (`drizzle/0062`) |
| 3.4 | `approval_actions` append-only | ✅ PASS (`drizzle/0030`) |
| 3.5 | Audit log captures user / timestamp / IP / action / status | ✅ PASS (`common/audit.interceptor.ts`) |
| 3.6 | AR receipt `paidAmount` — unlocked read-modify-write (lost-update race) | ✅ **FIXED** — `FOR UPDATE` + recompute |
| 3.7 | AP payment `paidAmount` — unlocked read-modify-write (lost-update race) | ✅ **FIXED** — `FOR UPDATE` + recompute |
| 3.8 | Returns restock — inventory add not row-locked | ✅ **FIXED** — `FOR UPDATE` |
| 3.9 | AP disbursement (`payAp`) has no maker-checker / second-person approval | ⚠️ FLAGGED (medium — see below) |
| 3.10 | AP bill can be booked pre-paid in one call (`createApTxn`, `paid_amount>0`) | ⚠️ FLAGGED (low-med) |
| 3.11 | Central `audit_log` records no old-value / new-value (before/after image) | ⚠️ FLAGGED (medium) |

### Pillar 4 — Exhaustive Functional & Component Testing
| # | Item | Status |
|---|------|--------|
| 4.1 | POS pay / journal post / form submits disabled while in-flight | ✅ PASS (model: `accounting`, `pos/new`, `portal/pos`) |
| 4.2 | Payment **capture / void / refund / reconcile** row buttons double-submittable | ✅ **FIXED** (`payments/terminals/page.tsx`) |
| 4.3 | Member redeem / spin / claim double-tappable (double-spent points / coupons) | ✅ **FIXED** (`m/page.tsx` busy guard) |
| 4.4 | GL idempotency (`ux_je_idem`) + tender idempotency (`ux_payments_idem`) | ✅ PASS |
| 4.5 | Double-settle guard on order checkout (`loadOrderForUpdate`) | ✅ PASS |
| 4.6 | ~18 other table-row action buttons (approve/delete/toggle) missing in-flight disable | ⚠️ FLAGGED (medium; errors surface, but dupe request fires) |

---

## Changes made this pass

**Data-integrity (concurrency) — `apps/api/src/modules/`**
- `finance/finance.service.ts` — `createReceipt` and `payAp` now lock the AR invoice / AP bill row
  (`SELECT … FOR UPDATE`) inside the transaction and recompute `paidAmount` from the **locked** value,
  eliminating the lost-update race on concurrent partial payments (sub-ledger ≠ GL control account). The AP
  idempotency guard remains outside the lock tx (it queries the GL on `this.db`; nesting it would deadlock
  the connection). Return shapes unchanged; idempotency preserved (verified applies-once).
- `returns/returns.service.ts` — restock read now `FOR UPDATE`, matching the deduction path.

**Performance — schema + migration**
- `database/schema/{ledger,payments,sales,inventory,procurement}.ts` + `drizzle/0110_perf_indexes.sql` —
  24 indexes on GL/POS/payment/inventory/procurement hot-path join keys, tenant-scoped date ranges, and FK
  children. `tools/ops/sql/maintenance.sql` — per-table autovacuum tuning + pg_cron analyze/reindex + bloat query.

**UX correctness — `apps/web/src/app/`**
- `(internal)/payments/terminals/page.tsx` — capture/void/refund/reconcile buttons disabled per-row while
  in-flight (no duplicate money movement).
- `m/page.tsx` — `busy` re-entrancy guard on redeem/spin/claim/mission (no double-spent points/coupons).
- `qr/[token]/page.tsx` — `doBill()` now surfaces API errors instead of swallowing them.

## Flagged for a dedicated workstream (NOT remediated this pass — require design + doc/RCM updates)
1. **AP disbursement maker-checker (3.9, medium).** Route `payAp` through `WorkflowService` (as PO/PR) or add
   an explicit `payer ≠ bill-creator` + threshold dual-approval, with a `pay_ap` permission distinct from
   `creditors`. Also gate `createApTxn` pre-paid creation (3.10). Touches `permissions.ts`, RCM, narratives, UAT.
2. **Audit before/after capture (3.11, medium).** Add structured `old_value`/`new_value` (jsonb) for mutations
   on financially-significant entities (interceptor enrichment or row-level triggers).
3. **N+1 batch refactors (2.8).** AR sync (`finance.service.ts:130`), journal-line list (`ledger.service.ts:231`),
   consolidation (`consolidation.service.ts:97`), costing-on-issue (`costing.service.ts:95`), anomaly report
   (`anomalies.service.ts:38`) — collapse per-row queries to `inArray`/join batches.
4. **~18 remaining table-row buttons (4.6)** — apply the same `disabled={mut.isPending}` pattern fleet-wide.

## Sign-off
Conditionally **production-ready**: the data-integrity (lost-update) and double-submit money-movement defects —
the items that most directly threaten an audit — are fixed and verified, and the performance/maintenance gaps
that risked peak-load degradation are closed. The four FLAGGED items are lower-severity or design-level and
should be scheduled as follow-up workstreams with their accompanying control-documentation updates before they
are signed off individually; none is a release blocker for the audited transaction paths.

## Revision history
| Date | Author | Change |
|------|--------|--------|
| 2026-06-24 | Pre-production audit | Initial four-pillar gate-keeping audit; concurrency, indexing, maintenance, and double-submit fixes. |
