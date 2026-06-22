# UAT — Cycle 05: General Ledger & Financial Close

**Status: DRAFT v0.1 · 2026-06-22** · Cross-ref: process narrative `04-general-ledger-close.md` (GL-01..06, REC-01..03, R05/R06), harness `tools/cutover/src/compliance.ts`, `worldclass.ts`.

Result legend: Pass / Fail / Blocked / N/A / Not Run. Error codes/amounts are exact.

| Test ID | Scenario/Title | Role | Preconditions | Test steps | Test data | Expected result | Priority | Type | Traceability | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| UAT-GL-001 | Chart of accounts seeded | Admin | COA seeded | 1. `GET /api/ledger/accounts`. | — | ≥9 accounts; includes 3100 Retained Earnings, 1500/1510/1590/5200. | Med | Positive | GL-01 | Not Run | worldclass.ts |
| UAT-GL-002 | Balanced manual JE posts as Draft | GlAccountant | Logged in | 1. `POST /api/ledger/journal` balanced. | `lines:[{1000, debit:1234},{4000, credit:1234}]` | 201; `entry_no` JE-; `status: Draft`, `pending: true`. | High | Control | GL-05 | Not Run | compliance.ts |
| UAT-GL-003 | Draft JE excluded from balances | GlAccountant/Admin | Draft JE from GL-002 | 1. `GET /api/ledger/trial-balance?period=<cur>`. | — | Account 4000 credit = 0 (no impact until approved). | High | Control | GL-05 | Not Run | compliance.ts |
| UAT-GL-004 | Draft JE in pending-approval queue | FinancialController | Draft JE exists | 1. `GET /api/ledger/journal/pending`. | — | The Draft `entry_no` is listed. | Med | Positive | GL-05 | Not Run | compliance.ts |
| UAT-GL-005 | Preparer self-approval blocked (incl. dual-duty) | exec/dual-duty | Self-prepared Draft JE | 1. `POST /api/ledger/journal/{no}/approve` as the preparer. | bearer = preparer | 403 `SOD_VIOLATION`. | High | Control | GL-05, R05 | Not Run | compliance.ts |
| UAT-GL-006 | Independent approver posts JE | FinancialController | Draft JE by GlAccountant | 1. `POST .../{no}/approve` as different user. 2. Re-read trial balance. | bearer fincon | 200 `Posted`; `approved_by: fincon`; 4000 credit now = 1234. | High | Control | GL-05 | Not Run | compliance.ts |
| UAT-GL-007 | Reject JE → Voided, no balance impact | FinancialController | Draft JE | 1. `POST .../{no}/reject` with reason. 2. Check balance. | `{reason: unsupported}` | 200 `Voided`; account credit stays 0. | High | Control | GL-05 | Not Run | compliance.ts |
| UAT-GL-008 | Maker-checker binds even Admin | Admin | Admin-prepared Draft JE | 1. `POST .../{no}/approve` as same Admin. | bearer admin | 403 `SOD_VIOLATION` (no self-approve override). | High | Control | GL-05, R05 | Not Run | compliance.ts |
| UAT-GL-009 | Unbalanced JE rejected | GlAccountant | Logged in | 1. `POST /api/ledger/journal` debit≠credit. | `[{1000, debit:100},{4000, credit:90}]` | 400 `UNBALANCED`. | High | Control | GL-02 | Not Run | worldclass.ts |
| UAT-GL-010 | Trial balance debits = credits | Admin | Postings exist | 1. `GET /api/ledger/trial-balance`. | — | `totals.balanced: true` (debit total = credit total). | Med | Detective | REC-01 | Not Run | worldclass.ts |
| UAT-GL-011 | Close period locks posting | FinancialController | Period to close | 1. `POST /api/ledger/periods/{period}/close`. 2. `POST /api/ledger/journal` into that period. | period `2020-01` | close 200; post → 400 `PERIOD_CLOSED`. | High | Control | GL-04, R06 | Not Run | compliance.ts |
| UAT-GL-012 | Re-open period allows posting | FinancialController | Closed period | 1. `POST /api/ledger/periods/{period}/open`. 2. Post a balanced JE. | — | open ok; subsequent post 200/201. | Med | Positive | GL-04 | Not Run | worldclass.ts |
| UAT-GL-013 | Year-end close moves P&L to retained earnings | FinancialController | FY2025 JE Posted (approved) | 1. `POST /api/ledger/close-year?fiscal_year=2025&tenant_id=T1`. | — | `net_income`≈1000 → JE- to 3100; FY2025 P&L net≈0 after. | High | Positive | GL-06 | Not Run | worldclass.ts |
| UAT-GL-014 | Balance sheet balanced + RE updated | Admin | After year-end close | 1. `GET /api/ledger/balance-sheet?as_of=2025-12-31`. | — | `balanced: true`; `retained_earnings`≈1000. | High | Detective | GL-06 | Not Run | worldclass.ts |
| UAT-GL-015 | Year-end close idempotent | FinancialController | FY2025 already closed | 1. Re-run `close-year` FY2025. | — | `already: true` (no double posting). | Med | Control | GL-06 | Not Run | worldclass.ts |
| UAT-GL-016 | Sub-ledger ↔ GL reconciliation | FinancialController | AR/AP activity | 1. `GET /api/finance/reconciliation`. | — | `ar.reconciled: true` (and AP balanced). | Med | Detective | REC-01 | Not Run | worldclass.ts |
| UAT-GL-017 | Reconciliation prepare → certify | FinancialController | reconciliation available | 1. Prepare reconciliation. 2. Certify (different/authorized user). | `<<period>>` | Prepared then certified; sign-off recorded. | Med | Control | REC-02/03 | Not Run | reconciliation |
| UAT-GL-018 | RLS — tenant cannot see another's GL | Procurement (T2) | T1 JEs exist | 1. `GET /api/ledger/journal?limit=100` as T2. | bearer finT2 | No T1 entries; no T1 4000 credit in trial balance. | High | Control | ITGC-AC (RLS) | Not Run | compliance.ts |
