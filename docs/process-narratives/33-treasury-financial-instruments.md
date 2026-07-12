# Treasury — Financial Instruments (Debt & Borrowings) — Process Narrative

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-33-TRE |
| Process owner | `<<Treasury / Controller>>` |
| Approver | `<<CFO>>` |
| Version | **0.1 DRAFT** |
| Effective date | `<<effective-date>>` |
| Review cadence | Per drawdown / monthly accrual + each covenant cadence |
| Version note | Rev **0.1** (2026-07-12) — Track C Wave 1: Debt & Borrowings register + EIR amortized-cost engine (new controls TRE-01 + TRE-02, migration `0352`). |
| Related RCM controls | TRE-01, TRE-02, GL-05, GL-24, TR-01 |
| Related policy | `compliance/policies/11-financial-close-policy.md` |

## 2. Purpose

Define the controlled process for recording and servicing **borrowings** (bank facilities, term loans) end to
end: setting up a credit **facility** under maker-checker, **drawing down** principal, accruing interest on an
**effective-interest (EIR) amortized-cost** basis, **repaying** principal and interest, monitoring **financial
covenants**, and maintaining a **maturity ladder**. The engine is the reusable spine on which later Track C
waves (investments, hedging) build.

## 3. Scope

- **In scope:** debt facilities, drawdowns, the periodic EIR interest accrual, repayments, covenant tracking +
  breach detection, and the maturity ladder for the debt register. Multi-tenant (RLS), Thai-localized.
- **Out of scope (this wave):** derivative/hedge accounting, marketable-investment fair-value measurement,
  and lender cash-management integrations. Cash *position/forecast* is the existing TR-01 liquidity board.

## 4. References

- IFRS 9 / TFRS 9 — financial liabilities at amortized cost, effective-interest method.
- Chart of accounts: 1010 Bank, 2450 Accrued Interest Payable, 2500 Short-term Borrowings, 2550 Long-term
  Borrowings, 5900 Interest Expense (`apps/api/src/modules/ledger/ledger-constants.ts`).
- Posting-event registry `DEBT.DRAWDOWN` / `DEBT.INTEREST` / `DEBT.REPAY` (`posting-events.ts`, GL-24).
- Permissions/SoD: `packages/shared/src/permissions.ts` (`treasury`, `treasury_approve`, SoD R23).

## 5. Definitions & abbreviations

| Term | Meaning |
|---|---|
| Facility | An approved credit line with a limit, currency, EIR and maturity; principal is drawn against it. |
| Drawdown | A borrowing taken off an approved facility; posts cash in and a borrowings liability. |
| EIR | Effective interest rate — the rate applied to the amortized-cost carrying amount each period. |
| Amortized cost / carrying | The drawdown's outstanding principal at par (reduced by principal repayments). |
| Covenant | A financial condition (e.g. DSCR ≥ 1.25) tested each cadence; a breach is a control finding. |
| Maturity ladder | Outstanding principal bucketed by time-to-maturity (liquidity view). |

## 6. Roles & responsibilities (RACI)

| Activity | Treasury Analyst (`treasury`) | Treasury Manager (`treasury_approve`) | Controller / Exec (`exec`) |
|---|---|---|---|
| Create / maintain facility, drawdown, repay, add covenants | **R** | C | A |
| Approve facility | I | **R** | A |
| Run EIR interest accrual | I | **R** | A |
| Run covenant tests / review breach worklist | C | **R** | A |
| Review debt register, maturity ladder | C | C | **R** |

Segregation of duties is enforced **in-app** (creator ≠ approver → `403 SOD_SELF_APPROVAL`, binding even
Admin) and flagged by **SoD R23** (`treasury` vs `treasury_approve`). Roles **TreasuryAnalyst** (maker) and
**TreasuryManager** (checker) are SoD-clean.

## 7. Process narrative

1. **Facility setup (maker).** `POST /api/treasury/facilities` records a facility (`name`, `lender`,
   `currency`, `facility_type` short-/long-term, `limit_amount`, `eir_pct`, `start_date`, `maturity_date`)
   as **PendingApproval**. `limit_amount` must be > 0 (`BAD_LIMIT`).
2. **Approval (checker).** A **different** user `POST .../:id/approve` → **Approved**. The creator approving
   their own facility is rejected `403 SOD_SELF_APPROVAL`. `POST .../:id/reject` rejects a pending facility.
3. **Drawdown.** Only an **Approved** facility may be drawn (`FACILITY_NOT_APPROVED` otherwise).
   `POST .../:id/drawdown` checks the amount against the available limit (`LIMIT_EXCEEDED`) and posts
   **Dr 1010 Bank / Cr 2500** (short-term) **or 2550** (long-term) **Borrowings** via `LedgerService.postEntry`
   (so period-lock + the GL audit trail apply). It stamps the drawdown's amortized-cost carrying amount
   (= principal) and a periodic cursor (`next_run_date` = one month out, `periods_posted` = 0).
4. **EIR interest accrual (checker, idempotent).** `POST .../:id/accrue` posts one month of effective
   interest = `round2(carrying × EIR/100/12)` per due drawdown — **Dr 5900 Interest Expense / Cr 2450 Accrued
   Interest Payable** — and advances the cursor a month. It is **idempotent**: the cursor moves per run and
   `alreadyPosted('DEBT-ACCR', drawdown+period)` guards the JE, so re-running the same `as_of` posts nothing.
   This mirrors the lease interest-unwind (LSE-01).
5. **Repayment.** `POST .../:id/repay` clears principal (**Dr 2500/2550**) and accrued interest (**Dr 2450**)
   against cash (**Cr 1010**). Guards: `REPAY_EXCEEDS_PRINCIPAL`, `REPAY_EXCEEDS_INTEREST`,
   `NOTHING_TO_REPAY`. A fully-repaid drawdown flips to `repaid`; the facility's `outstanding_principal` falls.
6. **Maturity ladder.** `GET .../maturity-ladder` buckets each facility's outstanding principal by
   time-to-maturity (0-30d / 31-90d / 91-180d / 181-365d / >365d) from an `as_of` date.
7. **Covenant tracking + breach detection (TRE-02).** `POST .../:id/covenants` defines a covenant (`metric`,
   `operator` gte/lte/gt/lt, `threshold`, `cadence`). `POST /api/treasury/covenants/test` evaluates each
   supplied reading against its threshold/operator, **persists** a `debt_covenant_tests` row with a `breached`
   flag, and returns the breaches. `GET /api/treasury/covenants/breaches` is the outstanding-breach worklist
   the controller reviews each cadence — recording the breach **is** the detective control.

## 8. Process flow

```mermaid
flowchart TD
  A[Analyst: create facility] -->|PendingApproval| B{Manager approves?}
  B -->|self-approve| X[403 SOD_SELF_APPROVAL]
  B -->|distinct approver| C[Approved]
  C --> D[Drawdown  Dr 1010 / Cr 2500|2550]
  D -->|over limit| L[400 LIMIT_EXCEEDED]
  D --> E[Amortized-cost carrying + cursor]
  E --> F[Monthly EIR accrual  Dr 5900 / Cr 2450]
  F -->|re-run same period| F2[idempotent: posts 0]
  F --> G[Repay  Dr 2500/2550 + 2450 / Cr 1010]
  C --> H[Define covenant]
  H --> I[Covenant test]
  I -->|pass| I1[record: not breached]
  I -->|fail| I2[record breached -> breach worklist]
  C --> J[Maturity ladder]
```

## 9. Control matrix

| Control | Type | Assertion(s) | Description | Test of operating effectiveness |
|---|---|---|---|---|
| **TRE-01** | Application (Preventive) | Authorization / Accuracy / Valuation / Completeness / SoD | Debt facility + drawdown maker-checker (creator ≠ approver → `SOD_SELF_APPROVAL`), drawdown limit gate, correct Dr 1010 / Cr 2500\|2550 posting, and an **idempotent EIR amortized-cost accrual** (carrying × EIR/12 → Dr 5900 / Cr 2450). | `treasury-debt` harness (36 checks): create→self-approve blocked→distinct approver; drawdown GL + `LIMIT_EXCEEDED`; EIR schedule ties a hand-computed amortization table; re-accrue same period idempotent; repayment legs + `REPAY_EXCEEDS_PRINCIPAL`; RLS isolation. |
| **TRE-02** | Detective | Completeness / Timeliness | Covenant tracking + breach detection: a covenant test persists a `debt_covenant_tests` reading with a `breached` flag and surfaces outstanding breaches on a worklist for periodic controller review. | `treasury-debt` harness: DSCR ≥ 1.25 passes at 1.40, breaches at 1.10 (persisted), the worklist surfaces the breach; tenant isolation. |

Related: **GL-05** (all postings route through the ledger's balanced/period-locked posting), **GL-24**
(posting-event registry), **TR-01** (the cash-position/forecast board reads the same posted GL).

## 10. Inputs & outputs

- **Inputs:** facility terms (limit, EIR, maturity), drawdown/repayment amounts, covenant readings.
- **Outputs:** the debt register (facilities + drawdowns), the DEBT-DRAW / DEBT-ACCR / DEBT-REPAY journal
  entries, the maturity ladder, and the covenant-test / breach records.

## 11. Records & retention

`debt_facilities`, `debt_drawdowns`, `debt_covenants`, `debt_covenant_tests` (tenant-scoped, RLS) + the
underlying GL journal entries (append-only audit trail). Retained per the financial-records retention policy.

## 12. KPIs / metrics

Total outstanding borrowings, weighted-average EIR, interest expense per period, maturity-ladder profile,
covenant headroom, and count/ageing of outstanding covenant breaches.

## 13. Exception & error handling

`BAD_LIMIT`, `NOT_PENDING`, `SOD_SELF_APPROVAL`, `FACILITY_NOT_APPROVED`, `LIMIT_EXCEEDED`, `BAD_AMOUNT`,
`NOTHING_TO_REPAY`, `NO_ACTIVE_DRAWDOWN`, `REPAY_EXCEEDS_PRINCIPAL`, `REPAY_EXCEEDS_INTEREST`,
`FACILITY_NOT_FOUND`, `COVENANT_NOT_FOUND`. All surface as `json.error.code` (wrapped by `AllExceptionsFilter`).

## 14. Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-07-12 | Treasury / Controller | Initial narrative — TRE-01 debt & borrowings register + EIR amortized-cost engine, TRE-02 covenant-breach monitor (migration 0352). |
