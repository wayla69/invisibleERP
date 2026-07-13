# 46 — God-service regrowth audit & decoupling plan (2026-07-12)

> **Status:** Phases 0–3 DELIVERED (2026-07-12) — the service-size accretion ratchet is live in the
> `build` gate; the BI report dispatch is a provider registry (52 branches → module-owned
> `*-bi-reports.ts` generators, `bi-generate.service.ts` 777→336 LOC); GOV-01 pending-approvals is a
> contributor interface (14 of 17 queues → module-owned `*-approval-queues.ts` providers,
> `finance.service.ts` 938→916 LOC); and the ledger has a narrow read API (`LedgerReadService` —
> treasury-pool/revenue/BI direct journal reads migrated) guarded by the `check-import-boundaries`
> ratchet (23 grandfathered files, down-only). Phase 4a is COMPLETE (2026-07-13): `FinanceService`
> decomposed 916→380 LOC over 4 facade-preserving cuts (documents · advances · ap · ar) and off the
> size-ratchet grandfather list. Phase 4b is COMPLETE (2026-07-13): `CrmPipelineService` decomposed
> 1,109→545 LOC over 4 cuts (analytics · legacy adapter · lead engine · comms) and off the grandfather
> list (12→11). Phase 4c is COMPLETE (2026-07-13): `BillingService` decomposed 1,094→369 LOC over 4 cuts
> (stripe-gateway · tenant-provisioning · platform-admin · metering) and off the list (11→10). Phase 4d is
> COMPLETE (2026-07-13): the LINE webhook's 19 stateless command actions moved to
> `line-chat-actions.service.ts` with the ModuleRef lookups as explicit ports — controller file 978→593
> LOC and off the list (10→9); the full per-module handler REGISTRY is consciously deferred (see rev 1.0).
> Phases 4e and 5 below remain proposals. This is the follow-up
> to docs/38 (god-service decomposition, COMPLETE 2026-07-08): four days
> after that workstream closed, the decomposed facades are **re-accreting** and a second generation of god
> services (never in docs/38's scope) has kept growing. The plan below reuses the docs/38 recipe
> (characterization-first, facade-preserving, one sub-service per PR, golden-master gated) and adds the
> missing piece: **accretion guards** so the next feature wave can't silently regrow what we split.

## 1. What changed since docs/38 closed (the regrowth evidence)

docs/38 ended 2026-07-08 with: `bi` 1,211→532 · `projects` 1,659→1,151 · `procurement` 1,463→979 ·
`ledger` 1,266→689. As of 2026-07-12:

| Service | docs/38 end | Now | Δ | What accreted |
|---|---|---|---|---|
| `bi/bi-generate.service.ts` | 463 | 777 | **+68%** | Every new feature adds a report branch: CLS-01 flux, REV-27 disclosure pack, G4 `marketing_roi`, CRM-15 health snapshot, HR-9 workforce analytics (inline schema reads from 5 HCM domains) |
| `ledger/ledger.service.ts` | 689 | 926 | **+34%** | docs/43 posting-override API (GL-24: `postingOverrides`/`postingAccountSet`/`postingOverridesMany`), tie-out widening, plus the reporting + period/close clusters that were never extracted |
| `procurement/procurement.service.ts` | 979 | 1,010 | +3% | GRC-3 / MDM-01 wiring |
| `projects/projects.service.ts` | 1,151 | 1,162 | +1% | docs/43 PR-4 override wiring |
| `bi/bi.service.ts` | 532 | 536 | flat | — |

The mechanism, not the people, is the problem: the facade is the path of least resistance for a new
feature, and two of our own safety rails actively **encourage** appending to existing god services:

- **The goldenmaster positional-constructor contract** (docs/38 rev 0.3): new dependencies may only be
  *appended* to `BiGenerateService`'s constructor — so it now has **34 `@Optional()` cross-domain service
  params** (finance, assets, ledger, leases, revenue, projects, CRM ×3, loyalty, journeys, budget,
  procurement, match, billing, PDPA, governance, tax, HCM, flux, disclosure, marketing, vouchers, food-cost…)
  and every new schedulable job adds one more.
- **`generateReport` is a single 559-line if-chain** (`bi-generate.service.ts` L111–670) over **62**
  `reportType === '…'` branches. There is no registration seam, so a new report type *must* edit this method.

## 2. Risk areas (ranked)

### R1 — `BiGenerateService`: the fastest-growing coupling hub (HIGH)
- 34 `@Optional()` deps = a dependency on nearly every domain in the system; the DI graph makes BI a
  change-amplifier (any domain's constructor/API change ripples here).
- Several branches bypass owning modules and query foreign tables inline — e.g. `line_daily_digest`
  (L191–223) reads `workflow_instances`, `purchase_requests`, `alert_events`, `ar_invoices`, `branch_stock`
  **and computes the GL cash position by joining `journal_lines`⋈`journal_entries` directly** with the
  imported `CASH_ACCOUNTS` constant, instead of a `LedgerService` read API. HR-9 branches import tables
  from 5 HCM schema files directly into BI.

### R2 — `FinanceService.pendingApprovals` (GOV-01): the widest cross-domain read (HIGH)
`finance/finance.service.ts` L845–929 builds the pending-approvals center by issuing ~16 separate queries
against **other modules' tables**: draft journals (GL-05), AP payments (EXP-06), payruns (PAY-03), asset
revaluations/disposals (FA-08/09), inventory write-offs (INV-07), expense requests (EXP-08), till variances
(REV-13), refunds (REV-16), AR cash-apps (REV-21), netting (REV-23), FX rates (FX-04), posting-rule
overrides (GL-24), CoA change requests (GL-27), MDM batches/changes (MDM-03/01), budgets (BUD-01).
COA-D1 (#727) just added four more sources. **Every new maker-checker control must edit finance.service.ts**
— the same accretion mechanism as R1, and a pull-model read that bypasses every owning module's service.
`FinanceService` overall: 12 responsibility clusters, 11 constructor deps (8 `@Optional()`), and it is
**not** a facade over its module siblings (`collections`, `ap-payment-run`, `ar-cash-application`,
`finance-metrics` are co-wired in `finance.module.ts` but never injected) — it is a parallel god service.

### R3 — Never-decomposed god services (MEDIUM-HIGH)
- **`crm/pipeline/crm-pipeline.service.ts` (1,108):** 12 clusters — stage master, leads, lead→account/
  contact/opportunity conversion (writes `customer_master` directly), opportunity CRUD, the REV-17 stage
  machine, 6 read-only analytics aggregators, activities, web-to-lead + CSV/XLSX import (imports parsers
  from `masterdata.service`), **a parallel legacy `/api/pipeline` write surface over the same tables**
  (L711–864 — duplicate create/move/close paths that must be kept behaviourally in sync by hand), lead
  scoring, follow-up/round-robin/SLA sweeps, and outbound comms (email/LINE/SMS merge-field dispatch).
- **`billing/billing.service.ts` (1,094):** despite the name, mixes tenant-lifecycle/onboarding (signup,
  invites, approval, provisioning — incl. creating the Admin user and calling `ledger.provisionTenantCoA`/
  `provisionFiscalYear`), platform-console administration, **`factoryResetTenant`** (a runtime-enumerated
  raw `DELETE FROM <table> WHERE tenant_id=…` across every tenant table in the DB — the broadest write in
  the codebase), subscription/proration, **two near-duplicate overage-billing engines** (AI tokens
  L695–729 vs usage meters L783–818), plan-limit enforcement, and a Stripe adapter (`StripeBilling`)
  instantiated with `new` at three call sites instead of DI.
- **`messaging/line-webhook.controller.ts` (977):** ~40 business-logic methods in the *controller* file —
  chat-command router (~30 commands), PR/PMR approvals over chat, receiving/claims, AP-intake image capture,
  petty-cash, leave/ESS, digests, AI copilot — reaching **8 cross-module services lazily via
  `ModuleRef.get(…, {strict:false})`** (L53–81) to dodge circular imports. The lazy resolution hides these
  dependencies from the module graph entirely.
- **`ledger/ledger.service.ts` facade (926):** still holds 3 unextracted clusters — financial reporting
  (`trialBalance`/`incomeStatement`/`balanceSheet`/`accountLedger`/`perAccountNet`/`gaapComparison` +
  `aggregateByType`), period/close/year-end (`ensurePeriod`→`closeYear`, opening balances, accruals), and
  the GL-24 posting-override read API + cache.
- `assets.service.ts` (915) and `payments.service.ts` (736) are large but **single-domain and
  well-bounded** (assets: 5 required deps, no `@Optional()` sprawl; payments: narrowest cross-domain reach
  audited). Lower priority — split only opportunistically.

### R4 — Direct cross-domain table access instead of interfaces (MEDIUM)
- **`treasury-pool/pool.service.ts` L161–164 (`poolPosition`)**: raw `sql` join `journal_lines`⋈
  `journal_entries` to compute member balances — posts correctly via `LedgerService.postEntry` but *reads*
  the GL by reaching into ledger's tables.
- **`revenue/revenue.service.ts` L72**: reads `journal_entries` directly for a `source='REVREC'` entry-no
  lookup.
- **BI `line_daily_digest`** cash position (see R1).
- **`crm/crm.service.ts` `customer360`** (L215–281): aggregates across 8 domains' tables (loyalty, dine-in,
  NPS, promotions, pipeline, CPQ, orders, audit) directly.
- NB `finance.service.ts` `reconcileControls` (REC-04, L817–835) also reads five sub-ledgers directly —
  **this one is by design**: an independent cross-check *should* read both sides without going through the
  services it is reconciling. Keep, with a comment saying so.
- **Root enabler:** `database/schema/index.ts` is a **168-file flat `export *` barrel** — any module can
  import and join any domain's tables; nothing marks ownership. `app.module.ts` registers **146 modules in
  one flat array** with no domain grouping.

### R5 — Shared-file merge magnets (LOW-MEDIUM, velocity risk not correctness)
- **`ledger/posting-events.ts` (280 lines, 35 external importers):** the GL posting-event registry — a
  *deliberate* single source of truth (good), but every posting feature in every domain edits this one file
  (14 commits in two weeks; REV-27, TRE-01..05, TAX-11 all collided here). Same story as the docs/38-era
  `unit.test.ts` anchors.
- **Single-file `.module.ts` god files:** `customers.module.ts` (494 — two services incl. match-merge with
  raw `md_merge_repoint` SQL, three controllers, Zod DTOs, mappers, all inline), `crm/accounts` (310),
  `crm/account-depth` (331), `crm/account-health` (260) — same pattern.
- **`LedgerService` fan-in = 39 injecting files** across modules (vs `DocNumberService` 84, which is fine —
  it's a `common/` utility). High GL fan-in is inherent to an ERP, but it argues for a *narrow, stable*
  ledger read/post API (see Phase 3) rather than facade methods ad libitum.

## 3. Constraints any refactor must respect (unchanged from docs/38)
- Golden-master `parity/golden` (496 paths) must stay **identical without re-pin** on every extraction cut;
  goldenmaster constructs `BiService`/`ProjectsService`/`ProcurementService` **positionally** → sub-services
  are instantiated in the constructor **body** (docs/38 rev 0.6), new DI params append-only.
- Parity-locked blocks (`ห้ามเปลี่ยน — parity`) stay verbatim; no control moves without `check-rcm-census`
  staying green; SoD/maker-checker semantics (GL-05, EXP-06, REV-16/17, FA-07..13, CRM-08…) byte-identical.
- Harness gates per touched area: `basics`/`compliance`/`worldclass`/`multiledger` (ledger·finance),
  `writeflow`/`match` (procurement), `projects`, `bi`/`bi-cache`/`async-jobs`, `restaurant` (LINE), plus
  `grep -ln "<endpoint>" tools/cutover/src/*.ts tools/parity/src/*.ts` before every push (mantra #11).
- Ratchets flat (`check-ts-debt`, `check-use-client`); one sub-service per PR; docs-sync per policy.

## 4. Refactoring plan — step by step

**Sequencing logic: stop the growth mechanisms first (Phases 0–3), then shrink the stock (Phase 4), then
hygiene (Phase 5).** Phases 0–3 are small, high-leverage PRs; Phase 4 is the docs/38 recipe replayed on the
second generation.

### Phase 0 — accretion guards (1 PR, no behaviour change)
1. Add `tools/ci/check-service-size.mjs` to the `build` job, mirroring the existing down-only ratchets:
   baseline JSON of `{file → LOC, constructorParams}` for `apps/api/src/modules/**/*.service.ts` (+ the
   webhook controller). Fails when a file **over 600 LOC grows further**, or when any constructor exceeds
   its baselined param count. Effect: a new feature can still ship, but the cheap move becomes "new
   sub-service file" instead of "append to the facade". Grandfather everything current; the baseline only
   goes down (same `_note` convention as `ts-debt-baseline.json`).
2. Record the rule in this doc + `docs/07-backend.md`: *new BI report types, new pending-approval sources,
   and new LINE chat commands land as registered providers (Phases 1–2, 4d), never as new branches in the
   dispatcher.*

### Phase 1 — BI report dispatch → provider registry (2–3 PRs; kills the R1 mechanism)
1. **PR-1 (seam):** extend `bi/report-registry.ts` with a `BiReportProvider` interface
   (`{ type: string; generate(f, user, reads): Promise<{data; summary; summaryTh}> }`) and a registration
   map on `BiGenerateService` (`registerProvider(p)` called from each owning module's `onModuleInit`).
   `generateReport` checks the map first, else falls through to the existing if-chain. Zero behaviour
   change; golden identical (dispatch order: map is only consulted for types not in the chain — migrate a
   branch by *moving* it, never duplicating).
2. **PR-2 (mechanical migration):** move the ~35 one-liner branches that only call an owning service
   (`ar_collections_dunning`→collections, `eam_pm_generate`→eam, `flux_analysis`→flux, `crm_*`→crm modules,
   `marketing_roi`→marketing, …) into `XxxBiProvider` classes registered by their home modules. Each
   migrated branch deletes one `@Optional()` ctor dep **once all its branches have moved** — ctor params are
   append-only per the goldenmaster contract, so removals happen from the END only, verified by the golden
   gate; params not yet removable stay as dead-but-positioned optionals until a conscious golden re-pin PR.
3. **PR-3 (inline-SQL branches):** the branches with embedded cross-domain queries (`line_daily_digest`,
   HR-9 workforce analytics, `cdp_export_sync` batching) move behind their owning modules' services
   (`LedgerService` cash position — see Phase 3; HCM analytics → an `hcm` read service). BI keeps only
   formatting.

   Exit criterion: `bi-generate.service.ts` ≤ ~150 LOC of dispatcher + the 4 `reads.*` pilot branches;
   adding a report type touches only the owning module + registry test.

### Phase 2 — GOV-01 pending-approvals → contributor interface (2 PRs; kills the R2 mechanism)
1. **PR-1:** define `PendingApprovalsProvider { source: string; pending(user, db): Promise<PendingItem[]> }`
   (in `common/` or a tiny `governance-center` module). `FinanceService.pendingApprovals` aggregates
   registered providers + the not-yet-migrated inline queries; output shape, sort, `by_type`, `total_amount`
   byte-identical (this endpoint is UI-consumed; add a `basics`/`compliance` characterization assert on the
   full shape *before* the seam PR).
2. **PR-2..n (mechanical, several sources per PR):** each owning module (ledger, payroll, assets, inventory,
   payments, fx, masterdata, budget…) implements its provider with the query moved verbatim next to its
   domain. Finance keeps only its own AP/AR sources + the aggregator. New controls (the next COA-D*) then
   register a provider instead of editing finance.

### Phase 3 — ledger read API + import-boundary ratchet (2 PRs; kills R4's worst cases)
1. **PR-1:** add narrow read methods on `LedgerService` (delegating to existing internals):
   `accountNet(accountCodes, {from,to,tenantId,ledgerCode})` (wraps the `perAccountNet`/`aggregateByType`
   machinery) and `entryExists(source, sourceRef)` (generalizes `alreadyPosted`). Migrate the three known
   offenders: `treasury-pool.poolPosition` (raw join L161–164), `revenue.service.ts` L72 entry-no lookup,
   BI cash position. Golden + `basics`/`worldclass` identical.
2. **PR-2:** add a down-only import-boundary ratchet (extend `check-service-size.mjs` or a sibling script):
   count files outside `modules/ledger/` importing from `database/schema/ledger` — baseline now, fail on
   increase. This is the enforceable version of "use the interface, not the tables", without boiling the
   168-file schema barrel (which stays — too invasive to break). Later waves can add baselines per domain
   (assets, payroll…) as their read APIs firm up.

### Phase 4 — decompose the second-generation god services (docs/38 recipe replayed)
Order: highest control-density last within each service; characterize before every cut; one sub-service per
PR; ctor-body construction; golden/harnesses identical.

- **4a `FinanceService` (937 → target ~300 facade).** Gates: `basics` 293 + `compliance` + `writeflow`
  (constructs FinanceService by hand — ctor is a positional contract, same rule as goldenmaster). Cuts, in
  order: (1) `finance-documents.service` — statements/receipt/invoice print+email (pure reads, PDF/email
  ports); (2) `finance-advances.service` — EXP-07 issue/settle/list (commitments port); (3)
  `finance-ap.service` — `createApTxn` + EXP-06 request/approve/reject + TAX-03 WHT; (4)
  `finance-ar.service` — `syncArInvoices`/`createReceipt`/REV-14 write-offs; `pendingApprovals` already
  shrank via Phase 2; `reconcile`/`reconcileControls` (REC-04) stays on the facade by design.
- **4b `CrmPipelineService` (1,108 → target ~400).** Gates: crm harnesses + `bi` (BI calls `winLoss`/
  `funnel`/`sourceRoi`/`forecast`/`runFollowUpSweep`). Cuts: (1) **first retire the duplicate legacy
  `/api/pipeline` surface** — fold L711–864 onto the primary methods behind the existing thin
  `pipeline.service.ts` adapter (shape-compat mappers), deleting the parallel write path *before* splitting
  (otherwise every split doubles); (2) `crm-analytics.service` — the 6 read-only aggregators; (3)
  `crm-lead-engine.service` — scoring + round-robin + follow-up/SLA sweeps (REV-22); (4)
  `crm-comms.service` — merge-fields + send + activity stamping; the REV-17 stage machine + conversion
  spine stays on the facade (most control-sensitive, matches "posting last" from docs/38).
- **4c `BillingService` (1,094 → target ~350).** Gates: `onboarding`/`pg-core` + billing harnesses. Cuts:
  (1) `StripeGateway` becomes an injected provider (kills the three `new StripeBilling()` sites; unit-testable);
  (2) `tenant-provisioning.service` — signup/invites/requests/provision/factory-reset (AC-18, L-4 checks
  verbatim; ledger provisioning stays a port); (3) `platform-admin.service` — list/detail/suspend/tags/
  extend-trial (the `/platform` console surface); (4) `metering.service` — **unify** the AI-token and
  usage-meter overage engines into one parameterized runner (the only cut in this whole plan that is a
  behaviour-affecting dedup — do it last, characterize both paths first, keep the two UNIQUE-key idempotency
  schemes byte-identical).
- **4d `LineWebhookService` (977 → controller ~150 + handlers).** Gate: `restaurant` + messaging harnesses.
  Same registry pattern as Phase 1: `ChatCommandHandler { match(text): boolean; run(ctx): Promise<void> }`
  registered per owning module (procurement registers approve/receive/low-stock/reorder; finance registers
  petty-cash; hcm registers leave; ai registers ask/copilot…). The controller keeps only webhook plumbing
  (signature verify, dedup, throttle, routing). This also converts the 8 `ModuleRef.get` hidden deps into
  explicit per-module registrations.
- **4e `ledger.service.ts` facade round 2 (926 → ~400).** LAST, per docs/38 §4. Cuts: (1)
  `ledger-reporting.service` — trialBalance/IS/BS/accountLedger/perAccountNet/gaapComparison +
  `aggregateByType` (feeds Phase 3's `accountNet`); (2) `ledger-periods.service` — ensurePeriod→closeYear,
  opening balances, `accrueLiability`; (3) move the GL-24 posting-override API + cache into
  `posting.service.ts` (its natural home — it already owns override governance). Gated on
  `basics`+`compliance`+`worldclass`+`multiledger` identical.

### Phase 5 — hygiene (opportunistic, bundle with feature PRs touching those files)
- Split the single-file `.module.ts` god files (`customers`, `crm/accounts`, `crm/account-depth`,
  `crm/account-health`) into conventional `service/controller/dto` files — pure moves, no DI change.
- Split `posting-events.ts` into per-domain definition files (`posting-events.treasury.ts`, `.revenue.ts`,
  …) composed into the same exported `POSTING_EVENTS` registry — semantics and `assertPostingEventDefaults`
  unchanged, merge conflicts localized. Keep `postingDefault()` as the single API.
- Group `app.module.ts`'s 146 imports into ~10 domain aggregate modules (`FinanceDomainModule`,
  `CrmDomainModule`, …) — cosmetic for DI but makes ownership legible and shrinks the flat-array conflict
  surface.

## 5. What this does NOT propose
- No breaking of the schema barrel, no repo split, no event-bus/microservice detour — the modular monolith
  with enforced boundaries is the right shape for this codebase's SOX posture (one DB transaction per
  control remains a feature, not a bug).
- No touching of `assets.service.ts` / `payments.service.ts` beyond the size ratchet — both are large but
  single-domain and internally coherent.
- No golden-master re-pin except the single conscious ctor-param-removal PR at the end of Phase 1 and the
  Phase 4c metering dedup — both explicitly characterized first.

## 6. Effort & sequencing honesty
Phases 0–3 ≈ 6–9 small PRs of mostly mechanical moves with outsized leverage (they stop the regrowth that
would otherwise consume Phase 4's gains). Phase 4 is the expensive part — 12–16 PRs of docs/38-style careful
extraction; like docs/38 §6, it should run as a background track and never bundle with feature work. Every
PR lands with its harness list green and this doc's revision history updated.

## Revision history
| Version | Date | Author | Change |
|---------|------|--------|--------|
| 1.0 | 2026-07-13 | Platform / IT | Phase 4d delivered — `line-webhook.controller.ts` 978→593 LOC, off the grandfather list (10→9). The 19 STATELESS command actions (approve/reject PR+PMR, my-prs carousel, receive/claim, low/reorder/spend/find/cancel/stock, create-PR parser, pr-status, petty-cash, leave, digest + low-stock-alert subscribe/unsubscribe, digest-kpis, ask) moved VERBATIM to `line-chat-actions.service.ts`; the 6 `ModuleRef.get` lazy lookups stay on the webhook (the Messaging→Procurement→…→Messaging cycle forces them) but are handed down as an explicit `ChatActionPorts` interface, so the cross-module reach is declared in one place. The webhook keeps the matcher/dispatch (the routing table — precedence IS behaviour), throttle/dedupe/reply plumbing, and the STATEFUL flows (attach/capture photo states, replay-safe postback confirm, copilot drafts). **Scope note vs the original 4d plan:** the per-module `ChatCommandHandler` registry is consciously DEFERRED — converting the precedence-sensitive matcher on the most brittle interactive surface bought risk without shrinking anything further; revisit when a second chat channel needs the same commands. Gated: line-crm 143 · restaurant 186 · unit 472; ratchets green. |
| 0.9 | 2026-07-13 | Platform / IT | Phase 4c delivered — `BillingService` decomposition per the docs/38 recipe, 4 cuts / 2 commits, gated on onboarding 86 + sub-billing 6 (+ pg-core 15 · bi 44 · async-jobs 26 · golden 518 on completion). Cut 1 `stripe-gateway.ts` (the StripeBilling adapter; ONE shared instance replaces three ad-hoc `new StripeBilling()` sites; re-exported). Cut 2 `tenant-provisioning.service.ts` (ITGC-AC-18 signup gate — `isSignupAllowed`/`SignupDto` move with it, re-exported for the controller + unit test; invites, approval queue, `provisionTenant` incl. the L-4 reserved-username refusal + org self-link, `factoryResetTenant` verbatim, `resolveTenantId`). Cut 3 `platform-admin.service.ts` (cross-company directory/tags/AI-spend/detail/trial/suspend/reactivate). Cut 4 `billing-metering.service.ts` (AI ceiling+overage + e-Tax/POS meters + idempotent runs; **the AI and generic engines deliberately remain two code paths** — the plan's unification is a behaviour-affecting dedup deferred until characterized). Facade 1,094→**369 LOC** (plans seed/catalogue, subscription read/changePlan proration, checkUserLimit, checkout + Stripe webhook state machine, delegators); ctor untouched; off the grandfather list (11→10). No API/behaviour change → no narrative/UAT/RCM impact. |
| 0.8 | 2026-07-13 | Platform / IT | Phase 4b delivered — `CrmPipelineService` decomposition per the docs/38 recipe, 4 cuts, each its own commit, gated on pipeline 116 every cut (+ crm 56 / line-crm 143 / bi 44 / golden 518 on the relevant ones). Cut 1 `crm-pipeline-analytics.service.ts` (pipelineSummary, winLoss, CRM-5 funnel/velocity, sourceRoi, forecast — fully self-contained, zero ports). Cut 2 `crm-pipeline-legacy.service.ts` (the Batch 2A `/api/pipeline` adapter: OPP-%05d numbering + fmtOpp shapes over the SAME unified spine; stage-machine primitives as callback ports so REV-17 terminal-state + the stage audit stay single-sourced; `StageRow` exported type-only). NOTE vs the original 4b plan: the audit-era "duplicate legacy write path" turned out to already be single-spine by design (CRM-1) — so the cut EXTRACTS the adapter instead of deleting a write path. Cut 3 `crm-lead-engine.service.ts` (versioned scoring — LEAD_SCORE_VERSION/COEFFS move with the scorer, re-exported; follow-up settings + round-robin, `nextRoundRobinOwner` public for createLead's auto-assign; REV-22 follow-up center + sweep; ports leadByNo/emitEvent). Cut 4 `crm-pipeline-comms.service.ts` (merge fields, email/LINE/SMS dispatch, CRM-6 thread token; port oppByNo). Facade 1,109→**545 LOC** — keeps stages master, leads CRUD + conversion, opportunities CRUD, the REV-17 stage machine, activities, webToLead/importLeads, shared privates + shapes, and 24 delegators; ctor untouched. Off the size-ratchet grandfather list (12→11). No API/behaviour change → no narrative/UAT/RCM impact. |
| 0.7 | 2026-07-13 | Platform / IT | Post-merge follow-up (the TODO noted in PR #740's merge commit): the three report types that landed on main during the merge window moved from bi-generate's legacy chain into Phase-1 providers — `crm_forecast_snapshot` → `CrmForecastBiReports` (inline in `crm/forecast/crm-forecast.module.ts`, single-file-module style), `menu_affinity` → `analytics/analytics-bi-reports.ts`, `audience_export_sync` (PDPA-05, verbatim incl. both fail-closed gates + the append-only register) → `crm/crm-bi-reports.ts` beside its sibling `cdp_export_sync`. bi-generate 415→336 LOC; the just-merged dead ctor params (`crmForecast`/`menuEng`) removed (nothing constructs BiGenerateService positionally). Verified: golden 518 identical; bi 44 · async-jobs 26 · pdpa 32 · pipeline 116 · menu-engineering 13; ratchets flat. No API/behaviour change. |
| 0.6 | 2026-07-13 | Platform / IT | Phase 4a delivered — `FinanceService` decomposition per the docs/38 recipe, 4 cuts, each its own commit, all gated on writeflow 36 (the positional 3-arg construction canary) + basics 414, with compliance 179 / worldclass 59 / golden 518 / refund-approval 9 / unit 464 on the control-bearing cuts. Cut 1 `finance-documents.service.ts` (statements of account + running-balance engine, AR billing-invoice + receipt-voucher print/email; `sellerFor`/`toStatementPrint`/`buildStatement` move as privates). Cut 2 `finance-advances.service.ts` (EXP-07 issue/settle/list + M4 project dimension + FU1 commitment consumption). Cut 3 `finance-ap.service.ts` (createApTxn incl. ภ.พ.36 reverse-charge; EXP-06 request/approve/reject SoD; TAX-03 WHT; Phase-16 match gate) — the shared `vatSplit`/`vatLegFromCode` stay on the facade as callback ports. Cut 4 `finance-ar.service.ts` (syncArInvoices + createReceipt + REV-14 write-off; `listWriteOffs` register deliberately stays on the facade — it reads journal tables the boundary ratchet grandfathers there). All sub-services are plain classes constructed in the facade ctor BODY; every public method keeps a thin delegator; ctor untouched. facade 916→380 LOC, off the size-ratchet list (13→12 grandfathered). No API/behaviour change → no narrative/UAT/RCM impact. |
| 0.5 | 2026-07-12 | Platform / IT | Phase 3 delivered: ledger read API + import-boundary ratchet. New `modules/ledger/ledger-read.service.ts` (`LedgerReadService`, exported by LedgerModule) — deliberately narrow: `accountNet(accounts, {tenantId, asOf})` (Σ debit−credit over Posted entries), `cashPosition(tenantId)` (the CASH_ACCOUNTS classifier stays with the ledger), `entryRefNo(source, sourceRef)` (crash-recovery companion of `alreadyPosted`). The three audited offenders migrated: treasury-pool `poolPosition`'s raw `journal_lines⋈journal_entries` join → `accountNet`; revenue's REVREC entry-no lookup → `entryRefNo`; BI `line_daily_digest`'s cash position → `cashPosition` (removing the last journal-table + `CASH_ACCOUNTS` imports from BI; `LedgerReadService` appended as bi-generate's END ctor param per the positional convention). Guard: `tools/ci/check-import-boundaries.mjs` + `ledger-boundary-baseline.json` in the `build` gate — files outside `modules/ledger` referencing `journalEntries`/`journalLines` are grandfathered (23, was 26 pre-migration; finance's REC-04 reconcile + consolidation eliminations stay by design) and the set may only shrink; detector is by-identifier so both barrel and direct-path imports count. Verified: golden 518 identical; treasury-pool 46 · revrec 34 · bi 44 · async-jobs 26 · line-crm 143 · basics 414; unit+coverage 464; ts-debt + service-size flat; ratchet failure mode probed (new-file offender fails). Doc-sync: CLAUDE.md build-gate bullet (three→four ratchets + LedgerReadService recipe), docs/07-backend.md §8. No API/behaviour change → no narrative/UAT/RCM impact. |
| 0.4 | 2026-07-12 | Platform / IT | Phase 2 delivered: GOV-01 pending-approvals → contributor interface. `common/approval-queues.ts` defines `ApprovalQueue`/`ApprovalQueueSource` + the shared `approvalAgeDays`; `ApprovalQueueRegistrarService` (finance module) discovers sources app-wide at boot (same `DiscoveryService` pattern as Phase 1); `FinanceService.pendingApprovals` aggregates queues in a canonical `QUEUE_ORDER` matching the historical inline order, so the stable age-sort's tie order — and therefore the full response — is byte-identical. **14 of 17 queues moved verbatim** to 9 module-owned `*-approval-queues.ts` providers: ledger (GL-05/BANK-02 drafts, GL-24 posting rules, GL-27 CoA changes), payroll (PAY-03), assets (FA-08/FA-09), inventory (INV-07), petty-cash (EXP-08), payments (REV-13/REV-16), fx (FX-04), masterdata (MDM-03/MDM-01), budget (BUD-01); finance keeps only its own EXP-06/REV-21/REV-23 inline. finance.service.ts 938→916 LOC (13 dead schema imports pruned; baseline ratcheted). Future maker-checkers register a queue from their owning module — the next COA-D* stops editing finance. Verified: golden 518 identical; writeflow 36 (hand-constructed FinanceService unaffected — registry empty ⇒ inline-only, and writeflow never calls pendingApprovals) · refund-approval 9 · basics 414 · compliance 179 · worldclass 59; unit+coverage 464; ts-debt 51/51 flat. Doc-sync: CLAUDE.md finance feature-map bullet, docs/07-backend.md §8. No API/behaviour change → no narrative/UAT/RCM impact. |
| 0.3 | 2026-07-12 | Platform / IT | Phase 1 delivered (seam + migration in two commits): `report-registry.ts` gains `BiReportGenerator`/`BiReportSource`; `BiReportRegistrarService` discovers `biReports()` providers app-wide via `@nestjs/core` `DiscoveryService` at boot (no module-graph edge into bi, no ctor change — positional goldenmaster contract intact); `generateReport` consults the registry before the legacy chain. **52 branches moved verbatim** to 26 module-owned `*-bi-reports.ts` providers (incl. the five HR-9 inline-SQL workforce reports → `hcm/hcm-bi-reports.ts` and `cdp_export_sync` → `crm/crm-bi-reports.ts`, removing 6 foreign-schema imports from BI). Remaining on bi-generate by design: the 4 read-port types, `exec_scorecard` + `marketing_roi` composites, `line_daily_digest` (Phase 3 ledger-read-API case), `data_retention_purge`, `key_rotation_sweep`. bi-generate 777→336 LOC (off the size-ratchet grandfather list, 14→13); unused `@Optional()` ctor params stay dead-but-positioned pending a conscious golden re-pin PR. Verified: golden 518 identical (no re-pin); bi 44 · async-jobs 26 · basics 414 · worldclass 59 · compliance 179 · hcm-analytics 23 · revrec 34 · pipeline 108 · line-crm 143 · cashreport 34 · projects 259 · module-qr 73; unit+coverage 464 (new `test/tax-bi-reports.test.ts` covers the tax provider per the scoped coverage gate); ts-debt 51/51 flat; use-client 280 flat. Doc-sync: CLAUDE.md action-jobs bullet, docs/07-backend.md §8. No API/behaviour change → no narrative/UAT/RCM impact. |
| 0.2 | 2026-07-12 | Platform / IT | Phase 0 delivered: `tools/ci/check-service-size.mjs` added as the third down-only ratchet in the `build` gate. Baseline grandfathers the 14 module files over 600 LOC at their exact LOC + ctor-param counts (both down-only); any new module file over 600 LOC fails; scope = every non-test `.ts` under `apps/api/src/modules` (services, controllers, single-file `.module.ts`) so logic can't dodge the suffix. Verified all three modes locally (pass · grandfathered-growth fail · new-file fail). Doc-sync: CLAUDE.md ratchet bullet, docs/07-backend.md §8 log. No app behaviour change → no narrative/UAT/RCM impact. |
| 0.1 | 2026-07-12 | Platform / IT | Initial audit: regrowth measurements post-docs/38 (bi-generate +68%, ledger facade +34%), second-generation god services (crm-pipeline, billing, finance, line-webhook), cross-domain table access inventory (GOV-01 16-table aggregator, treasury-pool/revenue direct GL reads, 34-dep BiGenerateService), coupling hubs (posting-events 35 importers, LedgerService 39, flat 168-file schema barrel, 146-module flat app module), and the phased decoupling plan (accretion guards → BI provider registry → GOV-01 contributor interface → ledger read API + boundary ratchet → second-generation decomposition → hygiene). Analysis only — no code changes. |
