# UAT — Cycle 17: Treasury — Debt & Borrowings (TRE-01 / TRE-02)

**Status: DRAFT v0.1 · 2026-07-12** · *v0.1: Track C Wave 1 — Debt & Borrowings register + EIR amortized-cost engine (new controls **TRE-01** application maker-checker + idempotent EIR accrual, **TRE-02** detective covenant-breach monitor; migration `0352`). Facility create→approve maker-checker (`SOD_SELF_APPROVAL`, SoD R23), drawdown Dr 1010 / Cr 2500|2550 with a `LIMIT_EXCEEDED` gate, an idempotent effective-interest accrual (carrying × EIR/12 → Dr 5900 / Cr 2450), repayment, a maturity ladder, and covenant tracking + breach detection. Cases UAT-TRE-011..016 (TRE-01) + UAT-TRE-021..022 (TRE-02); ToE `treasury-debt` (36 checks). Cross-ref: process narrative `33-treasury-financial-instruments.md`, harness `tools/cutover/src/treasury-debt.ts`.*

Result legend: Pass / Fail / Blocked / N/A / Not Run. All amounts THB. Error codes are exact and surface as `json.error.code`.

New duties: `treasury` (maker — maintain facilities, drawdown/repay, covenants, read) · `treasury_approve` (checker — approve facilities, run EIR accrual, run covenant tests). Roles: **TreasuryAnalyst** (`treasury`, `fin_report`) · **TreasuryManager** (`treasury_approve`, `fin_report`). SoD **R23**: `treasury` vs `treasury_approve`.

## §5 — Debt facility, drawdown, EIR accrual, repayment, maturity ladder (TRE-01)

| Test ID | Scenario/Title | Role | Preconditions | Test steps | Test data | Expected result | Priority | Type | Traceability | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| UAT-TRE-011 | Facility create → maker-checker approve | TreasuryAnalyst / TreasuryManager (Admin in ToE) | — | 1. `POST /api/treasury/facilities`. 2. Same user `POST .../:id/approve`. 3. Different user `POST .../:id/approve`. | `{name:'Term Loan A', facility_type:'long_term', limit_amount:1000000, eir_pct:12, start_date:'2026-01-01', maturity_date:'2026-12-31'}` | (1) 200, `status:PendingApproval`. (2) **403** `SOD_SELF_APPROVAL` (creator ≠ approver). (3) 200, `status:Approved`, `approved_by` = the checker. | High | Control | TRE-01, R23 | Not Run | treasury-debt.ts |
| UAT-TRE-012 | Drawdown posts to the borrowings control | TreasuryAnalyst | Facility approved | 1. `POST .../:id/drawdown` before approval (negative). 2. After approval `POST .../:id/drawdown`. 3. `POST .../:id/drawdown` beyond available limit. | (2) `{principal:600000, drawdown_date:'2026-01-01'}` (3) `{principal:500000}` | (1) **400** `FACILITY_NOT_APPROVED`. (2) 200; carrying `amortized_cost`=600000; JE Dr 1010 Bank 600000 / Cr **2550** Long-term Borrowings 600000 (balanced). (3) **400** `LIMIT_EXCEEDED` (600000 drawn, only 400000 available). | High | Positive/Control | TRE-01 | Not Run | treasury-debt.ts |
| UAT-TRE-013 | Idempotent EIR amortized-cost accrual | TreasuryManager | Drawdown 600000 @ EIR 12% (1%/mo) | 1. `POST .../:id/accrue` `{as_of:'2026-02-01'}`. 2. Re-run same `as_of`. 3. `POST .../:id/accrue` `{as_of:'2026-03-01'}`. | — | (1) `posted:1`, interest 6000; JE Dr 5900 Interest Expense 6000 / Cr 2450 Accrued Interest Payable 6000. (2) `posted:0` (idempotent — cursor moved + `alreadyPosted` guard); 5900 unchanged (6000). (3) `posted:1`, interest 6000; two periods total 5900 = 12000, drawdown `accrued_interest`=12000, `periods_posted`=2. | High | Control | TRE-01 | Not Run | treasury-debt.ts |
| UAT-TRE-014 | Repayment clears principal + interest | TreasuryAnalyst | Drawdown carrying 600000, accrued 12000 | 1. `POST .../:id/repay` `{principal:100000, interest:12000, date:'2026-03-05'}`. 2. `POST .../:id/repay` `{principal:900000}`. | — | (1) 200, `remaining_principal`=500000; JE Dr **2550** 100000 + Dr 2450 12000 / Cr 1010 Bank 112000; facility `outstanding_principal`=500000. (2) **400** `REPAY_EXCEEDS_PRINCIPAL`. | High | Positive/Control | TRE-01 | Not Run | treasury-debt.ts |
| UAT-TRE-015 | Maturity ladder buckets outstanding | TreasuryAnalyst / fin_report | Facility with 500000 outstanding, matures 2026-12-31 | 1. `GET /api/treasury/facilities/maturity-ladder?as_of=2026-06-01`. | — | `total_outstanding`=500000; the 500000 falls in the **181-365d** bucket (≈213 days to 2026-12-31). | Med | Positive | TRE-01 | Not Run | treasury-debt.ts |
| UAT-TRE-016 | Permission gate + maker/checker split | Buyer / TreasuryAnalyst | Buyer (no treasury), TreasuryAnalyst (maker only) | 1. Buyer `POST /api/treasury/facilities`. 2. TreasuryAnalyst `POST /api/treasury/facilities`. 3. TreasuryAnalyst `POST .../:id/approve`. | — | (1) **403** (no `treasury`). (2) 200 `PendingApproval` (has `treasury`). (3) **403** (lacks `treasury_approve` — the checker duty). | High | Control | TRE-01, R23 | Not Run | treasury-debt.ts |

## §6 — Covenant tracking + breach detection (TRE-02)

| Test ID | Scenario/Title | Role | Preconditions | Test steps | Test data | Expected result | Priority | Type | Traceability | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| UAT-TRE-021 | Covenant test — pass then breach | TreasuryAnalyst / TreasuryManager | Facility approved | 1. `POST .../:id/covenants`. 2. `POST /api/treasury/covenants/test` value 1.40. 3. Same, value 1.10. 4. `GET /api/treasury/covenants/breaches`. | `{name:'DSCR floor', metric:'DSCR', operator:'gte', threshold:1.25}` | (1) 200. (2) `breached:0` (1.40 ≥ 1.25). (3) `breached:1`, a `debt_covenant_tests` row persisted with `breached=true`. (4) worklist `count:1`, the outstanding DSCR breach (actual 1.10 < 1.25). | High | Positive/Control | TRE-02 | Not Run | treasury-debt.ts |
| UAT-TRE-022 | Register + covenants tenant-isolated (RLS) | Admin (sibling tenant) | HQ facilities/covenants exist; sibling tenant HQ2 | 1. HQ2 `GET /api/treasury/facilities`. 2. HQ2 `GET /api/treasury/covenants`. 3. HQ `GET /api/treasury/facilities`. | — | (1) `count:0`. (2) `count:0`. (3) HQ sees its own facilities (incl. Term Loan A). | High | Control | TRE-01, TRE-02 | Not Run | treasury-debt.ts |

## Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| v0.1 | 2026-07-12 | Treasury / Controller | Initial UAT — TRE-01 debt & borrowings register + EIR engine, TRE-02 covenant-breach monitor (migration 0352). |
