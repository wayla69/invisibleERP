# 41 — Module-Depth Uplift: Finance, POS Customer-Facing, CRM Modernization — Audit & Roadmap

> **Date:** 2026-07-10 · **Status:** v1.0 — PROPOSED (audit complete, phases not started) · **Owner:** ERP / Product
> **Trigger:** External review feedback — "module depth is shallow, especially accounting/finance; POS
> customer-facing has room; the CRM is ancient (โบราณ)." A three-track code audit (2026-07-10) verified
> the claim against the actual codebase. **Verdict: the critique is ~⅓ right.** Finance and POS are far
> deeper than the reviewer assumed (see §0 — use it as the pitch defense), but each track has a short
> list of *real* gaps a customer pitch would get rejected on, and the CRM critique is substantially
> correct. This doc records the audit and sequences the uplift.
> **Delivery discipline:** same as `docs/19`/`20`/`23` — each phase is an independently-shippable,
> doc-synced PR (migration *if any* + module + permissions/SoD + RCM control + narrative + user-manual +
> UAT + cutover-harness), merged only on a fully green CI matrix. Build on, don't duplicate.

---

## 0. Pitch defense first — what already exists (the reviewer under-counted)

Before conceding "shallow", inventory what is already built and harness-tested. In a pitch, lead with
these; they are differentiated for a Thai mid-market ERP:

**Finance/Accounting (deep):** multi-ledger multi-GAAP with book–tax comparison (ภ.ง.ด.50 basis) +
deferred tax; immutable GL with contra-reversal and maker-checker on every posting surface; structured
close checklist with SoD (`gl_close` ≠ `gl_post`); FX revaluation; **multi-entity consolidation with NCI +
IC elimination gated on IC-recon sign-off**; direct **and** indirect cash flow that reconcile to Δcash;
ECL/allowance + bad-debt write-off maker-checker; staged dunning with หนังสือทวงถาม PDFs; credit
management with order-entry credit check; 3-way-match payment gate; **WHT/50-ทวิ + PND3/53, PP.30, PP.36,
PT.40, RD e-Filing formats**; signed e-Tax XML + PDF/A-3; bank reconciliation with Thai/EN + BE-date
statement import and auto-match; FIFO/AVG/STD costing with PPV; IFRS 16 leases incl. modification and
liability recon; asset revaluation/impairment + QR physical audit; TFRS 15 rev-rec.

**POS (deep):** full dine-in lifecycle (course firing, KDS routing, table transfer/merge, split bill),
till open/close with denomination counts, X/Z reports + signed Z, variance→GL with maker-checker, fiscal
hash-chain journal with verify, real EMVCo PromptPay QR + Stripe/Opn gateways + PSP webhooks, offline
quick-sale outbox with idempotent replay, ABB (ม.86/6) auto-issuance at checkout, recipe depletion →
COGS GL per sold line, tip pooling with GL posting, buffet engine, Grab/LineMan/Foodpanda/Robinhood
channel adapters, loyalty with tiers/missions/wheels/referrals/wallet-pass and a member self-service app.

**CRM (thin — critique stands):** the skeleton exists (leads → stage-gated opportunities → activities →
weighted forecast → win/loss BI) and the *retail-loyalty* side (RFM, churn/LTV scoring, journeys,
campaigns, CDP export) is genuinely sophisticated — but the *sales* CRM is fragmented and dated. §3.

The uplift below is therefore **not a rebuild anywhere**. It is: (a) a short punch-list of genuine
finance/POS gaps, and (b) one structural modernization (CRM).

---

## 1. Track FIN — Finance/Accounting depth (punch-list, priority order)

Audit basis: `modules/ledger`, `finance`, `bank`, `tax`, `assets`, `leases`, `budget`, `costing`,
`consolidation`, `bi`.

### FIN-1 ⭐ AR cash application (multi-invoice / on-account / auto-apply)
`finance.service.ts` `createReceipt` applies one receipt to one `invoice_no`. A customer paying 12
invoices with one transfer cannot be applied. Build a **cash-application worksheet**: one receipt → many
invoices (partial allowed), **unapplied/on-account balance** as a first-class state, later application of
on-account cash, and **auto-suggest matching** from bank-statement inflows (reuse `bank` auto-match
scoring: amount/date/payer-ref). Credit notes from `tax/documents` must reduce AR open balance and be
applicable in the same worksheet (closes the "statutory CN doesn't hit the sub-ledger" gap). New control
REV-xx (application maker-checker above threshold); extend `basics` harness.

### FIN-2 ⭐ AP payment run + bank payment file
Payments are one-by-one. Build **payment proposals**: select open approved AP by due-date/discount
window → proposal (maker) → approve (checker, SoD vs proposer) → execute as a batch → export a **bank
payment file** (Thai bank bulk-transfer CSV first — SCB/KBank/BBL formats — ISO 20022 `pain.001` second)
→ on bank-statement import, auto-clear the run. WHT certificates batch-issue off the run (infra exists).
Control EXP-xx (proposal≠approver, file hash logged to audit). This is the single most-probed treasury
demo item.

### FIN-3 ⭐ Budgetary control / encumbrance
`budget` is report-only; nothing blocks overspend. Add a **budget-check gate on PR/PO approval**
(`procurement` spine): committed = open PO + PR reservations per (account, cost_center, period);
policy per tenant = advise / warn / block, with an exec override that leaves an audit trail (mirror
PROJ-12/13's over-budget maker-checker — the PMR pattern is the template; do NOT fork a second engine).
Control BUD-xx. Extends `commitments` module rather than duplicating it.

### FIN-4 Statutory FS pack: notes + statement of changes in equity + DBD
Primary statements exist; the **audit pack** doesn't. Add: statement of changes in equity, a
**note-schedule builder** (per-note account mapping, comparative columns, policy-note text blocks), and a
**DBD e-Filing export** of the annual FS (งบการเงิน XBRL/S-form format). Rides `reports` export services.
Comparative (YoY / budget column) variants of P&L/BS come free from the same layout layer — implement as
a configurable FS row-grouping ("financial report builder") so buyers can define their own subtotals.

### FIN-5 Consolidation: CTA/OCI + average-rate translation + consolidated SCF
Translation is single closing-rate with no CTA. Add avg-rate for P&L vs closing-rate for BS, park the
difference in a **CTA/OCI reserve** line, and produce a **consolidated cash-flow statement** (post-
elimination). An IFRS/TFRS reviewer flags this immediately; it's contained inside
`consolidation.service.ts`.

### FIN-6 Fixed assets: parallel tax book + CIP
(a) **Tax-vs-book depreciation books** per asset (Thai tax caps/initial allowances), feeding the existing
deferred-tax module instead of manual GAAP adjustments. (b) **CIP/AUC**: accumulate multiple GR/cost
lines on a construction-in-progress asset, then settle/capitalize (maker-checker FA-xx) — pairs naturally
with `progress-billing`/`realestate` verticals.

### FIN-7 GL allocation engine + dimension reporting
Periodic **allocation cycles** (source pool → targets by fixed ratio / driver / statistical key, e.g.
headcount, sqm), posted as generated JEs on the recurring rail (`ledger-recurring` pattern, GL-08 style
control). And surface the dimensions the lines *already carry* — extend `gl_period_balances`/TB filters
from cost-center-only to **project/dept/branch**, giving a true multi-dimensional TB without schema
change on the lines.

Deliberately deferred (name them in pitch as roadmap, don't build yet): netting/contra, dynamic
discounting, goodwill/PPA acquisition accounting, lessor accounting, IAS 36 CGU impairment machinery,
manufacturing WIP variance settlement (pairs with a future mfg-costing track).

---

## 2. Track POS — customer-facing depth (punch-list, priority order)

Audit basis: `modules/pos`, `restaurant`, `payments`, `loyalty`, `pricing`, `menu`, `channel-adapter`,
`tax/documents`.

### POS-1 ⭐ ABB → full tax invoice conversion at the counter
Legally expected (ม.86/4) and requested daily in Thai retail: customer buys, gets an ABB, then asks for a
full tax invoice with their Tax ID/branch. Infra exists (`tax-invoice.service.ts` issues both forms) —
add the **conversion endpoint + register UI**: scan/locate the ABB slip → capture buyer name/Tax ID/
branch → issue full tax invoice referencing (and superseding) the ABB, idempotent, void-exception
audited, e-Tax XML included. Control TAX-xx. Smallest work / highest pitch value in this track.

### POS-2 ⭐ e-Receipt + ABB via LINE push
`receipt-delivery.service.ts` does email+SMS only, while a full LINE stack (OA, Flex, line-link, member
`lineUserId`) already exists. Wire receipt/ABB delivery as a **LINE Flex push** for linked members and a
**QR-on-slip → LINE add-friend + receipt claim** for walk-ins (which also feeds loyalty
receipt-submission). Near-universal Thai expectation; pure integration work.

### POS-3 ⭐ Standalone coupon/voucher codes redeemable at checkout
Coupons today are loyalty-sourced (missions/wheels) only. Add **campaign voucher codes**: bulk/single-use
code generation under `campaigns`, state machine (issued→redeemed→void, expiry), and a **redemption path
in `buildSale`/pricing opts** (validate code → apply as a priced discount line, stacking rules from the
existing pricing engine). Include member-tier-gated pricing and cart-level "spend X get Y" in the same
pricing-engine extension. Also closes the "coupon wallet exists but checkout can't redeem it" gap.

### POS-4 KDS depth
Backend 79 lines / UI 114 lines is the thinnest surface in the POS suite. Add: per-item **prep-time SLA
with aging colors**, bump/recall with all-day counts per station, an **expo/order-ready screen**, and
station load view. Mostly web + a small `kds.service.ts` extension (timestamps per state transition
already exist on item transitions).

### POS-5 Waste/spoilage tracking + menu-engineering matrix
No waste ledger exists. (a) Cancelled/void fired items and kitchen spoilage post to a **waste ledger**
with reason + disposition (inventory write-off GL, reuses `stock-ops` Consume move + FA-style reason
codes) → theoretical-vs-actual usage variance closes the loop with `food-cost` variance. (b) A
**menu-engineering matrix** (star/plowhorse/puzzle/dog by margin × popularity) in `restaurant-analytics`
— data already exists (recipe COGS + sales mix); it's an aggregation + one screen.

### POS-6 Offline dine-in + PWA register
Offline is quick-cash only; dine-in blocks offline. Extend the outbox to **dine-in mutations** (open
table/add items/fire — settlement stays online), cache menu+prices via the service worker (network-first
HTML rule from CLAUDE.md still applies — cache *data*, not navigations), and make the register an
installable PWA so a reload while offline doesn't lose the till.

### POS-7 Auto-86 (out-of-stock) push to aggregators
`recipe.availabilityForecast` already knows when an item depletes; `channel-adapter` already syncs menus
out. Wire depletion events → **pause item on Grab/LineMan/Foodpanda** (and un-86 on restock). Prevents
the #1 aggregator complaint (accepting orders you can't cook).

### POS-8 PromptPay store-level auto-reconciliation
Match PromptPay-tendered sales against imported bank-statement inflows automatically (ref/amount/time
window) per store per day, surfacing unmatched as a till exception — reuses the `bank` auto-match engine
scoped to the store's settlement account.

Deferred: seat-level ordering, tip-adjust-after-auth, floor-plan editor, per-provider e-wallet
deep-links.

---

## 3. Track CRM — modernization (the "โบราณ" fix; structural, sequenced)

Audit basis: three disconnected implementations — `crm/crm.service.ts` (retail loyalty/RFM/CDP on
`customer_profiles`), `crm/pipeline/crm-pipeline.service.ts` (REV-17: `crm_leads`/`crm_opportunities`/
`crm_activities`, hardcoded stages), `crm/pipeline/pipeline.service.ts` (Batch 2A: `pipeline_stages`/
`opportunities`, tenant-configurable stages — and CPQ quotes FK **this** table, not the REV-17 one).
Four separate web pages (`/crm`, `/pipeline`, `/projects/crm`, `/projects/pipeline`), all DataTable +
dropdown stage changes; activities API exists but **no UI ever calls it**. Two customer identities
(`pos_members` vs `customer_master`) never join.

Sequenced phases — CRM-1 is the foundation; 2–5 stack on it:

### CRM-1 ⭐ Unify the data model: accounts + contacts + ONE opportunity spine
- Introduce **`crm_accounts`** (company) and **`crm_contacts`** (person, N per account, role tags:
  decision-maker/billing/technical), FK'd to `customer_master` (an account *is* the customer-of-record
  once transacting) — this also becomes the join point to `pos_members` (one person: loyalty member AND
  B2B contact) via a nullable `member_id`.
- **Merge the two opportunity tables**: keep `crm_opportunities` as the spine, migrate Batch 2A
  `opportunities` rows in, adopt the **tenant-configurable `pipeline_stages`** (stageId FK replaces the
  hardcoded STAGES const; keep probability defaults per stage), repoint the CPQ FK. Record the merge
  decision that `crm.module.ts:6-16` deferred — with data migration this time. `owner` becomes a real FK
  to users.
- Add **`crm_stage_history`** (opportunity, from-stage, to-stage, at, by) — unlocks every velocity metric
  in CRM-5 and costs nothing to write at transition time.
- Duplicate detection on create (normalized email/phone/company match → warn + merge tool).
- One migration (next free number), RLS loop per `0232` canonical form, REV-xx control for merge
  maker-checker. This phase is invisible in the UI but everything else depends on it.

### CRM-2 ⭐ The modern workspace: kanban + deal page + activity timeline
- **`/crm` becomes ONE workspace** (retire/redirect the four fragments): pipeline **kanban board with
  drag-drop stage moves** (dnd on stage columns, optimistic update, stage-history logged), saved
  filters/views (reuse `saved-views` module), list toggle, mobile card layout per the
  `approvals/page.tsx` recipe.
- **Deal detail page** (`/crm/deals/[id]`): header (amount, stage, owner, account/contacts), **unified
  activity timeline** (activities + stage changes + quotes + notes, chronological — the API exists,
  render it), next-step task with due date, attachments (`doc_attachments` pattern), linked CPQ quotes.
- Account/contact pages with the same timeline. Lead-capture: CSV import wizard (reuse `masterdata`
  registry engine) + a public web-to-lead endpoint (rate-limited, honeypot).
- This phase alone kills ~80% of the "ancient" perception. `use-client` ratchet: one new island,
  server-shell + client-island pattern per CLAUDE.md.

### CRM-3 Customer 360 that actually joins the business
Extend `/api/crm/profile` beyond `pos_members`: key on the CRM-1 account/contact and join **AR open
balance + aging + last payments** (`finance`), credit status/holds (`collections`), sales orders &
deliveries, open deals + quotes, loyalty (if linked member), NPS + recovery cases, statements
(`customerStatement` exists). One screen a salesperson opens before every call — and the concrete answer
to "CRM ไม่เห็นเงิน".

### CRM-4 Automation: scoring, events, follow-up SLA
- Emit **pipeline events into the automation engine** (`automation.service.ts` EVENTS): `lead.created`,
  `lead.stagnant`, `opp.stage_changed`, `deal.won|lost` — instantly reusable by existing rules infra.
- **Lead scoring** (v1 rules-based: source/size/engagement recency → A–D grade; the member churn-score
  formula pattern in `crm.service.ts` is the template for an explainable versioned score).
- **Follow-up discipline**: overdue-activity + rotting-deal (no activity N days at stage) surfaced in the
  existing alerts/notifications rail + a daily digest; assignment round-robin per pipeline. New detective
  control REV-xx (leads must be touched within SLA), mirroring PROJ-11's action-center pattern.
- Sales comms from a deal: send **email or LINE from the timeline** using `messaging`/`mail` +
  `document-templates` merge fields; log sends as activities. (Full 2-way IMAP sync = deferred; capture
  replies via the existing inbound-mail rail scoped to a per-tenant CRM address, mirroring
  `email-capture`'s AP pattern.)

### CRM-5 Analytics that answer "why"
Funnel conversion (lead→qualified→won, stage-to-stage from `crm_stage_history`), **sales velocity/
stage-duration**, source ROI (lead source → won revenue), forecast categories (commit/best-case/pipeline)
+ quota attainment per owner, activity leaderboards. Extend `crm_win_loss` BI type + 2-3 new report
types on the existing registry; bound the win/loss query by date server-side while in there.

---

## 4. Sequencing & effort (proposal)

| Wave | Items | Rationale |
|---|---|---|
| **W1 — pitch quick-wins** (small PRs, high demo value) | POS-1, POS-2, POS-3, FIN-7(dimension TB part), POS-5b(menu matrix) | Each ≤1 PR, mostly wiring existing infra; visibly answers the critique in a demo |
| **W2 — structural CRM** | CRM-1 → CRM-2 (sequential PRs) | The one true rebuild; everything else in Track CRM stacks on it |
| **W3 — finance credibility** | FIN-1, FIN-2, FIN-3 | The three items an audit-prep/treasury buyer probes hardest |
| **W4 — depth completers** | CRM-3, CRM-4, POS-4, POS-6, POS-7, POS-8, FIN-4, FIN-5, FIN-6, FIN-7(allocations), CRM-5, POS-5a | Independent; order by customer signal |

Every phase follows the standing doc-sync policy (narrative + RCM/`build_rcm.py` + census markers +
user manual + UAT + harness in the same PR). Migrations take the next free number at merge time per the
journal rules. Nothing in this plan rebuilds an existing engine — each item names the module it extends.

---

## Revision history
| Rev | Date | Change |
|---|---|---|
| 1.0 | 2026-07-10 | Initial audit + uplift roadmap (3 tracks, 4 waves) from the 2026-07-10 depth review |
