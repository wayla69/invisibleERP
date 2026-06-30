# Cutover Data-Migration Reconciliation (ITGC-SD-02)

> **Status:** v1.0 · **Date:** 2026-06-30 · **Owner:** Controller / Eng
> The source→target balance tie-out + sign-off procedure for any data migration or opening-balance load,
> so migrated balances are provably complete and accurate before go-live.

## 1. Why

A migration (legacy system → Invisible ERP, or a tenant onboarding) must not silently drop or distort
balances. This control requires a **documented reconciliation** of source totals to the loaded target,
with an independent **sign-off**, before the migrated entity transacts.

## 2. What the system provides

- **Idempotent opening balances** — `POST /api/ledger/opening-balances` loads opening GL balances keyed by
  a `batch_ref`; re-running the same batch does not double-post (idempotent on `batch_ref`). So a load can
  be safely re-run after a correction (`modules/ledger`, `opening-balances` harness ToE).
- **Trial balance** — `GET /api/ledger/trial-balance` is the target-side total (debits = credits) used for
  the tie-out.
- **Sub-ledger tie-out + trial-balance review are close-control steps** — `modules/ledger/close.service.ts`
  (`subledger_tieout` AR/AP/INV/FA, `trial_balance_review`), each a required, signed step.
- **ETL staging** — `tools/etl` extracts/transforms source data into the load shape.

## 3. Procedure (per migration / opening-balance load)

1. **Source totals.** Capture the source control totals (trial balance, AR/AP aging, inventory valuation,
   fixed-asset NBV) as at the cutover date — the figures to reconcile to.
2. **Load.** Run the opening-balance load with a unique `batch_ref` (idempotent — safe to re-run).
3. **Target totals.** Pull `GET /api/ledger/trial-balance` and the sub-ledger balances for the loaded entity.
4. **Tie-out.** Reconcile source → target line by line; **zero unexplained variance**. Trial balance must
   balance (debits = credits). Reconcile each sub-ledger to its GL control account (`subledger_tieout`).
5. **Investigate & correct.** Any variance is investigated; corrections re-run the load under the same
   `batch_ref` (idempotent) or a documented adjusting entry — then re-tie-out.
6. **Sign-off.** The **Controller (independent of the preparer)** signs off the reconciliation: source
   totals, target totals, variance = 0 (or explained), date, and approves go-live.
7. **Retain evidence.** File the reconciliation worksheet + sign-off in the cutover evidence pack; record
   the `batch_ref` and the trial-balance snapshot.

## 4. Reconciliation worksheet (template)

| Account / sub-ledger | Source total | Target total | Variance | Explanation |
|---|---|---|---|---|
| GL trial balance (Dr = Cr) | `<<>>` | `<<>>` | `<<0>>` | |
| AR control ↔ AR aging | `<<>>` | `<<>>` | `<<0>>` | |
| AP control ↔ AP aging | `<<>>` | `<<>>` | `<<0>>` | |
| Inventory control ↔ valuation | `<<>>` | `<<>>` | `<<0>>` | |
| Fixed assets ↔ NBV register | `<<>>` | `<<>>` | `<<0>>` | |

**Preparer:** `<<name / date>>`  ·  **Reviewer / sign-off (Controller, ≠ preparer):** `<<name / date>>`  ·
**Go-live approved:** `<<yes / date>>`  ·  **batch_ref:** `<<>>`

## 5. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-06-30 | Controller / Eng | Documented source→target tie-out + independent sign-off over the idempotent opening-balance load + close-control tie-out steps (ITGC-SD-02). |
