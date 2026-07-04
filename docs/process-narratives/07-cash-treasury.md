# Cash & Treasury (POS Till · Payments · Bank Reconciliation) — Process Narrative

## 1. Document control

| Field | Value |
|---|---|
| Process ID | PN-07-CASH |
| Process owner | `<<Controller / Store Operations>>` |
| Approver | `<<CFO>>` |
| Version | **0.1 DRAFT** |
| Effective date | `<<effective-date>>` |
| Review cadence | Per shift (till) + monthly (bank rec) + annual |
| Related RCM controls | REV-02, REV-03, REV-05, REV-06, REV-09, REV-11, REV-13, REV-16, REC-02, REC-05, BANK-02, EXP-07, EXP-08; SoD R08, R07 |
| Related policy | `compliance/policies/11-financial-close-policy.md`, `compliance/policies/03-delegation-of-authority.md` |

## 2. Purpose

To control cash and electronic settlement — POS till open/close, payment capture and refunds, PSP webhooks/settlement, and bank reconciliation — so that **all cash collected is recorded, drawer variances are detected, refunds cannot exceed captures, electronic callbacks are authentic, and bank balances are reconciled to the GL**.

## 3. Scope

**In scope:** till open / close with Z-report variance, payment tender capture (PAY-), refunds (REF-) with over-refund guard, payment idempotency, PSP webhook verification (HMAC), settlement batching/reconciliation, and bank reconciliation against statements.

**Out of scope:** revenue recognition and AR (see `01-order-to-cash.md`), supplier disbursement approval (see `02-procure-to-pay.md`), GL period close (see `04-general-ledger-close.md`).

## 4. References

- ISO 9001:2015 cl. 4.4, cl. 8.5.1, cl. 9.1.
- `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx` — REV-02/03/05/06/09/11, REC-02.
- `compliance/policies/03-delegation-of-authority.md` (refund/void authority).
- Code: `apps/api/src/modules/payments/payments.service.ts`, `apps/api/src/modules/pos/terminal/`, `apps/api/src/modules/bank/`, `apps/api/src/common/crypto.ts`.

## 5. Definitions & abbreviations

| Term | Meaning |
|---|---|
| Till / drawer | Cash session with opening float |
| X-report / Z-report | Mid-shift / end-of-shift till summary |
| Variance | Counted cash − expected cash at close |
| Idempotency key | De-duplication token for tender |
| PSP webhook | Gateway callback (HMAC-SHA256 signed) |
| Settlement | Batch of payment intents reconciled to PSP payout |
| RCP- / PAY- / REF- | Receipt / payment / refund document prefixes |

## 6. Roles & responsibilities (RACI)

SoD rule **R08**: the **Cashier** who records sales/tender is never the role that **issues refunds or reconciles the till** (PosSupervisor) — `pos_sell`, `pos_refund`, and `pos_till` are split single-duty permissions.

| Activity | Cashier | PosSupervisor | ArClerk | FinancialController | Controller |
|---|---|---|---|---|---|
| Open till (opening float) | **A/R** | C | I | I | I |
| Capture payment / tender (`pos_sell`) | **A/R** | I | I | I | I |
| Issue refund (`pos_refund`) | I | **A/R** | I | I | C |
| Close till + Z-report (`pos_till`) | I | **A/R** | I | C | A |
| Review till variance | I | C | I | **A/R** | A |
| PSP settlement reconciliation | I | I | C | **A/R** | A |
| Bank reconciliation | I | I | C | **A/R** | A |

## 7. Process narrative

1. **Till open.** Cashier opens a till session recording the opening float (`POST /api/payments/till/open`).
2. **Payment capture.** Tender is recorded (PAY-). The payment row is persisted **Pending before** the gateway capture and flipped **Failed** on error — captured funds are never unrecorded (**REV-03**). For card/e-wallet tenders the gateway performs a **real PSP charge** (Opn/Omise, Stripe) using the terminal-supplied token (satang minor-units, secret-key auth); a tender with **no token or a declined charge is never reported Captured**, so funds that did not move are never booked. A **decline is recorded as a durable `Failed` tender** (committed with the decline reason, returned to the caller — not a rolled-back error), so every card attempt leaves an audit trail. A repeated `idempotency_key` returns the original tender (unique-index backstop), so exactly one PSP charge occurs on retry (**REV-02**).
3. **PSP webhook (decision point).** For card/e-wallet, the gateway callback is verified by HMAC-SHA256 over the raw body, **fail-closed in production**; a forged/replayed signature → `401`; status is re-verified out-of-band before a payment is treated as captured (**REV-09**).
4. **Refund (decision point).** PosSupervisor issues a refund (REF-) only when refund + all prior refunds ≤ captured, evaluated under a payment-row lock (`FOR UPDATE`); an over-refund → `OVER_REFUND`; a refund of a non-captured payment → `NOT_REFUNDABLE` (**REV-06**). Refund authority is separated from selling (**R08**). **Large-refund maker-checker (REV-16):** a **standalone** refund (`POST /api/payments/refunds`) at/above the materiality threshold (THB 1,000) is parked as a **request** (`refund_requests`) and **moves no money** — no `payment_refunds` row, the payment isn't flipped — until a **different** user approves it (`POST /api/payments/refund-requests/:id/approve`); self-approval → `SOD_VIOLATION`, reject voids it. Sub-threshold refunds run immediately, and a refund that is part of a **goods-return** is never gated (the return is the authorizing document, **REV-07**). The pending request auto-surfaces in the **GOV-01** pending-approvals monitor with an inline approve/reject on `/approvals`. This stops one person issuing a large refund to themselves/an accomplice (refund fraud).
5. **Till close (decision point).** At shift end PosSupervisor closes the till (`POST /api/payments/till/close`): expected cash = opening float + Σ cash captured; variance = counted − expected; the Z-report records the variance and denominations (**REV-05**). The over/short is now **posted to GL** so book-cash tracks the physical count — short → **Dr 5830 Cash Over/Short / Cr 1000 Cash**, over → **Dr 1000 / Cr 5830** (idempotent per till, `source=TILL_CLOSE`). A variance **at/above the materiality threshold (THB 100)** posts the over/short as a **Draft** JE and parks the session **PendingApproval**: a **different** user (manager) must approve it (`POST /api/payments/till/variance/:sessionNo/approve`) before it is effective — self-approval → `SOD_VIOLATION` (binds even Admin); reject voids the draft. Sub-threshold variances post immediately. The till still **closes** either way (the cash has physically left the drawer); only the GL clearing of a **material** discrepancy is gated (**REV-13**). FinancialController reviews and the supervisor signs the Z-report.
6. **Settlement reconciliation.** Card/e-wallet payment intents are batched into a settlement and reconciled to the PSP payout statement (**REV-11**).
7. **Bank reconciliation.** Bank balances are reconciled against statements monthly and reviewed; differences are cleared (**REC-02**; feeds the GL close, `04-general-ledger-close.md`). Auto-match and the reconciliation report scope the GL cash movements to **the bank account's own tenant** — the cash GL (e.g. 1010) is shared across tenants, so without this an HQ/Admin caller (whose request bypasses RLS) would pull another tenant's movements into the balance/match set (**REC-02**, **ITGC-AC-03**). A fee/interest **adjustment** found on a statement line is **maker-checked**: it is a REQUEST that posts a **Draft** JE with no GL/balance effect (the line stays unreconciled) until a **different** user with approval authority approves it (`POST /api/bank/lines/:id/adjustment/approve`); self-approval is rejected `403 SOD_VIOLATION` (binds even Admin), and the reconciliation difference only closes once approved — so a single person can no longer post a bank fee straight to the cash account (a cash outflow mis-booked as interest income, or a fictitious fee). The Draft adjustment is also surfaced, aged, by the pending-approvals monitor (**BANK-02**, **GOV-01**).

8. **Cash banking — safe-drop → bank deposit → reconciliation (decision point — REC-05).** Through the shift a cashier moves cash out of the drawer to the safe with a **drop** (`cash-movement` type `drop` — drawer-only, no GL). Treasury later **banks** the safe cash: `GET /api/bank/deposits/undeposited-drops` shows the **cash still in the safe** (drops with `deposit_id` NULL — the unbanked exposure to chase), and `POST /api/bank/deposits` **batches** those drops into a deposit, posting **Dr <bank account GL, e.g. 1010> / Cr 1000 Cash** and stamping each banked drop with the deposit id (so it leaves the exposure list). The deposit is then **reconciled** to the bank statement (`POST /api/bank/deposits/:id/reconcile`, status Deposited→Reconciled). **SoD:** banking is a **treasury** duty (`exec`/`ar`) — **segregated from the cashier** (`pos_till`) who drops the cash; a cashier cannot create a deposit (403). So cash physically removed from the drawer is tracked all the way to the bank, the on-hand→bank move hits the GL, and undeposited cash in the safe is a visible control exposure (**REC-05**).

9. **Petty cash / employee cash advances (decision point).** A cash float is issued to an employee via `POST /api/finance/advances` (doc prefix **ADV-**): cash out **Dr 1180 Employee Advances / Cr 1000**. The **1180 balance is the outstanding float** (`GET /api/finance/advances` reports it). On return the advance is **settled** (`POST /api/finance/advances/:advanceNo/settle`) against actual spend + returned cash — **Dr expense + Dr 1000 (returned) / Cr 1180** — which **must reconcile** to the advance (`settled_expense + returned_cash` = advance, else `SETTLE_MISMATCH`); a re-settle → `ALREADY_SETTLED`. So every advance is either outstanding on 1180 or fully accounted for (**EXP-07**, **GL-01**).
11. **Petty-cash imprest fund + direct-expense / advance maker-checker (decision point — EXP-08).** A **petty-cash fund** holds cash capped at a **credit limit (วงเงิน)** in the **1015 Petty Cash** account (a cash account, so it flows through the SCF + bank/cash reconciliation). The fund is established (`POST /api/finance/petty-cash/funds`, **Dr 1015 / Cr 1000** up to the float) and topped back up by replenishment (`…/funds/:code/replenish`); establishing or replenishing above the float → `OVER_FLOAT`. A **direct expense** or an **advance** is drawn against the fund as a maker-checker **request** (`POST /api/finance/petty-cash/requests`, doc prefix **PEX-**, capturing a document reference + receipt key for tracking) that posts **nothing** and a draw beyond the fund's available balance is rejected `INSUFFICIENT_FLOAT`. A **different** user must approve (`…/requests/:reqNo/approve`) before the GL posts — **expense: Dr <expense acct> / Cr 1015; advance: Dr 1180 / Cr 1015** — and the fund balance is decremented; a self-approve is rejected `SOD_VIOLATION` (binds **even Admin**). An **advance** later settles (`…/requests/:reqNo/settle`, **Dr expense + Dr 1015 returned / Cr 1180**, reconcile-or-`SETTLE_MISMATCH`), returning unused cash to the fund. Every request flows PendingApproval → Approved/Rejected → Settled with a StatusLog trail and surfaces in the **GOV-01** pending-approvals monitor — so one person can never both disburse petty cash and authorise it, and the float can never be over-drawn or over-extended (**EXP-08**, **R07**, **GL-01**). **LINE chat channel (LC-2, docs/30 — raise + notify only):** a linked staff member holding `creditors`/`exec` may RAISE a request from the shop's LINE OA chat (`expense <fund> <amount> [เหตุผล]` / `advance …`) — the command re-resolves effective permissions and calls the same `createRequest` path (PEX-, PendingApproval, no GL; `FUND_CLOSED`/`INSUFFICIENT_FLOAT` bind unchanged). Linked `creditors`/`exec` holders (maker excluded) get a LINE push when a request lands, and the requester gets the ✅/❌ decision push — but the **decision itself stays on `/petty-cash`**: chat approval of money requests is deliberately deferred pending a controls review (the maker-checker approval surface is unchanged).
8. **Reconciliation periods & certification (decision point).** The structured reconciliation workflow lives under `/api/recon` (`apps/api/src/modules/reconciliation/`): `GET /api/recon/periods` and `POST /api/recon/periods` list/create reconciliation periods; `GET /api/recon/periods/:id/summary` returns the period state; `POST /api/recon/periods/:id/import-gl` pulls the GL movements to be reconciled; `POST /api/recon/periods/:id/items` adds statement/manual items; `POST /api/recon/periods/:id/auto-match` clears matched pairs; and `POST /api/recon/periods/:id/certify` signs off the period. Certification enforces **maker-checker** — the certifier must differ from the preparer, else the call is rejected `403 SOD_VIOLATION` ("Certifier must be different from preparer (SoD)") — so the person who prepares a reconciliation cannot also certify it (**REC-02/03**; feeds the GL close, `04-general-ledger-close.md`).

10. **Working-capital health score (advisory; reporting only — no GL).** `GET /api/finance/health` returns a single, explainable **financial-health score** (0–100, grade A–E) of how comfortable the merchant's liquidity is, from real sub-ledgers: **cash on hand** (posted balance of the cash/bank GL accounts 1000/1010/1020), **AR vs AP** outstanding, **overdue receivables**, and the **POS sales run-rate** (28-day average). It exposes every driver — **days-cash-on-hand**, **current ratio**, **overdue-AR %** — and weights liquidity 0.6 / receivables 0.4. This is the position **score** a financing partner would underwrite against; the week-by-week cash **projection** lives in the GL module (`GET /api/ledger/cash-flow-forecast`, GL-07) — the two are complementary, not duplicative. Also exposed to the **AI assistant** (`get_financial_health`) so staff can ask "สุขภาพการเงินเป็นยังไง?". Read-only; no postings. Harness `financial-health.ts`; UAT-GL-030.

## 8. Process flow

```mermaid
flowchart TD
    A[Cashier opens till + float] --> B[Capture tender PAY-]
    B --> C{Repeat idempotency key? REV-02}
    C -- "Yes" --> C1[Return original tender - no double charge]
    C -- "No" --> D[Persist Pending then capture; Failed on error REV-03]
    D --> E{Card/e-wallet PSP callback?}
    E -- "Yes" --> F{HMAC valid + prod fail-closed? REV-09}
    F -- "No" --> F1[Reject 401 forged/replay]
    F -- "Yes" --> G[Mark captured after out-of-band re-verify]
    E -- "No (cash)" --> G
    G --> H{Refund requested?}
    H -- "Yes" --> I{refund+prior <= captured? FOR UPDATE REV-06}
    I -- "No" --> I1[Reject OVER_REFUND / NOT_REFUNDABLE]
    I -- "Yes" --> J[Issue refund REF- by PosSupervisor R08]
    H -- "No" --> K[Close till: variance + Z-report REV-05]
    J --> K
    K --> L[Settlement reconcile to PSP payout REV-11]
    L --> M[Bank reconciliation vs statements REC-02]
```

**Swimlane description by role:** **Cashier** opens the till and captures tender (sell only). The **system** enforces idempotency, pre-persist capture, HMAC webhook verification, and the over-refund lock. **PosSupervisor** issues refunds and closes the till (segregated from selling, **R08**). **FinancialController** reviews till variances, settlement reconciliation, and the monthly bank reconciliation.

## 9. Control matrix

| Step | Risk | Control | Type | RCM ID | Evidence / Record |
|---|---|---|---|---|---|
| 2 | Double charge on retry | Payment idempotency key + unique index | Prev / Auto | REV-02 | Idempotency test |
| 2 | Captured funds unrecorded (orphan), or funds booked that did not move | Persist Pending before capture; **real PSP charge** for card/e-wallet — no Captured without an actual charge; a decline lands a **durable Failed tender** (audit trail) | Prev / Auto | REV-03 | Negative-path + `payments-gateway` harness (decline → durable Failed, never Captured) |
| 3 | Forged/replayed PSP callback | HMAC-SHA256 verify, fail-closed in prod | Prev / Auto | REV-09 | Webhook signature tests; 401s |
| 4 | Refund exceeds capture (leakage/fraud) | Over-refund guard under payment-row lock | Prev / Auto | REV-06 | `OVER_REFUND` test |
| 4 | Large refund issued with no independent review (refund fraud) | Maker-checker: a standalone refund ≥ THB 1,000 is a request that **moves no money** until a **different** user approves (self-approve → `SOD_VIOLATION`); goods-return refunds + sub-threshold run immediately; surfaces in GOV-01 | Prev / Auto | REV-16 | `refund_requests` worklist + SoD test |
| 4 | Cashier refunds own sale | SoD: `pos_sell` vs `pos_refund`/`pos_till` | Prev / Manual | R08 | SoD conflict report |
| 5 | Drawer shortage / skimming undetected | Till reconciliation; Z-report variance review | Det / Hybrid | REV-05 | Signed Z-reports |
| 5 | Cash over/short never booked, or cashier clears own material variance | On close the over/short posts to GL (5830↔1000); a material variance posts a **Draft** JE + **PendingApproval** — a **different** user approves (SoD, binds Admin) | Prev+Det / Auto | REV-13 | Cash over/short JEs; till variance approval trail |
| 6 | Card settlements not reconciled to payouts | Settlement batching + reconcile | Det / Hybrid | REV-11 | Settlement recon |
| 8 | Till cash dropped to the safe never banked / not matched to statement | Safe-drop → bank deposit (Dr bank / Cr 1000) + reconcile; undeposited-drop "cash-in-safe" exposure; banking (treasury) segregated from the cashier (`pos_till`) | Det / Prev | REC-05 | Bank-deposit register; cash-in-safe exposure |
| 7 | Bank balance not reconciled to GL | Bank reconciliation vs statements | Det / Hybrid | REC-02 | Bank rec |
| 7 | A bank fee/interest adjustment posted straight to the cash GL by one person (outflow mis-booked as income / fictitious fee) | **Bank adjustment maker-checker** — adjustment is a Draft JE (no balance effect) until a different user approves; self-approve → `SOD_VIOLATION` (binds Admin) | **Prev / Auto** | **BANK-02** | `bankrec` harness; `SOD_VIOLATION` |
| 9 | Advance issued but never accounted for | Issue Dr 1180 / settle reconciled (`SETTLE_MISMATCH`); 1180 is the outstanding float | Det / Auto | EXP-07 | Advance register; outstanding float |
| 11 | Petty cash disbursed without independent review or beyond the fund limit (leakage, unauthorised/over-drawn float) | **Imprest float + maker-checker**: fund capped at a credit limit (1015); each expense/advance is a request a *different* user must approve before GL posts + fund decrements (self-approve → `SOD_VIOLATION`); over-balance draw → `INSUFFICIENT_FLOAT`; over-limit fund/replenish → `OVER_FLOAT`; document ref + receipt tracked; surfaces in GOV-01 | **Prev / Auto** | **EXP-08**, R07 | Fund register + disbursement approval log + SoD test |

## 10. Inputs & outputs

**Inputs:** opening float, tender requests, PSP callbacks, refund requests, PSP payout statements, bank statements.
**Outputs:** till sessions, payments (PAY-), refunds (REF-), X/Z-reports, settlement batches, bank reconciliations.

## 11. Records & retention

| Record | Store | Retention |
|---|---|---|
| Till sessions + Z-reports | Application DB (RLS-scoped) | `<<7 years>>` |
| Payments / refunds | Application DB | `<<7 years>>` |
| PSP webhook + settlement records | Application DB | `<<7 years>>` |
| Bank reconciliations | `bank` module | `<<7 years>>` |
| Mutation audit trail | `audit_log` | `<<7 years>>` |

## 12. KPIs / metrics

- Till variance per shift (count and value of variances > `<<threshold>>`).
- Over-refund attempts blocked (`OVER_REFUND`).
- Forged/invalid webhook rejections.
- Settlement / bank reconciliation differences cleared on time (target: 0 open).

## 13. Exception & error handling

| Error code | Trigger | Handling |
|---|---|---|
| `OVER_REFUND` | Refund + priors > captured | Refund denied; PosSupervisor review |
| `NOT_REFUNDABLE` | Refund vs non-captured payment | Verify payment status |
| `401` webhook | Forged/replayed PSP signature | Reject; alert; re-verify out of band |
| Till variance | Counted ≠ expected | Over/short posts to GL (5830↔1000); FinancialController reviews; investigate per DoA |
| `SOD_VIOLATION` | Cashier approves own material cash variance | Approve/reject must be a different user (manager) |
| `NOT_PENDING` | Variance approve/reject when none pending (or already settled) | No action; confirm the variance state |
| Unreconciled item | Bank/settlement difference | Investigate and clear before close |

## 14. Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 0.2 | 2026-07-03 | Platform | **Project-linked site cash cross-reference (docs/32 M4, PROJ-14).** Employee advances (and petty-cash) can carry an optional `project_code` → `project_id` (migration 0241 adds the column; `PROJECT_NOT_FOUND` on a bad code); the advance/expense GL lines are tagged with `project_id` so the spend is traceable to the project and rolled up on `GET /api/projects/:code/site-cash`. Additive/nullable — no change to the advance issue/settle flow or its maker-checker. Full control **PROJ-14** owned by `16-project-accounting.md` §7 step 28. |
| 0.1 DRAFT | 2026-06-22 | `<<author>>` | Initial draft. |
| 0.2 | 2026-06-23 | Platform | Security review W2 (REC-02 / ITGC-AC-03): bank auto-match + reconciliation now scope GL cash movements to the bank account's tenant (shared 1010 GL no longer leaks across tenants under an Admin/bypass caller). Verified by the `bankrec` harness cross-tenant case. |
| 0.3 | 2026-06-23 | Platform | Documented the `/api/recon` reconciliation-period API (7 endpoints) and the period-certify maker-checker control (certifier ≠ preparer, `SOD_VIOLATION`) in §7. |
| 0.4 | 2026-06-24 | Platform | Card/e-wallet tenders now make a **real PSP charge** (Opn/Omise, Stripe) on the tender path — the prior stub gateways that returned a synthetic `Captured` are replaced; a no-token or declined charge is never reported Captured. A decline now records a **durable `Failed` tender** (committed with the reason + returned, instead of a rolled-back error). Threaded the terminal `token` through `recordTender`. New `payments-gateway` harness (fetch-stubbed PSP). Updated step 2 + REV-03 control. |
| 0.5 DRAFT | 2026-06-25 | `<<author>>` | Added step 9 — **petty cash / employee cash advances** (`/api/finance/advances`): issue Dr 1180 / Cr 1000, settle reconciled against spend + returned cash (`SETTLE_MISMATCH` guard); 1180 is the outstanding float. New control **EXP-07**. Verified by the `basics` harness. |
| 0.6 | 2026-06-26 | Platform | **BANK-02 — bank adjustment maker-checker.** Step 7: a statement-line fee/interest adjustment is now a REQUEST that posts a **Draft** JE (no balance effect; line stays unreconciled) until a **different** user approves (`POST /api/bank/lines/:id/adjustment/approve`, gated `approvals`/`gl_close`); self-approval → `403 SOD_VIOLATION` (binds Admin); reject voids the Draft. `bank.service.ts` `requestAdjustment`/`approveAdjustment`/`rejectAdjustment`/`listPendingAdjustments` (reuses `ledger.approveEntry`). New RCM control **BANK-02** (RCM now 86); control matrix gains a step-7 preventive row; also surfaced by the pending-approvals monitor (GOV-01). No migration (reuses the line's `adjustment_journal_no` as the pending link). ToE: `bankrec` (request → Draft excluded from GL, self-approve blocked, independent approve closes the difference). |
| 0.6 | 2026-06-25 | Platform | **Working-capital health score (advisory; reporting only — no GL):** new §7 step 10 — `GET /api/finance/health` scores liquidity (0–100, A–E) from cash on hand (GL 1000/1010/1020) + AR/AP outstanding + overdue-AR % + the POS run-rate, exposing days-cash-on-hand / current ratio / driver breakdown. Complements (does not duplicate) the GL module's week-by-week `cash-flow-forecast` (GL-07). Web page `/financial-health`; AI tool `get_financial_health`. Harness `financial-health.ts` (4); UAT-GL-030. No postings, no control change. |
| 0.7 | 2026-06-25 | Platform | **Petty-cash register UI surfaced (EXP-07)** — new screen `/advances` (ERP nav → การเงิน, perm `creditors`/`exec`) lists every advance with status + the **outstanding-float** KPI (over the already-documented `GET /api/finance/advances`, whose response carries the `outstanding` total), plus inline **settle** (with the reconcile guard) and an **issue** form. Detective/control surface over the §7 step 9 float — finance sees uncleared cash at a glance. UI-only; no migration / no control change. ToE: `basics` harness (register list + `?status=open` filter). |
| 0.8 | 2026-06-26 | Platform | **Till-close cash over/short → GL + material-variance maker-checker (REV-13).** §7 step 5: the close variance now POSTS to GL (short → Dr 5830 Cash Over/Short / Cr 1000; over → Dr 1000 / Cr 5830; idempotent `source=TILL_CLOSE`) so book-cash tracks the count. A variance ≥ THB 100 posts a **Draft** JE + parks the session **PendingApproval** — a **different** user approves via `POST /api/payments/till/variance/:sessionNo/approve` (self-approval → `SOD_VIOLATION`, binds Admin); reject voids the draft. New COA account **5830 Cash Over/Short**; migration **0140**; new control **REV-13** (RCM → 89); strengthens REV-05. ToE: `cashreport` harness (immaterial short books 5830; material short → Draft/PendingApproval → SoD-blocked self-approve → manager approves → Posted; TB balanced). |
| 1.1 | 2026-06-26 | Platform | **Cash banking — safe-drop → bank deposit → reconciliation (new control REC-05).** §7 step 8 + §9 control matrix. Till `drop`s into the safe (drawer-only, no GL) are now BATCHED into a bank deposit and posted (Dr <bank account, e.g. 1010> / Cr 1000 Cash), each banked drop stamped with `deposit_id`; the deposit reconciles to the statement (Deposited→Reconciled). `GET /api/bank/deposits/undeposited-drops` surfaces the **cash still in the safe** (the unbanked exposure). `bank.service` `undepositedDrops`/`createDeposit`/`reconcileDeposit`/`listDeposits`. **SoD:** banking (`exec`/`ar`, treasury) is segregated from the cashier (`pos_till`) — a cashier can't create a deposit (403). New `bank_deposits` table + `cash_movements.deposit_id` (migration **0152**, RLS); web `/cash-banking`. New control **REC-05** (RCM → 112). ToE: `cash-banking` harness (drops → cash-in-safe; cashier 403; treasury banks → Dr bank / Cr 1000; reconcile; TB balanced). |
| 1.0 | 2026-06-26 | Platform | **Large-refund maker-checker (new control REV-16).** §7 step 4 + §9 control matrix. A **standalone** refund (`POST /api/payments/refunds`) ≥ the materiality threshold (THB 1,000) is parked as a request (`refund_requests`, migration **0151**) that **moves no money** — no `payment_refunds` row, the payment isn't flipped — until a **different** user approves (`POST /api/payments/refund-requests/:id/approve`); self-approval → `SOD_VIOLATION`; reject voids it. Sub-threshold refunds + **goods-return** refunds (the return is the authorizing document) are never gated. `payments.service` `requestRefund`/`approveRefund`/`rejectRefund`/`listRefundRequests`; wired into the **GOV-01** monitor (9th source) with an inline approve/reject on `/approvals`. New control **REV-16** (RCM → 111). ToE: `refund-approval` harness (small runs immediately; large parks PendingApproval + GOV-01 surfacing; self-approve 403; different user approves → executed; reject moves no money). |
| 1.0 | 2026-07-03 | Platform | **LC-2 — petty-cash chat self-service (docs/30, no migration).** §7 step 11: `expense`/`advance` may be RAISED from the LINE OA chat by a linked `creditors`/`exec` holder — same `createRequest` path (PEX-, PendingApproval, no GL; service guards unchanged); linked approvers (creditors/exec, maker excluded — `LineNotifyService.notifyPermissionHolders`) pushed on request, requester pushed the ✅/❌ decision. Chat money-DECISIONS deliberately deferred (approval stays `/petty-cash`) — EXP-08 approval surface unchanged, no new control. ToE: `line-crm` 69 ✓ (chat raise happy + permission/over-float negatives, approver push excludes maker, decision pushes). Manual `05-finance-ar-ap.md` + UAT (UAT-P2P-084) updated; docs/30 LC-2 marked delivered. |
| 0.9 | 2026-06-26 | Platform | **Petty-cash imprest fund + direct-expense / advance maker-checker (new control EXP-08).** §3 RCM list, §7 step 11, §9 control matrix. A `petty_cash_funds` fund holds cash capped at a **credit limit (วงเงิน)** in new account **1015 Petty Cash** (added to the COA + `CASH_ACCOUNTS`); an `expense_requests` row draws against it as a direct **expense** or **advance** — a maker-checker request (PEX-, document ref + receipt key) that posts nothing until a **different** user approves (expense Dr 5100/Cr 1015; advance Dr 1180/Cr 1015), decrementing the fund; self-approve → `SOD_VIOLATION`; over-balance draw → `INSUFFICIENT_FLOAT`; over-limit establish/replenish → `OVER_FLOAT`; advances settle back to the fund. Migration `0141` (`petty_cash_funds`, `expense_requests`). New module `apps/api/src/modules/petty-cash/`; wired into the **GOV-01** monitor (source 7). New `/petty-cash` screen (funds + requests + approvals). New RCM control **EXP-08**. ToE: `basics` (+11) + `compliance` (+5). Manual `05-finance-ar-ap.md` + UAT `03-procure-to-pay-uat.md` + traceability matrix updated. |
| 1.3 | 2026-07-03 | Platform | **LP-2 note (docs/31, no migration):** the LINE copilot (`บอท` + free Thai) can now DRAFT a petty-cash expense/advance — the confirmed draft replays the SAME chat `expense`/`advance` command (LC-2), so the EXP-07/08 raise path, `creditors`/`exec` permission re-check, maker-checker and float guards are unchanged; AI never posts. LLM output schema-validated; per-tenant daily LLM cap (PN-26 rev 1.8). ToE `line-crm` (expense draft → confirm → PEX PendingApproval). |
| 1.2 | 2026-07-02 | Platform | **Module consolidation (docs/28 PR #5) — code pointers only.** POS satellite modules moved under `modules/pos/` (`audit`, `control`, `fiscal`, `labor`, `scale`, `terminal`) beneath the `PosModule` umbrella; routes, permissions, controls and tables unchanged. |
