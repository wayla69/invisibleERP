# Doc 17 — Finance & Accounting "Real ERP" Deepening Plan

**Status:** Draft for approval · **Owner:** CTO · **Created:** 2026-06-26
**Driver:** Investor diligence feedback — "good but thin; this is not a real ERP." The finance/accounting
cluster scored 2.5–3.5/5 in the internal audit (see chat memo). This plan turns the hardcoded,
single-dimension GL into a configurable, multi-dimensional, auditable ledger and closes the statutory gaps.

> **Working-agreement note (CLAUDE.md):** every code change in this plan ships with its doc updates —
> process narratives + Mermaid + RCM/SoD (`compliance/build_rcm.py` → regenerate xlsx), user-manual module
> guides, and UAT cases (positive + negative/control). Each workstream below lists its doc deliverables.
> Migrations are journaled (`meta/_journal.json`) and use the **next free** 4-digit number — renumber on
> merge if taken. Numbers below (0155+) are indicative from a 0154 baseline.

---

## 0. Guiding principles

1. **Fix the foundation before features.** Do not build statutory reports on a hardcoded CoA. Phase 1 is a
   prerequisite for everything else.
2. **No big-bang refactor.** The posting engine ships behind a compatibility shim: `postEntry` keeps working
   with literal `account_code`s while callers migrate to the new `PostingService` one module at a time.
3. **Never touch parity-locked code.** `forecasting.service.ts` (`ห้ามเปลี่ยน — parity`) and any
   parity-locked path are out of scope; route around them.
4. **Every phase stays green.** The `basics` harness is the primary gate for GL/AR/AP/FA/lease/cash-flow
   work — extend it per workstream; keep `compliance`, `worldclass`, `taxdocs` green.
5. **Backwards-compatible data.** New dimensions/columns are nullable with safe defaults; existing postings
   remain valid (untagged ⇒ "Unassigned").

---

## PHASE 1 — Make the ledger a real ledger (foundation)

**Goal:** editable hierarchical CoA · a posting/account-determination engine · multi-dimensional postings
(branch first) · true sub-ledger control accounts. **Outcome demo:** per-branch P&L and balance sheet
produced directly from the GL.

### WS1.1 — Chart of Accounts as master data
**Problem:** `const COA = [...]` at [ledger.service.ts:30](apps/api/src/modules/ledger/ledger.service.ts#L30)
is a developer constant; `tenantAccounts` overlay is cosmetic.

**Schema — migration `0155_coa_master.sql`** (+ RLS loop for tenant tables):
- `account_groups` (id, tenant_id, code, name_th, name_en, type [Asset|Liability|Equity|Revenue|Expense],
  parent_group_id, sort) — hierarchy/rollup nodes.
- Extend `accounts`: add `parent_code`, `account_group_id`, `is_control` (bool), `control_subledger`
  (enum: AR|AP|INV|FA|null), `normal_balance` (D|C), `is_postable` (bool — header accounts are not),
  `active` (bool), `require_dimension` (jsonb: which dims are mandatory), `effective_from/to`.
- Seed migration converts the hardcoded `COA`/`LEDGERS` arrays into rows (idempotent upsert).

**Service:** new `coa.service.ts` in `modules/ledger/` — `createAccount`, `updateAccount` (block code change
if postings exist), `deactivate` (block if non-zero balance), `listTree`, `validatePostable`. `postEntry`
gains a guard: reject postings to non-postable/inactive accounts and to control accounts from outside their
sub-ledger (see WS1.4).

**Endpoints** (controller `ledger.controller.ts`, perm `gl_coa` — new, granted to Admin/Controller):
`GET/POST/PATCH /api/ledger/accounts`, `GET /api/ledger/accounts/tree`,
`POST /api/ledger/accounts/:code/deactivate`.

**Permissions/SoD:** add `gl_coa` to `packages/shared/src/permissions.ts`; CoA edits are maker-checker for
control accounts (reuse workflow). New control: **GL-11 CoA change control**.

**Docs:** narrative `docs/process-narratives/` GL cycle (CoA section + Mermaid); RCM add GL-11 (regen xlsx);
user-manual `/accounting` CoA management; UAT positive (create/rollup) + negative (edit code with postings →
blocked, deactivate non-zero → blocked).

**Harness:** extend `basics` — seed a custom account, post to it, assert it appears in trial balance tree;
assert deactivate-with-balance is rejected.

### WS1.2 — Posting / account-determination engine
**Problem:** 28 service files inline `account_code` literals (`{ account_code: '5000', debit }`). No single
source of truth, no remap without code change.

**Schema — migration `0156_posting_rules.sql`:**
- `posting_event_types` (key, name, description) — e.g. `SALE.FOOD`, `GR.INVENTORY`, `PAYROLL.GROSS`,
  `DEPRECIATION`, `LEASE.UNWIND`, `FX.REVAL.UNREALIZED`. Seeded from the catalogue of current postings.
- `posting_rules` (id, tenant_id [nullable = global default], event_type, leg [enum DR/CR list], role
  [semantic slot: e.g. `inventory`, `ap_control`, `cogs`, `vat_output`], account_code, dimension_source
  [which document field supplies branch/project], condition jsonb [optional, e.g. category=exempt]).
- Resolution order: tenant-specific rule → industry template rule → global default. Reuses `COA_TEMPLATES`
  + `coa-templates.ts` already imported by the ledger.

**Service:** new `posting.service.ts`:
```ts
interface PostingContext { tenantId: number; date: string; source: string; sourceRef: string;
  createdBy: string; branchId?: number; projectId?: number; departmentId?: number;
  amounts: Record<string, number>;  // semantic role → amount, e.g. { net, vat, gross }
  meta?: Record<string, unknown>; outerTx?: any; }
class PostingService {
  // resolves roles→accounts via posting_rules, stamps dimensions, calls ledger.postEntry with a balanced set
  async post(eventType: string, ctx: PostingContext): Promise<{ entryId: number }>;
  async preview(eventType: string, ctx: PostingContext): Promise<JournalLine[]>; // dry-run for UI/audit
}
```
`PostingService.post` builds the balanced `lines[]` and delegates to the existing `ledger.postEntry`
(idempotency/period-lock/maker-checker preserved). **No GL math is reimplemented.**

**Migration strategy for the 28 callers (incremental, low-risk):**
1. Land `PostingService` + rules seeded to **exactly reproduce** today's literals (1:1 parity).
2. Add a `basics`/`worldclass` "golden posting" snapshot test: for each event type, assert
   `PostingService.preview` == the current inline lines. This locks parity before any caller moves.
3. Migrate callers one module per PR (finance → costing → assets → payroll → restaurant → …), deleting the
   inline literals. Each PR keeps the golden snapshot green.
4. Parity-locked files: leave inline; wrap only if safe. Document any exclusions.

**Endpoints:** `GET/POST/PATCH /api/ledger/posting-rules`, `POST /api/ledger/posting-rules/preview`
(perm `gl_posting_rules`, Admin/Controller, maker-checker).

**Docs:** new narrative section "Automatic account determination" + posting-rules matrix export (auditor
artifact); RCM control **GL-12 Posting-rule change control**; UAT: remap an event's account via rule, post,
assert new account hit (positive) + non-balancing rule rejected (negative).

**Harness:** golden-snapshot suite (above) becomes a permanent CI gate.

### WS1.3 — Multi-dimensional postings (branch/project/department)
**Problem:** journal lines carry only `cost_center_code` ([ledger.ts:80](apps/api/src/database/schema/ledger/ledger.ts#L80)).
No branch ⇒ no per-location P&L. `cost-centers.ts` schema already exists to model after.

**Schema — migration `0157_gl_dimensions.sql`:**
- Add to `journal_lines`: `branch_id` (fk branches), `project_id`, `department_id` (all nullable +
  indexed). Keep `cost_center_code`.
- Dimension masters: reuse `branch`, `projects`; add `departments` table if absent.
- `PostingContext` already carries the dims; `PostingService` stamps them from `dimension_source` per rule
  (e.g. `SALE.FOOD` ⇒ branch from the POS session's branch).
- Backfill: best-effort branch backfill on historical lines from `source`/`sourceRef` join where possible;
  else leave null (Unassigned).

**Service:** extend `trialBalance`, `incomeStatement`, `balanceSheet`, `cashFlowStatement` with optional
`{ branchId?, projectId?, departmentId?, costCenter? }` filters and a `groupBy` dimension. Add
`incomeStatementByBranch()` returning a matrix (account × branch).

**Endpoints:** add dimension filters to existing report endpoints; new
`GET /api/ledger/income-statement/by-branch`. Web: branch selector + "by branch" P&L view on `/accounting`
and `/financial-health`.

**Docs:** narrative — dimensions & segment posting; user-manual — per-branch P&L; RCM **GL-13 dimension
completeness** (control: % of P&L postings tagged with branch ≥ threshold); UAT: post two branches, assert
by-branch P&L splits correctly.

**Harness:** `basics` — seed sales in 2 branches, assert `incomeStatementByBranch` separates them and sums
to the consolidated total.

### WS1.4 — True sub-ledger control accounts + tie-out
**Problem:** `finance.service.ts` `syncArInvoices()` reconciles AR *to* GL after the fact; balances can drift.

**Schema — migration `0158_subledger_tieout.sql`:**
- Mark control accounts (`is_control`, `control_subledger` from WS1.1): 1100 AR, 2000 AP, 1200 INV,
  1500/1590 FA.
- `subledger_tieout_runs` (tenant_id, period, subledger, gl_balance, subledger_balance, variance, status,
  certified_by) — snapshot tie-out per period.

**Service:** `postEntry` guard — reject direct posting to a control account unless `ctx.viaSubledger` is set
(only AR/AP/INV/FA services set it). New `subledgerTieOut(period, subledger)` computes GL control balance vs
sub-ledger sum, returns variance; nightly job + on-demand. Remove reliance on `syncArInvoices` as the
integrity mechanism (keep as a one-time backfill tool only).

**Endpoints:** `GET /api/finance/subledger-tieout?subledger=AR&period=...`,
`POST /api/finance/subledger-tieout/:id/certify` (maker-checker).

**Docs:** narrative — sub-ledger control & tie-out; RCM **GL-14 sub-ledger to GL reconciliation** (key SOX
control); UAT: attempt direct JE to 1100 → blocked; AR invoice posts to 1100 via sub-ledger → tie-out = 0.

**Harness:** `basics` — assert direct control-account post is rejected; assert tie-out is zero after AR/AP
activity.

**Phase 1 exit criteria:** CoA editable; all 28 callers (minus parity-locked) post via `PostingService`;
golden snapshot green; per-branch P&L live; control accounts locked + tie-out = 0.

---

## PHASE 2 — Controls that make it auditable (SOX/listing story)

### WS2.1 — Hard period close + checklist
**Problem:** `closePeriod()` is a flag; `allowClosedPeriod` lets postings slip in. No checklist, no SoD on
close.

**Schema — migration `0159_period_close.sql`:**
- `close_checklist_templates` (steps: bank recon, FX reval, accruals, sub-ledger tie-out, depreciation run,
  prepaid/recurring run, tax accrual, lock sub-ledgers, lock GL) with ordering + required flags.
- `close_runs` (tenant_id, period, status [open|in_progress|locked|reopened], started_by) +
  `close_run_steps` (status, completed_by, completed_at, evidence_ref).
- `period_locks` (period, subledger|GL, locked_by, locked_at).

**Service:** extend ledger close — `startClose`, `completeStep` (validates dependency order), `lockPeriod`
(enforced in `postEntry`: **remove the `allowClosedPeriod` escape**; closed ⇒ hard reject except via an
audited `reopenPeriod` with maker-checker), `reopenPeriod`. Each step calls the relevant service (e.g. FX
reval WS3.2, tie-out WS1.4).

**Endpoints:** `POST /api/ledger/close/start|step|lock|reopen`, `GET /api/ledger/close/:period`.
Web: `/approvals` or new `/period-close` board.

**Docs:** narrative — period-close procedure + Mermaid (gated steps); RCM **GL-15 period-close control**
(SoD: preparer ≠ locker), **GL-16 closed-period posting prevention**; user-manual — close checklist; UAT:
post to locked period → rejected; close out of order → blocked; reopen requires second approver.

**Harness:** `worldclass` year-end — lock period, assert late post rejected; assert all steps required
before lock.

### WS2.2 — Immutable audit trail
**Problem:** posted JEs are mutable; no append-only guarantee; SOX 404 fails.

**Schema — migration `0160_gl_immutability.sql`:**
- `journal_entries` becomes append-only: add `posted_at`, `reversal_of` (fk), `is_reversed`; DB trigger
  rejects UPDATE/DELETE on posted entries (correction = reversing entry only).
- `gl_audit_log` (entry_id, action, actor, ip/source, before/after hash, at) — write-once.
- Optional `gl_batch_seal` (period, batch hash chain) for tamper evidence.

**Service:** `reverseEntry(entryId, reason)` (maker-checker) creates the mirror entry; block all in-place
edits. Stamp `createdBy`/`source`/IP on every post (extend `PostingContext`).

**Endpoints:** `POST /api/ledger/entries/:id/reverse`, `GET /api/ledger/audit-log`.

**Docs:** narrative — audit trail & correction-by-reversal policy; RCM **GL-17 immutable audit trail**
(SOX 404 IT control), cross-ref ITGC; UAT: edit posted JE → DB rejects; reverse → mirror entry + audit row.

**Harness:** `compliance` — assert UPDATE on posted entry throws; reversal nets to zero.

### WS2.3 — AR/AP operational controls
**Problem:** aging is read-only; no credit limits/holds, no dunning enforcement, no allowance (only direct
write-off `writeOffAr`); 3-way match optional, not a payment gate.

**Schema — migration `0161_ar_ap_controls.sql`:**
- `customer_credit` (customer_id, credit_limit, hold flag, terms). `dunning_runs`/`dunning_letters`
  (level, sent_at). `ar_allowance` (period, method [%/aging-bucket], provision_amount) for doubtful debts.
- `ap_match_policy` (require_3way bool, tolerance) — enforced at payment.

**Service:** order-time credit check + auto-hold (hook into sales/POS via `PostingService` caller);
`runDunning` cascade (reuses BI scheduler `ar_collections_dunning`); `provisionAllowance` (Dr 5720/Cr
1109 contra-AR) at close; **gate `approveApPayment` on 3-way match** (today optional) — block pay if
unmatched beyond tolerance.

**Endpoints:** `POST /api/finance/credit/:customer`, `POST /api/finance/dunning/run`,
`POST /api/finance/allowance/provision`; extend AP payment approval with match gate.

**Docs:** narrative — collections/credit + allowance; RCM **REV-08/REV-12** deepen + **AP-03 3-way-match
payment gate**; user-manual — credit holds, dunning; UAT: over-limit order → hold; pay unmatched AP →
blocked; allowance posts contra-AR.

**Harness:** `basics` — credit hold blocks order; allowance reduces net AR; AP pay blocked without match.

---

## PHASE 3 — Statutory & multi-entity outputs

### WS3.1 — Thai tax compliance pack
**Problem:** invoices/WHT certs exist (`tax-docs`) but nothing **files**: no ภพ.30 VAT return, no
ภงด.1/3/53 aggregation, no remittance calendar, no e-Tax filing, no deferred tax.

**Schema — migration `0162_thai_tax_filing.sql`:**
- `vat_returns` (period, output_vat, input_vat, net_payable, status, filed_at, ref) built from tax invoices
  + AP input VAT. `wht_filings` (form [PND1|PND3|PND53], period, lines aggregated from WHT certs,
  remit_due_date, status). `tax_calendar` (tax_type, period, due_date, status) — VAT 15th, WHT 7th,
  PND50 within 150 days FYE.

**Service:** `tax-filing.service.ts` — `buildVatReturn(period)` (aggregate from tax-docs + ledger VAT
accounts 2100), `buildWht(form, period)`, `markFiled`, `taxCalendar()`. e-Tax: implement the
`etax-xml.ts` signing/submit (RD spec) behind the existing `EtaxService` seam.

**Endpoints:** `GET /api/tax/vat-return?period=`, `GET /api/tax/wht/:form`, `GET /api/tax/calendar`,
`POST /api/tax/file`. Web: `/tax/reports` gains VAT/WHT return generation + calendar.

**Docs:** narrative — Thai tax filing cycle + Mermaid; RCM **TAX-05 VAT/WHT filing & remittance**;
user-manual — generate ภพ.30/ภงด; UAT: build ภพ.30 ties to invoice list; WHT aggregates by form; calendar
flags overdue.

**Harness:** `taxdocs` — assert VAT return = Σ output − Σ input; WHT by income type sums correctly.

### WS3.2 — Deferred tax + multi-currency revaluation at close
**Problem:** book-tax diffs logged (`gaapComparison`) but never accrued (no DTA/DTL); no period-end FX
reval (FX exists but manual/transactional).

**Schema — migration `0163_deferred_tax_fx_reval.sql`:**
- `deferred_tax` (period, temp_diff, rate, dta_dtl, movement) posted Dr/Cr deferred-tax accounts (add
  1700 DTA / 2700 DTL / 5950 deferred-tax expense to CoA seed).
- `fx_reval_runs` (period, account, fx_rate, unrealized_gl) — auto AR/AP/bank reval.

**Service:** `accrueDeferredTax(period)` from TAX-vs-TFRS ledger diff; `revalueOpenItems(period)` auto-reval
of foreign-currency AR/AP at period-end rate (realized 5410 / unrealized 5400 already in CoA). Both are
**close-checklist steps** (WS2.1).

**Endpoints:** `POST /api/ledger/deferred-tax/accrue`, `POST /api/fx/revalue` (period).

**Docs:** narrative — deferred tax + FX reval; RCM **GL-18 FX revaluation**, **TAX-06 deferred tax**; UAT:
USD AR reval at new rate posts unrealized GL; temp diff posts DTA.

**Harness:** `worldclass` — reval moves AR balance by rate delta; deferred tax = temp_diff × rate.

### WS3.3 — Consolidation eliminations + segment reporting
**Problem:** consolidation is additive — **zero** intercompany elimination ⇒ overstated consolidated
equity; no TFRS 8 segments.

**Schema — migration `0164_consol_elim_segments.sql`:**
- `consol_elimination_rules` (group, pair_entities, account_pairs [IC AR↔IC AP, IC sales↔IC COGS]).
- `consol_runs` already exist — add `elimination` line-type generation. Segments derive from the WS1.3
  dimensions (branch/department) — `segment_definitions` (map dimensions → reportable segments).

**Service:** extend `consolidation.service.ts` — `generateEliminations(run)` nets IC 1150/2150 and
upstream/downstream profit; `segmentReport(period)` (revenue/result/assets by segment from GL dimensions).

**Endpoints:** `POST /api/consolidation/:run/eliminate`, `GET /api/consolidation/segments?period=`.

**Docs:** narrative — consolidation & eliminations + segment note; RCM **CON-02 IC elimination**,
**CON-03 segment reporting**; UAT: IC AR/AP net to zero in consolidated TB; segment report sums to total.

**Harness:** new/extended `worldclass` consolidation case — two entities with IC sale; assert eliminated.

### WS3.4 — Revenue recognition (TFRS 15)
**Problem:** revenue is straight-line deferral only (`revenue.service.ts`); no performance obligations,
multi-element, milestone, or refund liability.

**Schema — migration `0165_revrec_tfrs15.sql`:**
- `rev_contracts` (customer, total, currency). `performance_obligations` (contract_id, description, ssp
  [standalone selling price], allocation_pct, method [point-in-time|over-time|milestone]).
- `revrec_schedules` (po_id, period, amount, status). `refund_liability` (contract_id, expected_returns,
  provision).

**Service:** extend `revenue.service.ts` — `allocateByPSSP(contract)` (relative SSP allocation),
`recognize(period)` per PO method, `accrueRefundLiability`. Posts to 4000/2400 + new refund-liability
account.

**Endpoints:** `POST /api/revenue/contracts`, `POST /api/revenue/recognize`,
`GET /api/revenue/waterfall?period=`.

**Docs:** narrative — TFRS 15 revrec; RCM **REV-15 revenue recognition control**; user-manual — contracts &
recognition; UAT: 2-element contract allocates by SSP; milestone recognizes on completion; refund liability
accrues.

**Harness:** `basics`/`worldclass` — multi-element allocation sums to contract; over-time recognizes pro-rata.

---

## Sequencing, effort & dependencies

| Phase | Workstream | Rough effort | Depends on | CI gate |
|------|-----------|-------------|-----------|--------|
| 1 | WS1.1 CoA master | M | — | basics |
| 1 | WS1.2 Posting engine | **L** (incl. 28-caller migration) | WS1.1 | golden snapshot + basics |
| 1 | WS1.3 Dimensions | M | WS1.2 | basics |
| 1 | WS1.4 Sub-ledger control | M | WS1.1 | basics |
| 2 | WS2.1 Period close | M | WS1.4 | worldclass |
| 2 | WS2.2 Immutability | S–M | — | compliance |
| 2 | WS2.3 AR/AP controls | M | WS1.4 | basics |
| 3 | WS3.1 Thai tax pack | L | WS1.1 | taxdocs |
| 3 | WS3.2 Deferred tax + FX reval | M | WS2.1, WS3.1 | worldclass |
| 3 | WS3.3 Consol elim + segments | M | WS1.3 | worldclass |
| 3 | WS3.4 Rev rec TFRS 15 | M | WS1.2 | basics |

**Critical path:** WS1.1 → WS1.2 → (WS1.3, WS1.4) → Phase 2 → Phase 3. Ship as a stacked-PR series; expect
RCM-xlsx re-sync and migration renumber on each merge (CLAUDE.md gotchas).

**S ≈ a few days · M ≈ ~1–2 weeks · L ≈ ~3–4 weeks**, one engineer; Phase 1 is the bulk of the value.

## Migration ledger (indicative — renumber to next-free on merge, journal each)
`0155_coa_master` · `0156_posting_rules` · `0157_gl_dimensions` · `0158_subledger_tieout` ·
`0159_period_close` · `0160_gl_immutability` · `0161_ar_ap_controls` · `0162_thai_tax_filing` ·
`0163_deferred_tax_fx_reval` · `0164_consol_elim_segments` · `0165_revrec_tfrs15`.
Each new tenant table appends the RLS loop; each `.sql` appends a `meta/_journal.json` entry (sequential
idx, ascending when).

## New permissions (packages/shared/src/permissions.ts)
`gl_coa`, `gl_posting_rules` (Admin/Controller, maker-checker). Reuse existing `gl_post`, `gl_close`,
`approvals`, `creditors`, `ar`, `exec` elsewhere.

## New/changed RCM controls (regenerate Oshinei_ERP_SOX_RCM_v1.xlsx via build_rcm.py)
GL-11 CoA change · GL-12 posting-rule change · GL-13 dimension completeness · GL-14 sub-ledger tie-out ·
GL-15 period-close SoD · GL-16 closed-period prevention · GL-17 immutable audit trail · GL-18 FX reval ·
AP-03 3-way-match payment gate · TAX-05 VAT/WHT filing · TAX-06 deferred tax · CON-02 IC elimination ·
CON-03 segment reporting · REV-15 revenue recognition. Also mirror in
`tools/cutover/src/compliance.ts` test harness.

## Risks & mitigations
- **Posting-engine regression** → golden-snapshot parity test before any caller migrates; one module per PR.
- **drizzle 0.36 insert-path constraints** (don't bump to 0.45) → keep typed builders; avoid raw `sql`
  date params (known prod crash).
- **Closed-period hard lock breaks seeds/harnesses** → seeds post within open periods or via an explicit
  bootstrap bypass, never the removed `allowClosedPeriod`.
- **Backfilling branch on historical lines** → leave null (Unassigned) where source can't resolve; report
  shows an Unassigned column rather than guessing.
