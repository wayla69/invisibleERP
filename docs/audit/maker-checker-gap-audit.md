# Maker-Checker / Segregation-of-Duties (Dual-Control) Gap Audit

**Scope:** `apps/api/src/modules/*` (NestJS/Fastify API)
**Date:** 2026-07-05
**Author:** Controls / ICFR review
**Status:** Findings for management review — *no application code was changed by this audit.*

---

## 1. Executive summary

This audit enumerated the significant state-changing business processes in the API (anything that
posts to the GL, moves cash/inventory, changes transactional master data, issues stored value,
recognises revenue, or grants access) and assessed each for **maker-checker dual control** — i.e.
whether a transaction prepared by one user must be independently approved by a *different* user before
it takes effect (`approver ≠ initiator`, typically enforced by a `Draft/PendingApproval → approve`
transition that throws `403 SOD_VIOLATION` on self-approval).

- **~55 significant state-changing processes reviewed.**
- **Dual control already enforced on ~24** of them — the codebase is, for its core finance cycles,
  genuinely mature: GL journals (GL-05), payroll (PAY-03), AP disbursement (EXP-06), asset
  registration (FA-10), inventory write-offs (INV-07), bank adjustments (BANK-02), reconciliation
  certification (R06), intercompany reconciliation, AR large-refunds (REV-16), petty-cash *expenses*
  (EXP-08), credit-hold release (REV-12), tax credit/debit notes (TAX-07), AI-proposed actions, and the
  procurement/PMR/budget documents that ride the workflow engine all correctly force a distinct approver.
- **16 true gaps identified** — processes that let a **single user both initiate and commit** a
  financially-significant or fraud-relevant action with no independent approval.

### Headline structural finding

**There are two disjoint maker-checker implementations in this codebase, and most modules use neither
by default.** The generic, always-on approval engine (`modules/workflow/workflow.service.ts`, which
*guarantees* `approver ≠ creator`, line 211) is wired into **only three module areas**:
`procurement` (docTypes `PR`, `PO`), `pmr` (`PMR`, `BQR`), and `planning` (`BUDGET`). Furthermore, that
engine **auto-approves when no workflow *definition* row exists** for the docType (`workflow.service.ts:122`,
`start()` returns `autoApproved:true`), so even those three are only actually dual-controlled if an
administrator has configured a definition.

Every other module that has dual control re-implements it **inline** — a bespoke
`request*/approve*` method pair with a hand-written `if (req.requestedBy === user.username) throw
SOD_VIOLATION`. This pattern is duplicated at least a dozen times (ledger, finance/AP, inventory,
assets, bank, reconciliation, petty-cash, payments-refund, ic-recon, tax-docs, loyalty-receipts,
ai-action). The gaps below are almost all cases where that inline pattern was **not** applied to a
process that carries equivalent risk — the control is a matter of per-endpoint discipline, not a
framework guarantee.

> **Important correction (control-design discrepancy).** The pre-audit assumption that *"loyalty
> over-threshold points adjustments already route via maker-checker"* is **NOT substantiated by the
> code.** The only genuine distinct-actor control in `modules/loyalty` is the **member-submitted receipt
> approval queue** (`receipt-submissions.service.ts:84`), and it is **not threshold-gated**. All
> **staff-initiated** point movements — manual grants, member-to-member transfers
> (`loyalty.controller.ts:116`), and bulk expiry (`loyalty.controller.ts:75`) — are **single-user**.
> See Gap G13. This should be reconciled in the SoD narrative and the RCM (rules R15/R16).

---

## 2. Methodology

1. **Registry review.** Read the SoD rule registry `packages/shared/src/permissions.ts` (`SOD_RULES`
   R01–R16) and the generic approval engine `modules/workflow/workflow.service.ts` to establish the
   two dual-control mechanisms and the docTypes wired to the engine.
2. **Signal sweep.** Grep across `apps/api/src/modules` for the presence/absence of the maker-checker
   fingerprints: `SOD_VIOLATION` / `SOD_SELF_*`, `requestedBy`/`preparedBy`/`createdBy` actor
   comparisons (`=== user.username`), `Draft`/`PendingApproval` statuses paired with a distinct
   `approve*` endpoint, and calls into `workflow.start()` / `pendingInstanceFor()` /
   `assertCanTransition()`.
3. **Per-process read.** For each significant state-changing endpoint, read the controller route
   (permission gate) and the service method to confirm whether commitment is gated on a *distinct*
   approver, and to capture `file:line` evidence.
4. **Classification.** Each process was classified **Yes** (distinct approver enforced), **Weak**
   (some compensating/detective control but no preventive distinct-approver on the act itself), or
   **No** (single user initiates and commits). "No" on a financially-significant/fraud-relevant process
   is a **true gap**; low-risk or read-only processes are recorded in the Appendix as not-applicable.
5. **Evidence standard.** Findings cite `path:line`. Where a control is claimed by a comment/narrative
   but not enforced in code, that discrepancy is flagged explicitly (see the loyalty correction).

**Note on `Permissions`-based SoD.** Many conflicts (e.g. R05 post-JE vs close-period, R11 adjust vs
count) are mitigated by *permission separation* — the two duties are different `@Permissions()` gates
that the SoD engine (`detectSodConflicts`) refuses to co-assign to one role. That is a valid
*preventive role* control but it is **not** transaction-level maker-checker: it stops one *person* from
holding both duties, but it does not force a *second person* to approve an individual document. This
audit treats permission-separation as a compensating control, and flags a process as a gap only where
neither a distinct approver **nor** an adequate detective control exists for a high-risk act.

---

## 3. Coverage table

| # | Process | Module / evidence | Dual-control? | Control ref |
|---|---------|-------------------|:-------------:|-------------|
| 1 | Manual GL journal entry (Draft → post) | `ledger/ledger.service.ts` `postEntry:210`, `approveEntry:482` (`SOD_VIOLATION:490`) | **Yes** | GL-05 / R07 |
| 2 | Payroll run posting (Draft JE → post) | `payroll/payroll.service.ts` `:123`, `approvePayroll:154` (reuses GL-05) | **Yes** | PAY-03 / R05 |
| 3 | AP disbursement / vendor payment | `finance/finance.service.ts` `requestApPayment:~654`, `approveApPayment:688` (`SOD_VIOLATION:693`) | **Yes** | EXP-06 / R03 |
| 4 | AP bill "book already paid" guard | `finance/finance.service.ts:595` | **Yes** | EXP-06 |
| 5 | Bank statement adjustment posting | `bank/bank.service.ts` `requestAdjustment`/`approveAdjustment`; controller `:34`,`:37` | **Yes** | BANK-02 |
| 6 | Bank/GL reconciliation certification | `reconciliation/reconciliation.service.ts` `certify:143` (`SOD_VIOLATION:150`) | **Yes** | R06 |
| 7 | Intercompany reconciliation sign-off | `ic-reconciliation/ic-recon.service.ts` `preparePeriod:47`, `approvePeriod:65` | **Yes** | R06 |
| 8 | Customer credit-hold **release** | `finance/collections.service.ts:291` (`SOD_SELF_RELEASE`) | **Yes** | REV-12 |
| 9 | AR/POS **large** refund (over threshold) | `payments/payments.service.ts` `approveRefund:235` (`SOD_VIOLATION:240`) | **Yes** | REV-16 / R08 |
| 10 | Till/drawer close variance approval | `payments/payments.service.ts` `approveVariance:375` (parks Draft over/short JE) | **Yes** | R08 / R11 |
| 11 | Inventory write-off / negative adjustment | `inventory/inventory-ledger.service.ts` `approveWriteOff:320` (`SOD_VIOLATION:325`) | **Yes** | INV-07 / R11 |
| 12 | Fixed-asset registration / capitalisation | `assets/assets.service.ts` `approveRegistration:142` (`SOD_VIOLATION:145`) | **Yes** | FA-10 |
| 13 | Asset revaluation / impairment / disposal | `assets/assets.service.ts`; pending queue `finance.service.ts:800` | **Yes** | FA-08 / FA-09 |
| 14 | Tax credit-note / debit-note posting | `tax/documents/tax-docs.controller.ts` `approve-note:81` | **Yes** | TAX-07 |
| 15 | Petty-cash **expense request** (draw against fund) | `petty-cash/petty-cash.service.ts` `createRequest:80`, `approveRequest` | **Yes** | EXP-08 |
| 16 | Purchase requisition (PR) | `procurement/procurement.service.ts:97` → workflow `PR` | **Yes\*** | R03 / R07 |
| 17 | Purchase order (PO) | `procurement/procurement.service.ts:622` → workflow `PO` | **Yes\*** | R04 / R07 |
| 18 | Project material request (in-/over-budget) | `pmr/pmr.service.ts:150` → workflow `PMR` | **Yes** | PROJ-12/13 |
| 19 | Off-budget BoQ change request | `pmr/pmr.service.ts:301` → workflow `BQR` | **Yes** | PROJ-15 |
| 20 | Budget version submission | `planning/planning.service.ts:83`,`:99` → workflow `BUDGET` | **Yes\*** | — |
| 21 | AI/agent-proposed action execution | `ai/ai-action.service.ts` `approve:89` (`SOD_SELF_APPROVAL:94`) | **Yes** | — |
| 22 | Three-way AP match hold/release | `modules/match` (`three-way-match.service.ts`) | **Yes** | R04 |
| 23 | Loyalty **member-submitted receipt** approval | `loyalty/receipt-submissions.service.ts` `approve:84` | **Yes** (not threshold-gated) | R15 |
| 24 | Generic configurable approvals (any docType) | `workflow/workflow.service.ts` `act:196` (`SOD_VIOLATION:211`) | **Yes** | R07 |
| — | **Period/year close** | `ledger/close.controller.ts` `@Permissions('gl_close')`, `ledger.service.ts closeYear:1148` | Weak (role-split only) | R05 |
| G1 | **Gift-card / stored-value issuance** | `giftcards/gift-card.service.ts` `issue:24` (posts Dr1000/Cr2200 `:32`) | **No** | R14 |
| G2 | **GL journal reversal** | `ledger/ledger.service.ts` `reverseEntry:525` (posts contra as Posted `:545`) | **No** | GL-05 / R05 |
| G3 | **Petty-cash fund establish / replenish** | `petty-cash/petty-cash.service.ts` `establishFund:34` (`:47`), `replenishFund:52` (`:60`) | **No** | EXP-08 / R07 |
| G4 | **Opening-balance GL posting** | `ledger/ledger.service.ts` `postOpeningBalances:1120` (`postEntry:1142`, no `pendingApproval`) | **No** | GL-05 |
| G5 | **Master-data bulk import** (items/vendors/customers/prices/promos) | `masterdata/masterdata.service.ts` `importRows:93`, `importChecked:198`; controller `import:49` | **No** | R09/R10/R13 |
| G6 | **Price / promotion rule change** | `pricing/pricing.controller.ts` `upsert:35` (`@Permissions('pricelist')`) | **No** | R10 |
| G7 | **Customer credit-limit change** | via `masterdata` customers registry `master-registry.ts:86,98` | **No** | R09 |
| G8 | **Vendor master financial fields** (terms/credit; bank a/c) | via `masterdata` vendors registry `master-registry.ts:90-99` | **No** | R02 |
| G9 | **Bank account creation** (GL mapping + a/c no) | `bank/bank.service.ts` `createBankAccount:85` | **No** | R02 |
| G11 | **Privileged access grant + self-service SoD override** | `admin-users/admin-users.service.ts` `create:97`, `update:116` (`allow_sod_override`) | **No** | R01 / AC-02 |
| G12 | **CPQ quote self-accept → AR/revenue post** | `cpq/cpq.service.ts` `acceptQuote:163` (posts Dr1100/Cr4000) | **No** | R07/R10 |
| G13 | **Loyalty staff point grant / transfer / expiry** | `loyalty/loyalty.controller.ts` `transfer:116`, `expire:75` | **No** | R15/R16 |
| G15 | **Tenant financial profile** (PromptPay id, Tax ID) | `billing/tenant.controller.ts` `updateProfile:58` | **No** | R02 |
| G10 | **Bank statement import** | `bank/bank.service.ts` `importStatement:99` | Weak | — |
| G14 | **POS void / sub-threshold refund** | `payments/payments.controller.ts` `void:68`, `refunds:49` | Weak | R08/R12 |
| G16 | **Issued tax-invoice void** | `tax/documents/tax-docs.controller.ts` `void:66` | Weak | — |

\* **Yes\*** = enforced by the workflow engine, but **conditional** on an active workflow *definition*
existing for that docType; with no definition the engine auto-approves (`workflow.service.ts:122`). See
Gap discussion under "Cross-cutting risk" below.

---

## 4. Identified gaps (ranked by risk)

### G1 — Gift-card / stored-value issuance is single-user  ·  **P1 · High**
- **Where:** `modules/giftcards/gift-card.service.ts` `issue():24`; posts `Dr 1000 Cash / Cr 2200
  gift-card liability` at `:32`. Route `gift-card.controller.ts:12` `@Permissions('pos')`.
- **What it does:** Mints a gift card with an arbitrary face value and books the cash/liability GL in a
  single call. No `requestedBy/approvedBy`, no threshold, no distinct approver.
- **Risk:** A single POS-permissioned user can issue stored value to a card they control (self-issuance
  of cash-equivalent value), then redeem it (`redeem`, separate perm, but the *issuance* is the fraud).
  Gift-card float is a TFRS-15 liability; unauthorised issuance directly inflates it and can be
  monetised. This is the loyalty-value analogue the SoD registry explicitly worries about (R14).
- **Related:** SoD R14 (configure rewards/vouchers vs redemption); cash-equivalent controls.
- **Remediation:** Draft+approve — issue as `status:'Pending'` with no GL, add
  `POST /giftcards/:no/approve` gated to a distinct approver (`SOD_VIOLATION` when
  `issuedBy === approver`), post the GL only on approval. Optionally threshold-gate (small face values
  auto-issue) to keep the till fast, mirroring REV-16.
- **Status: ✅ REMEDIATED (2026-07-05).** Threshold-gated: face ≤ 5000 THB auto-issues (Active + GL) to
  keep the till fast; face > 5000 is created `PendingApproval` with **no GL** and **not redeemable**
  (`GIFT_CARD_INACTIVE`) until `POST /api/pos/gift-cards/:cardNo/approve` (`creditors`/`exec`) by a user ≠
  the issuer posts `Dr 1000 / Cr 2200` and activates it (self-approval → `403 SOD_VIOLATION`). Enum value
  added by migration **0252**. Returns-minted store credit (`creditFromReturn`) is unchanged (driven by
  the controlled return flow). ToE: `giftcards.ts` (pending → not redeemable → self-approve 403 → distinct
  approver posts GL).

### G2 — Any posted GL journal can be reversed by one user  ·  **P1 · High**
- **Where:** `modules/ledger/ledger.service.ts` `reverseEntry():525`. Builds a swapped-Dr/Cr contra
  entry and posts it immediately as **Posted** through `postEntry` (`:545`, no `pendingApproval`).
  Route `ledger.controller.ts:171`.
- **What it does:** Reverses a Posted JE (which itself required GL-05 maker-checker) with a single call.
- **Risk:** **This silently undoes the GL-05 control.** A preparer whose entry was independently
  approved can, alone, reverse it — nullifying the second-person check and enabling
  post-then-reverse manipulation around period boundaries. The reversal touches control accounts
  (`viaSubledger:true`).
- **Related:** GL-05 / SoD R05.
- **Remediation:** Route the reversal through the same Draft+approve as `postEntry` (post the contra as
  `pendingApproval:true`), OR add a distinct-approver guard so `reversedBy ≠` the original `createdBy`
  **and** the reversal is itself approved by a second finance user.
- **Status: ✅ REMEDIATED (2026-07-05).** Added a `requireDistinctApprover` flag to `reverseEntry`, set
  by the manual controller path (`POST /journal/:id/reverse`): the reverser must differ from the original
  preparer (`orig.createdBy`) or `403 SOD_VIOLATION`. System/internal callers (FX reval) do not set the
  flag, so automated reversals are unchanged; the contra still posts immediately. This closes the
  "preparer unilaterally reverses their own approved entry" hole. *Follow-up hardening still open:* a full
  second-**approval** on the reversal contra itself (Draft+approve) — deferred to avoid the `is_reversed`
  flag-timing edge cases on this parity-sensitive path. ToE: `basics.ts` (self-reverse → 403; distinct
  user reverses OK).

### G3 — Petty-cash fund establishment & replenishment are single-user cash movements  ·  **P1 · High**
- **Where:** `modules/petty-cash/petty-cash.service.ts` `establishFund():34` (posts `Dr 1015 / Cr 1000`
  at `:47`) and `replenishFund():52` (posts at `:60`). Routes `petty-cash.controller.ts:14`,`:16`.
- **What it does:** Creates/tops-up a petty-cash float, moving real cash out of `1000`, in one call.
- **Risk:** The module *documents* an EXP-08 maker-checker, but that control only covers the **expense
  requests** drawn against the fund (`createRequest`/`approveRequest`). **Standing up the fund and
  replenishing it — the actual cash movements — bypass it entirely.** One user can establish a fund and
  repeatedly "replenish" it up to the float, extracting cash from `1000`, with no approver.
- **Related:** EXP-08 / SoD R07.
- **Remediation:** Apply the module's own EXP-08 pattern to establishment/replenishment — park as
  `PendingApproval` with no GL until a distinct `creditors/exec` holder approves.
- **Status: ✅ REMEDIATED (2026-07-05).** Both `establishFund` (initial cash) and `replenishFund` now
  raise a maker-checker **funding request** (reuses `expense_requests` with `kind:'funding'` — no
  migration): the fund record is created with balance 0, and the cash-in (Dr petty-cash / Cr 1000) posts
  and lifts the balance only when a **distinct** user approves via the existing
  `POST /petty-cash/requests/:reqNo/approve` (self-approval → `403 SOD_VIOLATION`; float ceiling re-checked
  → `422 OVER_FLOAT`). ToE: `basics.ts` (establish/replenish → PendingApproval; self-approve 403; distinct
  approver funds), `compliance.ts`, `line-crm.ts`.

### G4 — Opening balances post directly to the GL, single-user  ·  **P1 · High**
- **Where:** `modules/ledger/ledger.service.ts` `postOpeningBalances():1120`; `postEntry` call at
  `:1142` has **no** `pendingApproval` flag, so the batch lands **Posted**. Route
  `ledger.controller.ts:284` (`@Permissions('gl_post','creditors','ar')`).
- **What it does:** Posts an entire opening trial balance (every account's initial position, balanced to
  `3000` Opening Balance Equity) in one call.
- **Risk:** Opening balances are among the most material, least-scrutinised postings in a migration/go-
  live. A single user can seed or restate the entire ledger's starting position with no second-person
  review — a classic misstatement/fraud vector and a NASDAQ-readiness red flag.
- **Related:** GL-05.
- **Remediation:** Post opening batches as `pendingApproval:true` (Draft) requiring a distinct
  `gl_close`/controller approval before they affect balances.
- **Status: ✅ REMEDIATED (2026-07-05).** `postOpeningBalances` now calls `postEntry` with
  `pendingApproval:true`, so the batch lands **Draft** — excluded from balances until a distinct user
  approves it via `POST /journal/:entryNo/approve` (self-approval → `403 SOD_VIOLATION`); response carries
  `status:'Draft', pending:true`. ToE: `opening-balances.ts` (Draft excluded from TB; self-approve 403;
  distinct approver posts; TB then balances).

### G5 — Master-data bulk import commits with a single user  ·  **P1 · High**
- **Where:** `modules/masterdata/masterdata.service.ts` `importRows():93` and `importChecked():198`
  write straight to the entity tables. Controller `masterdata.controller.ts:49`
  (`@Permissions('masterdata')`).
- **What it does:** The registry-driven engine (`master-registry.ts`) imports/replaces **items, vendors,
  customers, price lists, promotions, BOM master** from CSV/xlsx in one call.
- **Risk:** This is the single widest single-user surface over transactional master data. One
  `masterdata` holder can, unreviewed, change customer credit limits (G7), vendor payment terms/credit
  (G8), item prices, and promotions — the exact changes SoD rules R09/R10/R13 are designed to segregate
  from transacting. `mode:'replace'` can wipe and re-seed an entire entity table.
- **Related:** SoD R09/R10/R13.
- **Remediation:** Stage imports (`PendingApproval` batch) and require a distinct approver before commit;
  at minimum gate financially-sensitive columns (credit limit, price, payment terms, bank a/c) behind a
  second-person approval and emit a master-data change report for detective review.

### G6 — Price / promotion rule changes are single-user  ·  **P1 · Medium-High**
- **Where:** `modules/pricing/pricing.controller.ts` `upsert:35` (`@Permissions('pricelist','exec')`),
  `setCombo:40`; service `upsertRule`.
- **What it does:** Creates/updates pricing rules and combo prices that immediately drive quotes and POS
  pricing.
- **Risk:** A `pricelist` holder can set a price/discount and have it take effect with no review (R10).
  Combined with any selling duty this is direct margin leakage / collusive under-pricing.
- **Related:** SoD R10.
- **Remediation:** Distinct-approver on price/promo activation (effective-dated Draft → approve), plus a
  price-override detective report.

### G7 — Customer credit-limit change has no dual control  ·  **P1 · Medium-High**
- **Where:** Only editable via the `masterdata` customers registry (`master-registry.ts:86,98`
  `Credit_Limit`); no dedicated maker-checker endpoint. (`collections.service.ts` reads the limit and
  controls *hold/release* with SoD, but not the *limit* itself.)
- **What it does:** Sets a customer's credit ceiling — the amount they can transact on credit.
- **Risk:** Raise a limit, then sell on credit (R09). No approver, no change report at the field level.
- **Related:** SoD R09.
- **Remediation:** Dedicated `request/approve` for credit-limit changes with a distinct credit-manager
  approver; treat as a sub-case of G5 remediation.
- **Status: ✅ REMEDIATED (2026-07-05).** `changeLimit` (`POST /api/finance/ar/credit-limit`, `crm`/`exec`)
  now **stages** the change as a `PendingApproval` `credit_events` row (migration **0261**) — the ceiling
  does **not** move until a **distinct** user approves it via `POST …/credit-limit/:reqNo/approve`
  (`approvals`/`exec`; self-approval → `403 SOD_VIOLATION`), mirroring the credit-hold release SoD. Also
  `…/reject` and the queue `GET …/credit-limit/pending`; web queue on `/finance/credit-hold`. The
  detective credit-change report (`credit_events`) is unchanged. ToE: `basics.ts` (staged → self-approve
  403 → distinct approver applies → 50000).

### G8 — Vendor-master financial fields (bank / terms / credit) are single-user  ·  **P1 · High**
- **Where:** `masterdata` vendors registry (`master-registry.ts:90-99`) exposes `Payment_Terms`,
  `Credit_Limit`; the `vendors` schema also carries bank-account fields. All maintained via the same
  single-user import path (G5).
- **What it does:** Maintains the payee financial identity used by AP disbursement.
- **Risk:** **Classic AP fraud — redirect a payment by changing a vendor's bank account, or create a
  fictitious vendor and pay it (R02).** AP disbursement itself is dual-controlled (EXP-06), but if the
  *payee bank details* can be changed by one person with no approval, the disbursement control can be
  defeated after approval.
- **Related:** SoD R02.
- **Remediation:** Distinct-approver on any change to vendor bank account / payment terms; a
  vendor-bank-change report reviewed independently before the next payment run.

### G11 — Privileged access grants & self-service SoD override  ·  **P1 · High**
- **Where:** `modules/admin-users/admin-users.service.ts` `create():97`, `update():116`. Both grant
  role + fine-grained `permissions` in a single call. Crucially the caller may pass
  `allow_sod_override:true` with a self-supplied `sod_reason` to **bypass** the SoD-conflict check
  (`assertNoSodConflict`), all under one `@Permissions('users')` admin.
- **What it does:** Provisions users and assigns/changes their permission set.
- **Risk:** **R01 — the top SoD conflict: access administration combined with the ability to grant
  itself/others conflicting duties.** A single `users` admin can grant transactional permissions
  (including to their own account) and *self-authorise the SoD exception* with a free-text reason. There
  is a detective UAR (`access-review/certify`, AC-06) but **no preventive second-person approval** on the
  grant or the override.
- **Related:** SoD R01 / AC-02 (user access provisioning).
- **Remediation:** Require a distinct approver for (a) any permission/role grant and (b) especially any
  `allow_sod_override` — the override must be approved by someone other than the grantor and other than
  the affected user. Log both as maker-checker events feeding the UAR.
- **Status: ✅ REMEDIATED (2026-07-05) — part (b); part (a) intentionally deferred.** The self-service SoD
  override is gone: a conflicting grant with `allow_sod_override` + reason is now **staged** as a
  PendingApproval `access_grant_exceptions` row (migration **0260**) and applied only when a **DIFFERENT**
  admin approves it via `POST /api/admin/users/access-exceptions/:reqNo/approve` — the approver must differ
  from BOTH the requester and the affected user (else `403 SOD_VIOLATION`); who-requested / who-approved /
  why / which-rules is persisted in the hash-chained audit_log. Web queue on `/admin/users`. Part (a) —
  distinct-approver on *every* role/permission grant — was **deliberately not done**: it is a large
  workflow change on top of the already-layered controls (god-only Admin grants, the preventive SoD block,
  and the quarterly UAR AC-08); revisit only if a control owner requires it. ToE: `compliance.ts`
  (staged → grantor self-approve 403 → distinct admin approves → applied; evidence in audit_log).
  Earlier related hardening (same audit): granting the **Admin** role is already god-only (`ADMIN_GRANT_DENIED`).

### G12 — CPQ quote self-accept posts AR/revenue  ·  **P2 · Medium-High**
- **Where:** `modules/cpq/cpq.service.ts` `acceptQuote():163`; posts `Dr 1100 AR / Cr 4000 Revenue` on
  accept. Route `cpq.controller.ts:78`.
- **What it does:** The same user who builds/sends a quote (applying discount rules) can mark it Accepted,
  which recognises revenue.
- **Risk:** Single-user **revenue recognition** — fictitious/premature revenue, self-approved discounts
  (R07/R10). No `SOD_VIOLATION`, no distinct actor between quote author and acceptor.
- **Related:** SoD R07/R10; revenue-recognition assertions.
- **Remediation:** Require the acceptance/revenue-posting step to be performed by a user distinct from the
  quote creator (or route large/discounted quotes through the workflow engine).

### G13 — Loyalty staff-initiated point movements are single-user (and the assumed control does not exist)  ·  **P2 · Medium-High**
- **Where:** `modules/loyalty/loyalty.controller.ts` — member point **transfer** `:116`
  (`@Permissions('crm_points_adjust','loyalty','exec')`) and bulk **expire** `:75`; the underlying
  grants/adjustments in `member.service.ts`. No `requestedBy/approvedBy`, no threshold gate.
- **What it does:** Grants, transfers, and expires loyalty points — a TFRS-15 deferred-revenue liability.
- **Risk:** One `crm_points_adjust` holder can move point-value to a controlled member and monetise it
  (R15/R16). **Control-design discrepancy:** the narrative/assumption that over-threshold adjustments
  route via maker-checker is **not implemented** — the only distinct-actor control is the *member-
  submitted receipt* queue (`receipt-submissions.service.ts:84`), which is a different flow and is **not
  threshold-gated**. So the documented mitigation for R15/R16 is absent in code.
- **Related:** SoD R15/R16.
- **Remediation:** Implement the assumed control: over-threshold manual point grants/transfers park as
  `Pending` and require a distinct approver; reconcile the SoD narrative/RCM to match reality.

### G9 — Bank account creation is single-user  ·  **P2 · Medium**
- **Where:** `modules/bank/bank.service.ts` `createBankAccount():85`. Route `bank.controller.ts:23`.
- **What it does:** Creates a bank account record (account number + GL-account mapping + currency +
  opening balance).
- **Risk:** Defines where deposits are reconciled and which GL account they hit; a rogue/incorrect
  mapping can misdirect reconciliation or mask activity (R02-adjacent). Opening balance is set here too.
- **Remediation:** Distinct-approver on new bank accounts and on any change to account number / GL
  mapping.

### G15 — Tenant financial profile (PromptPay id, Tax ID) is single-user  ·  **P2 · Medium**
- **Where:** `modules/billing/tenant.controller.ts` `updateProfile():58` (fields include
  `promptpay_id`, `tax_id`, address).
- **What it does:** Sets the PromptPay target that *receives customer QR payments* and the legal tax id
  on documents.
- **Risk:** Changing `promptpay_id` can **redirect incoming customer payments** to an attacker-controlled
  target — a direct cash-diversion vector — with no second-person review. Tax-id changes affect the
  legal identity on issued tax invoices.
- **Remediation:** Distinct-approver on changes to payment-receiving fields (PromptPay/bank) and tax id;
  notify on change.

### G10 — Bank statement import (Weak)  ·  **P3**
- **Where:** `modules/bank/bank.service.ts` `importStatement():99`.
- **Assessment:** Single-user, but the imported lines only become consequential through matching, and the
  downstream **reconciliation is separately certified** (R06, item 6) and adjustments are dual-controlled
  (BANK-02). Compensating detective control exists; residual risk is low. Recommend it be included in the
  reconciliation certifier's evidence review rather than a new preventive gate.

### G14 — POS void / sub-threshold refund (Weak)  ·  **P3**
- **Where:** `payments/payments.controller.ts` `void:68` (`@Permissions('pos_refund','ar')`),
  `refunds:49`.
- **Assessment:** *Large* refunds already park for approval (REV-16, item 9). Voids and sub-threshold
  refunds are single-user **by design** to keep the till fast, and are mitigated by (a) the `pos_sell` /
  `pos_refund` / `pos_till` permission split (R08) and (b) the independent till-variance approval
  (item 10) as a detective control. Residual risk accepted; recommend periodic void/refund exception
  review. Consider lowering/ configuring the REV-16 threshold if void abuse is a concern.

### G16 — Issued tax-invoice void (Weak)  ·  **P3**
- **Where:** `tax/documents/tax-docs.controller.ts` `void:66`.
- **Assessment:** Single-user void of an issued tax document. Credit/debit *notes* are dual-controlled
  (TAX-07). A void is sequence/audit-logged; risk is largely detective-covered. Recommend an exception
  report on voided fiscal documents rather than a preventive gate.

### Cross-cutting risk — workflow-engine dependence on configured definitions
Items 16, 17, 20 (PR/PO/Budget) are dual-controlled **only if** an active workflow *definition* exists
for the docType; otherwise `workflow.start()` auto-approves (`workflow.service.ts:122`). A deployment
that ships without seeded definitions silently has **no** approval on PRs, POs, or budgets. This is a
configuration-integrity gap, not a code gap: recommend a startup assertion / readiness check that a
definition exists for each engine-wired docType in production, and a control test that a fresh tenant
cannot raise-and-auto-approve a PO.

---

## 5. Phased remediation plan

Scope to approve **before any build.** Each item reuses an existing in-repo pattern (the inline
`request*/approve*` + `SOD_VIOLATION` pair, or the workflow engine) — no new framework is required.

### Phase P1 — highest risk: single-user direct-GL / cash-equivalent / access commits
1. **G2 GL reversal** — post the contra as Draft; require distinct approver (closes the GL-05 bypass). — **✅ DONE 2026-07-05** (distinct-reverser guard; full Draft+approve on the contra is documented follow-up).
2. **G4 Opening balances** — post as `pendingApproval`; distinct approver. — **✅ DONE 2026-07-05**.
3. **G3 Petty-cash establish/replenish** — extend the module's own EXP-08 maker-checker to fund cash
   movements. — **✅ DONE 2026-07-05** (funding request `kind:'funding'`, distinct-approver posts the cash-in).
4. **G1 Gift-card issuance** — Draft+approve (optionally threshold-gated like REV-16). — **✅ DONE 2026-07-05** (threshold-gated at 5000 THB; distinct finance approver posts the GL; migration 0259).
5. **G11 Access grants + SoD override** — distinct-approver on permission/role grants and, mandatorily,
   on `allow_sod_override`. — **✅ DONE 2026-07-05** (SoD override → two-person staged approval, migration 0260; blanket per-grant approval intentionally deferred — see G11 status).
6. **G8 Vendor bank/terms + G7 credit limit + G5/G6 price** — staged master-data approval for
   financially-sensitive fields (one workstream; ship the field-level guard first, full staging next).
   — **G7 credit limit ✅ DONE 2026-07-05** (staged change → distinct approver, migration 0261).
   **G8 vendor bank/terms, G6 price/promo, G5 bulk-import staging — still open** (next increments).

*Rationale:* every P1 item is a single user moving cash-equivalents, GL positions, payee identity, or
access with zero second-person control.

### Phase P2 — revenue/liability recognition & payment-target integrity
7. **G12 CPQ self-accept** — separate quote author from revenue-posting acceptor.
8. **G13 Loyalty staff point grants/transfers/expiry** — implement the assumed over-threshold
   maker-checker; reconcile RCM/narrative (R15/R16).
9. **G15 Tenant PromptPay/Tax-ID** — distinct-approver on payment-receiving fields.
10. **G9 Bank account create/edit** — distinct-approver.
11. **Cross-cutting** — production readiness assertion that workflow definitions exist for PR/PO/BUDGET.

### Phase P3 — detective-first (documentation + exception reports; preventive optional)
12. **G10 Bank statement import** — fold into reconciliation-certifier evidence.
13. **G14 POS void/sub-threshold refund** — void/refund exception report; tune REV-16 threshold.
14. **G16 Tax-invoice void** — voided-fiscal-document exception report.

---

## 6. Appendix — processes reviewed and deemed not-applicable

| Process | Module | Why no distinct-approver required |
|---------|--------|-----------------------------------|
| Period / year close | `ledger/close.service.ts closeYear:1148` | Segregated from JE posting by the `gl_close` vs `gl_post` permission split (SoD R05); close is an authorised finance-approver *role* act, and every JE it consumes was already GL-05 dual-controlled. Role-separation is the accepted control here. |
| Positive inventory adjustment (overage/found) | `inventory-ledger.service.ts adjust` | Only *negative* write-offs (shrink/loss) carry fraud risk and are dual-controlled (INV-07); a found-overage increases assets and is low-risk. |
| Recurring / prepaid schedule *runs* | `ledger.service.ts runDueRecurring`, `runDuePrepaid` | Idempotent scheduled amortisation of an already-approved template (GL-08/GL-09); the *template creation* is the control point. |
| Automation rule execution | `automation/automation.service.ts` | Action types limited to `notification/message/log/enroll_journey` (`:24`) — no financial or inventory mutation. |
| AI copilot / analytics / reporting / BI reads | `ai`, `nl-analytics`, `bi`, `reports`, `dashboard`, `profitability`, `analytics` | Read-only aggregations; no state change. |
| POS sale capture | `pos`, `payments` | Recording a sale is the maker act; the segregated controls are on refund/void/till (R08) and large-refund approval (REV-16), all covered. |
| Goods receipt | `procurement receive-*`, `inventory receipts` | Segregated from ordering by `wh_receive` vs `procurement` (R04) and validated by the three-way match (`modules/match`). |
| User UI prefs / saved views / favourites | `user-prefs`, `saved-views` | Per-user, non-financial preferences. |
| Delegation create/revoke | `workflow.service.ts createDelegation:294` | Delegations cannot delegate approval back to a document's creator — the engine blocks maker self-approval even via delegation (`:210-211`). |
| Document templates / theme / i18n / feature-flag reads | `document-templates`, `theme`, `i18n` | Presentation/config with no direct financial effect (feature-flag *writes* are admin config; low transactional risk — monitor if flags gate money movement). |
| Reconciliation *preparation* | `reconciliation.service.ts:44` | Preparation is the maker act; the control is on **certification** (R06, covered). |
| Lease periodic run, EAM PM generation | `leases`, `eam` | Scheduled runs off already-created (dual-control-eligible) lease/asset master; creation is the control point. |

---

## 7. Revision history

| Version | Date | Author | Change |
|---------|------|--------|--------|
| 1.0 | 2026-07-05 | Controls / ICFR review | Initial maker-checker / SoD dual-control gap audit across `apps/api/src/modules/*`. ~55 processes reviewed; 16 true gaps identified (9 P1, 4 P2, 3 P3/Weak). Flags the structural finding that the generic workflow engine is wired to only procurement/pmr/planning and all other dual-control is inline-or-absent, and the correction that loyalty over-threshold points maker-checker is assumed but not implemented in code. |
