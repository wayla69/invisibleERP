# 50 — Project Material Control · Record-to-Report · POS Sale — Further Development Phase

> **Date:** 2026-07-16 · **Status:** v0.6 — **Waves 1–4 DELIVERED** (12 phases); Wave 5 planned (B5 · A5 · C5-external) · **Owner:** ERP / Product
> **Scope:** the next development phase across three cycles the business runs on daily:
> **(A) Project material control** (docs/32 + docs/35 spine), **(B) Record-to-report** (PN-04 GL close
> spine, docs/17/18/35), **(C) POS sale** (`docs/pos-worldclass-roadmap.md` + docs/41 hub spine).
> **Discipline (same as docs/19/20/23/44):** each phase is an independently-shippable, doc-synced PR —
> migration + module + permissions/SoD + a **new RCM control** where a control changes (`build_rcm.py` →
> regen xlsx + census markers) + process-narrative + user-manual + UAT + cutover-harness — merged only on a
> fully-green CI matrix.

---

## 0. Read this first — all three cycles are already mature; this phase is *depth*, not rebuild

A codebase audit (2026-07-16) confirmed the delivered baseline below. Do **not** re-propose any of it.

- **A — Project material control** (docs/32 v1.4 ALL DELIVERED + FU1–FU4; docs/35 P0–P5 + D1–D5):
  BoQ create/approve/lock/remeasure (`modules/projects`), commitment/encumbrance ledger
  (`modules/commitments`, PROJ-12 `BUDGET_EXCEEDED`), PMR within/over-budget maker-checker
  (`modules/pmr`, PROJ-13) + LINE one-tap approval, PROJ-15 BoQ scope-change requests
  (`project_boq_change_requests`), stock reservations → issue-to-project WIP posting
  (`modules/reservations` + `inventory-ledger.service.ts` `issueToProject`, INV-13), project site cash
  (PROJ-14), the budget-restricted project shop (`/shop/project/[code]`), progress billing / subcontracts /
  tenders / earned schedule (PROJ-16..19). Harness: `tools/cutover/src/projects.ts` §9b–9i (165 checks).
- **B — Record-to-report** (PN-04): balanced-by-construction posting + period lockout + idempotency
  (GL-01/02/04), JE maker-checker incl. opening balances (GL-05), distinct-reverser (GL-17), recurring /
  prepaid / allocation jobs (GL-08/09/23), CoA governance (GL-10/11/27), posting-override governance
  (GL-24, `posting-events*.ts`), hard close + fixed 9-step checklist + pre-lock validation
  (GL-15/16/16b/19, `modules/ledger/close.service.ts`), Close Cockpit (GL-22,
  `finance-metrics.service.ts` `closeStatus`), flux w/ forced explanations (GL-25), disclosure checklist
  (GL-26), deferred tax (TAX-06), FX reval (GL-18), consolidation + eliminations + segments (CON-01/02),
  IC recon (REC-03), control-account recon pack (REC-04), account-recon workspace (REC-01), bank rec
  (REC-02/05), GOV-01 unified pending-approvals.
- **C — POS sale**: dine-in lifecycle + KDS + tables/QR + buffet + channels (`modules/restaurant`), touch
  register `/pos/register` (offline-capable PWA) + hold/recall + manager-override audit
  (`modules/pos/control`), split/pay-multi, till open/close + X/Z reports + cash-variance posting
  (`payments.service.ts`, `TILL.VARIANCE` 5830), hash-chained fiscal journal + e-Tax providers
  (`pos/fiscal`), receipts HTML/ESC-POS + WebUSB/WebSerial peripheral bridge, card-terminal *framework*
  (`pos/terminal/providers.ts`), delivery-aggregator adapters + auto-86 (`modules/channel-adapter`),
  LAN-first store hub replay (`modules/hub`, docs/41), loyalty/gift-cards/house-accounts/timeclock
  (`pos/labor`), recipe→COGS deduction, TFRS-15 loyalty accrual at close
  (`ledger-periods.service.ts` `accrueLiability`). Harnesses: `restaurant`, `hub-snapshot`, `pos-p0`,
  `tips`, `splitbill`, `cashreport`.

### Grounding for every build wave (verify LIVE at build time — main is very active)

- **Migration number:** take the **live next-free 4-digit number** in `apps/api/drizzle/` at each PR's
  build (recent merges are past `0318`; expect renumbering at every main merge — CLAUDE.md mantra #10).
- **RCM control ids:** per-domain sequences move as concurrent PRs land — read the current max from
  `compliance/build_rcm.py` before assigning (e.g. PROJ-19 is already taken by earned schedule; an "INV-14"
  candidate below collides with a restaurant control tag — always re-derive). After any `add(...)`, run
  `node tools/ci/check-rcm-census.mjs` and bump the tagged census spans.
- **Canonical RLS:** every new tenant table copies `0232_reapply_org_rls.sql`'s org-clause loop body + a
  leading `(tenant_id, …)` index; **grep every writer** of a newly tenant-scoped table (mantra: 0316
  breakage).
- **Ratchets:** new logic lands as its own sub-service/registered provider (`check-service-size`); new
  report types = catalog entry + `*-bi-reports.ts` provider; new approval queues = `ApprovalQueueSource`
  provider; changes to `createGr`/ledger/procurement/bi outputs re-pin the golden master consciously.

Effort key: **S** ≈ 1–2 days · **M** ≈ 3–5 days · **L** ≈ 1–2 weeks.

---

## Track A — Project material control: close the physical-loop gaps

The delivered spine controls *acquisition* (budget → commit → requisition → issue). What's missing is the
**return half of the loop** and the **analytics that make a PM trust the numbers**. docs/32 §10 explicitly
parked A4 as a fast-follow.

### A1 — Material return-to-stock (reverse issue of unused material) · Effort **M** · the control gap · **✅ DELIVERED (2026-07-16)**
> Delivered: **NEW control INV-19** (RCM 296), migration `0420` `project_material_returns`;
> `returnFromProject` in the valued sub-ledger (Dr inventory / Cr 1260 `project_id`, original issue cost,
> idempotent per `MRET`); governed request/approve flow on reservations (qty ≤ issued aggregate, reason
> mandatory, ≥ ฿1,000 maker-checker); negative consumed commitment un-draws the BoQ line; คืนวัสดุ web
> action + returns table. ToE `projects` 336→351; PN-16 §7(27b) rev 0.57; manual 14 rev 2.37;
> UAT-O2C-502..507.
**Goal:** site returns unused material; stock, WIP, and the BoQ budget all move back — today there is *no
path* (`issueToProject` has no inverse), so returns are done as ad-hoc adjustments outside the control.
- `inventory/inventory-ledger.service.ts`: add `returnFromProject` (Dr 1200 / Cr 1260 project-WIP at the
  original issue cost, `project_id` dimension, idempotent per return doc).
- `reservations/reservations.service.ts`: `returnToStock(reservationId | issueRef, lines)` — restores
  on-hand, and un-consumes the BoQ-line commitment via `commitments.service.ts` (FOR UPDATE on the line,
  never below zero consumed).
- Endpoint `POST /api/reservations/:id/return` (+ list of open issues on the project); web: a **คืนวัสดุ**
  action on the `/projects/[code]` "จองสต๊อก" tab and in the project shop history.
- **Control (new INV-xx, next free id):** returns require a reason code + are maker-checker above a
  tenant threshold; quantity returned ≤ quantity issued (aggregate per line).
- Harness: extend `tools/cutover/src/projects.ts` §9f — issue → partial return → WIP/stock/commitment all
  reconcile; over-return rejected; idempotent replay.

### A2 — Reservation aging + auto-release sweep · Effort **S** · quick win · **✅ DELIVERED (2026-07-16)**
> Delivered: `reservations.service.ts` `expireStale` (release-only, idempotent; TTL default 30d) +
> `POST /api/reservations/expire-stale`; scheduler job `reservation_stale_release` via the new
> `reservations/reservations-bi-reports.ts` provider; `reservation_stale` action-center exception.
> ToE `projects` 330→336; PN-16 §7(27) rev 0.56; manual 14 rev 2.36; UAT-O2C-498..501.
**Goal:** stale `held` reservations silently starve other projects' availability.
- `reservations.service.ts` `expireStale(tenantId, maxAgeDays)` releasing holds past a per-tenant TTL
  (default 30d, `receiving_settings`-style config); ride the BI scheduler as an idempotent action job
  (`reservation_stale_release`) — generator in the owning module's `*-bi-reports.ts` provider.
- New `reservation_stale` exception in the projects action center (`projects.service.ts` `actionCenter`,
  PROJ-11 bus) so planners see aging holds *before* the sweep releases them.
- Harness: seed an old hold → sweep releases + action-center row; fresh hold untouched; re-run = no-op.

### A3 — Material control tower: WBS rollup + planned-vs-actual draw curve · Effort **M** · **✅ DELIVERED (2026-07-16)**
> Delivered: `GET /api/projects/:code/boq/by-wbs` + `GET /api/projects/:code/material-draw` (NEW
> `projects-material.service.ts` read models over the commitment ledger — issued=RES, returned=MRET);
> WBS rollup + draw tables on the BoQ tab. ToE `projects` 351→357; PN-16 rev 0.58; manual 14 rev 2.38;
> UAT-O2C-508..510.
**Goal:** answer "are we drawing material faster than the plan?" per WBS node — the data exists
(`project_boq_lines.task_id`/`wbs_code`, commitments, reservations) but nothing aggregates it.
- `GET /api/projects/:code/boq/by-wbs` (extend `projects.service.ts` `getBoq`): budget / committed /
  issued / returned / remaining rolled up by WBS node and BoQ category.
- Draw S-curve: planned issue (budget spread over the task window) vs actual cumulative issue from the
  reservation/commitment history — read model beside `projects-evm.service.ts` (no new writes).
- Web: a chart + WBS tree on the `/projects/[code]` **BoQ & งบวัสดุ** tab; over-draw rows feed the
  action center.
- Harness: seeded issues across two WBS nodes roll up correctly; curve monotonic; return (A1) reduces it.

### A4 — BoQ Excel/CSV takeoff import · Effort **M** · docs/32 §10 explicit fast-follow · **✅ DELIVERED (2026-07-16)**
> Delivered: `POST /api/projects/:code/boq/import` + template endpoint (NEW `projects/boq-import.service.ts`
> over the masterdata parse utils; fail-closed all-or-nothing with per-row `details.errors`; described
> unknown items import with a warning); DRAFT-only — PROJ-12 unchanged; paste-CSV dialog on the BoQ tab.
> ToE `projects` 357→362; PN-16 rev 0.59; manual 14 rev 2.39; UAT-O2C-512..514.
**Goal:** estimators build BoQs in Excel; today lines are keyed one-by-one.
- New `projects/boq-import.service.ts` + `POST /api/projects/:code/boq/import` — reuse the masterdata
  engine's `rowsFromInput` (csv / rows / base64 xlsx) rather than a new parser; validate rows against the
  item master + UoM; import lands the BoQ **Draft** (approval unchanged — PROJ-12 SoD intact).
- Template download via the same registry pattern (`/api/projects/boq/io/template`).
- Web: import dialog on the BoQ tab with a per-row validation report (mirror `master-io.tsx`).
- Harness: valid file → draft lines; unknown item / bad UoM rejected row-level; re-import doesn't dupe.

### A5 — Material EVM breakdown + project-tagged wastage · Effort **M**
**Goal:** isolate *material* cost performance inside EVM, and stop project scrap vanishing into a
project-agnostic waste bucket.
- `projects-evm.service.ts`: split EV/AC/committed by BoQ `category` (material / labor / subcon / other)
  — material CPI on the EVM card + governance pack.
- `inventory/waste.service.ts`: accept optional `project_id`/`boq_line_id`; project-tagged scrap relieves
  project WIP (1260) with a variance flag instead of the generic waste account, feeding a
  remeasure-vs-issue reconciliation per BoQ line.
- Harness: waste with a project tag hits WIP + shows in the by-category EVM; untagged waste unchanged.

**Parked (revisit after A1–A5):** free-issue materials to subcontractor (needs A1's return mechanics
first), multi-currency BoQ, measurement-book photo evidence (docs/32 §10).

---

## Track B — Record-to-report: from "controls exist" to "close runs itself"

The R2R spine is deep (see §0) — the residual theme is **orchestration and automation**: the checklist is
hardcoded, reval/consolidation are manual runs, accruals don't self-reverse, and detection is preventive
(gates) rather than detective (analytics).

### B1 — Close Manager: configurable close-task orchestration · Effort **L** · the anchor feature · **✅ v1 DELIVERED (2026-07-16)**
> Delivered (v1): migration `0421` `close_task_templates` + step fields (owner_role/due_date/depends_on_key);
> `startClose` composes standard + tenant templates (none ⇒ byte-identical); dependency gating
> (`DEPENDENCY_NOT_DONE`), custom REQUIRED tasks gate the lock, GL-16 lock semantics untouched;
> `GET/PUT /api/ledger/close/task-templates`; owner/due/dependency shown on the period-close screen.
> ToE `basics` 422→431; PN-04 rev 2.36; manual 06 v0.21; UAT-GL-195..197.
> **Deferred to a follow-up:** auto-completion from GL-19/closeStatus signals; overdue-task GOV-01
> provider; a dedicated template-editor screen (templates are API-managed in v1).
**Goal:** replace the fixed 9-step `CHECKLIST` const (`modules/ledger/close.service.ts:25`) with
per-tenant close tasks: owner/assignee, due-day offset from period end, predecessor dependencies,
evidence attachment, SLA/overdue escalation.
- New tables `close_task_templates` / `close_task_instances` (tenant-scoped, 0232 RLS); instantiate per
  period on `close/start`; the nine current steps become the seeded default template (behaviour-compatible
  — GL-15/16/19 semantics unchanged: lock still requires all blocking tasks done + `close/validate` green).
- Auto-completion hooks: system-verifiable tasks (subledger tie-out, bank rec, flux review…) flip
  automatically from their owning services' status — via the existing read surfaces, not new cross-module
  queries (Contracts rule; `closeStatus` already composes these).
- Overdue tasks feed GOV-01 (`ApprovalQueueSource`-style provider in the ledger module) + the cockpit RAG.
- Web: task board inside `finance/close-cockpit` (assignee, due, dependency chain, evidence link).
- **Control:** extends GL-15/22 — task sign-off identity ≠ lock approver where a task is marked blocking.
- Harness: template → instances; dependency gating; lock blocked until blocking tasks done; auto-complete
  fires; SoD on sign-off-vs-lock.

### B2 — Auto-reversing accruals · Effort **S** · quick win · **✅ DELIVERED (2026-07-16)**
> Delivered: migration `0419` `recurring_journals.auto_reverse` (monthly-only, `AUTO_REVERSE_MONTHLY_ONLY`);
> the sweep's first run in the next business month posts the flipped Draft reversal (GL-05, idempotent
> `REC-<id>-<lastRun>-REV`, response `reversals`); `/gl-schedules` checkbox + badge. ToE `basics` 414→422;
> PN-04 §7(11) rev 2.34; manual 06 v0.19; UAT-GL-189..192.
**Goal:** month-end accruals must reverse on day 1 of the next period; today reversal is manual (GL-17).
- `ledger-recurring.service.ts`: `auto_reverse` flag on recurring templates; the period-open path (or the
  `gl_recurring_journals` job on its first run in the new period) posts the reversal **Draft** through
  GL-05, tagged to the source entry's idempotency key + `-REV` (no double-reversal).
- Harness: extend `basics` — accrual posts + approves; next period auto-reversal drafts once; re-run
  idempotent; reverser ≠ original approver honoured.

### B3 — Period-end automation: schedulable FX reval + consolidation · Effort **M** · **✅ DELIVERED (2026-07-16)**
> Delivered: action jobs `gl_fx_reval_run` (ledger-bi-reports.ts) + `consolidation_run` (NEW
> consolidation-bi-reports.ts provider); filters `{period?}` default just-ended month; idempotent,
> fault-isolated per group, graceful on ALREADY_POSTED/IC_RECON_NOT_APPROVED; auto-Draft only —
> GL-18/CON-03 posting maker-checker unchanged. ToE `fxreval` 15→22, `consolidation` 42→47;
> PN-04 §7(10) rev 2.35; PN-11 rev 0.9; manual 06 v0.20; UAT-GL-193..194.
**Goal:** reval and consolidation are the only close steps still hand-cranked
(`fx-reval.service.ts` / `consolidation.service.ts` expose run+post but no scheduler).
- Register `gl_fx_reval_run` and `consolidation_run` as idempotent action jobs on the BI scheduler
  (generators in `ledger`/`consolidation` `*-bi-reports.ts` providers) — auto-*draft* only: posting stays
  maker-checker (GL-18/CON-02 `SELF_POST` unchanged).
- Wire both as auto-completing B1 close tasks once their period run exists + is posted.
- Harness: scheduled run drafts once per period; duplicate schedule tick = no-op; post still requires a
  second user.

### B4 — Reconciliation workspace depth (roll-forward + risk-rating + auto-certify) · Effort **M–L** · **✅ DELIVERED (2026-07-16)**
> Delivered (genuinely greenfield — the audit confirmed none of it pre-existed): migration `0422` adds
> roll-forward (GL-tied by construction) + risk rating + auto_certified to `recon_periods`; aging on the
> summary; `PUT …/:id/risk`; `POST /api/recon/periods/auto-certify` (safe class only — LOW risk + zero
> roll-forward; '(auto)'-attributed; REC-01 untouched); GL-19 advisory `recon_completeness` (cockpit
> consumes it via the validate leg). ToE `recon-profitability` 13→24; PN-04 rev 2.37; manual 06 v0.22;
> UAT-GL-198..200. Deferred: reviewer-routing assignments; per-risk frequency policies.
**Goal:** lift `modules/reconciliation` from item-matching to full balance-sheet certification
(BlackLine-style) — the audit-readiness feature auditors ask for first.
- Per-account roll-forward (opening → activity → closing vs GL), aging of reconciling items, per-account
  risk rating driving frequency (monthly/quarterly), auto-certification for low-risk zero-balance /
  zero-activity accounts (logged, REC-01 preparer≠certifier unchanged), reviewer routing for high-risk.
- Certification status feeds the Close Cockpit + a `recon_completeness` line in `close/validate` (GL-19).
- Harness: auto-cert only fires on the safe class; high-risk requires preparer + certifier; roll-forward
  ties to TB.

### B5 — JE anomaly & control-exception analytics (detective layer) · Effort **M**
**Goal:** SOX-style detective monitoring over `journal_lines`/`gl_audit_log`: duplicate JEs, round-amount,
backdated, after-hours, unusual account pairs, near-threshold approvals.
- New rule-based analytics sub-service in `modules/finance` (own file — service-size ratchet), surfaced as
  a `je_exceptions` BI report type + a cockpit tile; exceptions are dismiss-with-reason (audit-logged).
- **Control (new GL-xx, next free id):** periodic JE-exception review, evidence = the dismissal log.
- Harness: seeded anomalies each trip exactly their rule; dismissal requires reason; re-run stable.

**Parked (bigger bets, separate plans):** statutory note generation / XBRL export (extends GL-26),
consolidation CTA/NCI + multi-tier ownership depth (CON-01), Tier-B posting-override widening (already
governed by docs/43 — don't fork it here).

---

## Track C — POS sale: finish the money edges

The register/KDS/fiscal core is world-class already; what remains are the **edges where money leaks or
compliance bites**: unwired GL events, B2B invoices, pricing consistency, the offline tail, and real card
acceptance. C-phases deliberately track the still-open items in `docs/pos-worldclass-roadmap.md` + docs/41.

### C1 — ~~Wire the deferred GL posting events (tips + gift cards)~~ → **re-scoped: blind drawer close** · Effort **S–M** · quick win · **✅ DELIVERED (2026-07-16)**
**Correction (v0.2):** the original C1 was a **false gap** — docs/43 explicitly **decided** these events
stay unwired: `TIP.*` roles are **Tier C both legs, "events exist for visibility only"** (2300 is TIP-01's
reconciliation account with a live over-distribute guard) and `GIFTCARD.*` roles are Tier C because 2200 is
a **REC-04 permanent** control account that is never widened (docs/43 §8 Q3). Wiring them would contradict
a documented architecture decision. Replacement quick win, pulled forward from C4:
- **Blind drawer close** (roadmap P1c residual): per-tenant `till_settings.blind_close` policy
  (migration 0418; `GET/PUT /api/payments/till/settings`, change manager-only `ar`/`exec`); open-session
  X/Z redact expected cash + derivable figures server-side for till-duty callers; the new `/pos/till`
  close dialog submits the count first, variance revealed after; `blind_close` evidence stamp on the
  session. Strengthens REV-13/REV-05 (no new control id).
- Delivered: ToE `cashreport` 33→45; PN-07 §7(5) rev 2.0; manual 01 §6 v0.57; UAT-O2C-492..497;
  roadmap P1c updated. C4's remaining scope shrinks to the offline-replay items.

### C2 — Full B2B tax invoice (ใบกำกับเต็มรูป) at POS + e-Tax on demand · Effort **M** · roadmap P1b residual · **✅ DELIVERED (2026-07-16)**
> **Depth note:** the TAX-10 ABB→full conversion (verbatim amounts, Replaced status, ภ.พ.30 single-count,
> one-full-per-ABB, migration 0291) already existed in `tax-docs` — the genuine residual was the
> **sale-keyed counter surface**. Delivered: `POST /api/pos/orders/:saleNo/full-tax-invoice`
> (`PosService.fullTaxInvoiceForSale` — lazily issues the ABB idempotently, then delegates to the SAME
> conversion; zero tax logic in the POS module) + the POS-home recent-bills **ขอใบกำกับเต็มรูป**
> buyer-capture dialog. ToE `taxdocs` 131→136; PN-06 §7(3a) rev 0.29; manual 01 v0.58;
> UAT-TAX-063..064; roadmap P1b updated.
**Goal:** B2B walk-ins get a full tax invoice at the counter; today only the abbreviated ATV- auto-issues.
- `POST /api/pos/orders/:saleNo/full-tax-invoice` in `pos/fiscal` — buyer tax-id/branch capture
  (validated), converts/links the abbreviated doc (no double VAT reporting), optional e-Tax submission via
  the existing `etax.service.ts` providers, entry in the hash-chained journal.
- Web: "ขอใบกำกับเต็มรูป" on the receipt screen + reprint; buyer lookup by tax-id (recent buyers cached).
- **Control:** one full invoice per sale (idempotent), conversion audit-logged; extend the `taxdocs`
  harness + PN-06/PN-20.

### C3 — ~~POS-native pricing & promotions engine~~ → **re-scoped: register rule application** · **✅ DELIVERED (2026-07-16)**
**Correction (v0.5):** C3 was a **false gap** — `modules/pricing` already ships everything this phase
proposed: the `price_rules` schema field-for-field (scope/channel/location/dow/time windows;
percent/amount/fixed/**BOGO**/**qty-break**; priority/stacking; validity), combo explosion,
auto service charge, satang rounding, `POST /api/pricing/quote`, R10 maker-checker on rule changes,
`buildSale` + portal-POS integration, the `/pricing` admin with quote preview, and the `pricing`
harness (40 checks). The genuine residual was one wire: **the register only sent
`apply_pricing_rules` alongside a manual service charge**, so automatic rules silently never fired at
the till. Delivered: register checkout always applies the tenant's rules (`channel`/`party_size`
passed; no-rules tenants byte-identical) + a toast listing the rules that fired.
ToE `pricing` 40 + `restaurant` 186 green; PN-19 rev 1.57; UAT-O2C-511. Remaining polish (coupon/rule
engine convergence, per-channel base-price tiers, threshold-gated rule approval) parked as explicit
options, not gaps.
**Goal:** one rules engine so dine-in / QR / channel / hub all price identically (happy-hour, BOGO,
qty-break, combo explosion, service-charge auto-rules, satang rounding).
- New `modules/pricing` (own bounded context): `price_rules` (scope item/category/all · channel · location
  · time-of-day/day-of-week windows · type percent/amount/fixed/BOGO/qty-break · priority/stacking),
  `POST /api/pricing/quote` preview; integrate at `menu.resolveLine` / dine-in `buildSale` / portal POS —
  a single choke point, not per-screen math.
- Web: rules admin + happy-hour/combo builder; register shows the applied-rule badge per line.
- **Control:** rule create/change is maker-checker above a discount-% threshold (extends the P1c override
  audit); pricing changes are append-audited.
- Harness: new `pricing` — in-window/out-of-window, BOGO, stacking priority, service charge on 6-top,
  satang rounding, identical result via QR vs register.

### C4 — Offline completeness: loyalty-redeem + fiscal chain replay, blind drawer close · Effort **M** · **✅ DELIVERED (2026-07-16, re-scoped)**
> **Depth note:** blind drawer close shipped in Wave 1 (C1-rescoped), and the audit found the fiscal-chain
> half a **false gap** — the cloud already re-appends its own book-of-record chain per replayed sale;
> splicing hub hashes would FORK it. The genuine residual was loyalty-redeem replay. Delivered: the hub
> pusher emits `member_id`/`redeem_points` (member sourced from the hub's own Redeem ledger row) instead
> of skipping; the cloud clamps to ITS balance before checkout ("adjusted at sync" — the revenue sale
> never fails over points drift), native redeem lock + LYL-22 idempotency bind, re-push never
> double-deducts; memberless redemptions stay `LOYALTY_REDEEM_NO_MEMBER`. ToE `hub-snapshot` 73→79;
> PN-24 rev 0.11; docs/41 Phase 2c updated; UAT-O2C-515..516.
**Goal:** clear docs/41's `skipped_unsupported` queue and the last P1c control.
- `modules/hub` ingest + `restaurant/offline-sync.service.ts`: replay **loyalty-redemption sales**
  (server-side balance resolution under lock at replay, "adjusted at sync" surfaced) and the **fiscal
  hash-chain** (hub chain segments verified + spliced, gap = exception, never silently re-hashed).
- **Blind drawer close** in `payments.service.ts` `closeTill`: counted-first entry, expected/variance
  revealed only after submit (flagged per tenant); variance posting (5830) unchanged.
- Harness: extend `hub-snapshot` + `cashreport` — redeem offline → replay once (idempotent, points never
  negative); chain splice verifies; blind close hides expected until submit.

### C5 — Real PSP card terminal (pre-auth / capture / settlement) · Effort **L** · external dependency
**Goal:** the one "is this a real POS" gap left — the `pos/terminal` provider framework has no live
acquirer behind it.
- Implement one Thai acquirer (Opn/Omise, 2C2P, or GB Prime — pick per merchant account) in
  `pos/terminal/providers.ts`: charge / **pre-auth + capture** (bar tabs) / void / refund-via-PSP /
  tip-on-terminal; settlement-batch reconcile against `payments` (`settlement_batches`); PSP webhook
  HMAC-verified via `common/webhook-auth.ts`, idempotent on PSP event id.
- **Start merchant-account/sandbox procurement at phase kickoff** — it gates the build, not the other way
  round. Degrade gracefully (cash/QR) when unpaired.
- Harness: against the PSP sandbox — charge→capture→refund→settle; over-refund guard; webhook replay
  idempotent.

**Parked:** loyalty-tier multipliers surfaced at the register checkout (P2c — after C4 makes redemption
offline-safe), kitchen-printer routing per station, coursing timers (KDS polish).

---

## Sequencing & rationale

| Wave | Ship together (independent PRs) | Why first |
|---|---|---|
| **1 — quick wins ✅ DELIVERED 2026-07-16** | **A2** reservation sweep · **B2** auto-reversing accruals · **C1 (re-scoped)** blind drawer close | S-effort, each closes a real control/consistency gap, zero external deps |
| **2 — control gaps ✅ DELIVERED 2026-07-16** | **A1** material returns · **C2** full tax invoice · **B3** period-end automation | the physical-loop and fiscal gaps auditors/users hit monthly |
| **3 — anchor features ✅ DELIVERED 2026-07-16** | **B1** Close Manager (v1) · **C3 (re-scoped)** register rule application · **A3** material control tower | the big UX/orchestration lifts |
| **4 — depth ✅ DELIVERED 2026-07-16** | **B4** recon workspace · **A4** BoQ import · **C4 (re-scoped)** loyalty-redeem replay | audit-readiness + estimator/store-ops depth |
| **5 — detective + external** | **B5** JE analytics · **A5** material EVM/wastage · **C5** PSP terminal | C5 lands whenever the merchant sandbox arrives — start procurement in Wave 1 |

- **Parallelizable:** tracks A/B/C touch disjoint modules — one PR per phase, any track can run ahead.
  Within a track the listed order is dependency-real (A1 before A3's "returned" column; B1 before B3's
  auto-complete wiring is *nice* but not required — B3 ships standalone against the fixed checklist too).
- **Biggest risks:** B1 (behaviour-compatibility with the GL-15/16/19 lock semantics — seed the default
  template to match today exactly, golden-master the lock path), C5 (external PSP dependency — procure
  early, build last), C4 (fiscal-chain splice correctness — design the gap-exception path before code).
- **Every phase's definition of done** = CLAUDE.md doc-sync policy: narrative (+ control matrix + revision
  history), user manual, UAT + traceability, RCM (`build_rcm.py` → xlsx + census markers) where a control
  is added/changed, harness green, ratchets green.

## Revision history

| Version | Date | Change |
|---|---|---|
| v0.1 | 2026-07-16 | Initial plan: codebase audit of the three cycles + 15 phases in 5 waves |
| v0.2 | 2026-07-16 | Wave 1 build: C1 re-scoped (original was a docs/43-decided non-gap — TIP/GIFTCARD events are visibility-only by design) to **blind drawer close**, DELIVERED |
| v0.3 | 2026-07-16 | **Wave 1 DELIVERED** — A2 (reservation sweep, ToE projects 336), B2 (auto-reversing accruals, ToE basics 422, golden re-pinned 531→534 for the 3 additive response fields), C1-rescoped (blind close, ToE cashreport 45). Verified: typecheck, api+web build, 4 ratchets, compliance 179, writeflow 36, analytics 17, worldclass 59, pos-p1 19, giftcards 33, taxdocs 131, input-vat 6 |
| v0.6 | 2026-07-16 | **Wave 4 DELIVERED** — A4 (BoQ takeoff import, fail-closed, ToE projects 362), B4 (recon depth: GL-tied roll-forward + risk + aging + safe-class auto-certify + GL-19 recon_completeness, migration 0422, ToE recon-profitability 24 — the audit confirmed genuinely greenfield), C4 re-scoped (loyalty-redeem hub replay with cloud-side clamp, ToE hub-snapshot 79; the fiscal-chain half was a THIRD false gap — the cloud re-append chain is already the book of record). Golden 534 unchanged; basics 431, compliance 179, projects 362, worldclass 59, e2e 23, writeflow 36; typecheck/builds/ratchets green |
| v0.5 | 2026-07-16 | **Wave 3 DELIVERED** — A3 (material control tower: by-WBS rollup + draw curve, ToE projects 357), B1 v1 (Close Manager: per-tenant close-task templates w/ owner/due/dependency, migration 0421, ToE basics 431; GL-19 auto-complete + overdue GOV-01 provider deferred), C3 re-scoped (a SECOND false gap — the pricing engine pre-existed in modules/pricing; delivered the genuine residual: the register now applies automatic rules on every checkout + applied-rules toast). Golden 534 unchanged; compliance 179, e2e 23, worldclass 59, writeflow 36, analytics 17, typecheck/builds/ratchets green |
| v0.4 | 2026-07-16 | **Wave 2 DELIVERED** — A1 (material return-to-stock, NEW control **INV-19**, migration 0420, RCM 296, ToE projects 351), B3 (schedulable `gl_fx_reval_run` + `consolidation_run` staging jobs, ToE fxreval 22 + consolidation 47), C2 (sale-keyed full tax invoice at the counter over the existing TAX-10 conversion, ToE taxdocs 136). C2 depth note: the ABB→full conversion pre-existed — the residual was the counter surface only. Golden 534 unchanged; typecheck/builds/ratchets/census green |
