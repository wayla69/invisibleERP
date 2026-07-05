# 35 — Construction & Real-Estate Vertical — Progress Billing, Retention, Subcontracts, Tender & Property Sales — Design & Roadmap

> **Date:** 2026-07-05 · **Status:** v0.7 — **P0–P4 DELIVERED** + **depth follow-ups in progress** (D1 retention release→GL + action center ✅); **P5** (ownership transfer RE-04 + RE workspace) **PLANNED** · **Owner:** ERP / Product
>
> **Depth follow-ups** (post-P4 audit — closing "architecturally deep, functionally thin" gaps): **D1** retention *release* posts GL + `retention_due` action-center ✅ · **D2+D3** output VAT + POC/rev-rec reconciliation on progress claims, subcontractor WHT (in progress) · **D4** web workspace + nav (planned).
> **Scope:** Close the remaining gap between our project suite and a purpose-built **construction & real-estate
> ERP** (benchmark: **Mango ERP / Mango Consultant** — Thailand's leading contractor/developer ERP, which
> pitches one system "from **bidding** through **project-closing** evaluation"). We already own the material-
> control spine (`docs/32` — BoQ, commitment budget, requisition→purchase, reservation→WIP, project site cash).
> What is still missing is the **contract-revenue and subcontract side of a contractor**, the **pre-award
> tender/estimate**, and an optional **real-estate developer** vertical (property units, sale contracts,
> installment plans, ownership transfer). This roadmap adds those as **operational layers on the proven PPM +
> P2P + AR/AP + GL + workflow + LINE spine — extend, do not duplicate.**
> **Decision recorded:** Same delivery discipline as `docs/19`/`docs/32` — each phase is an
> independently-shippable, **doc-synced** PR (migration + module + permissions/SoD + RCM control + PN narrative
> + user-manual + UAT + cutover-harness), merged only on a fully green CI matrix.

---

## 0. Read this first — how we got here & what this closes

`docs/19/20/23` delivered the **PPM/PMO spine** (WBS/tasks/milestones, resourcing & rate cards,
timesheet→labor maker-checker, dependencies & **EVM**, baselines/templates/RACI/risk, portfolio command
center, action center). `docs/32` delivered the **construction material-control loop**: **Bill of Quantities**
(`project_boq`/`project_boq_lines`), a **commitment/encumbrance budget** enforced per BoQ line (**PROJ-12**),
**project material requisitions** with one-tap **LINE** over-budget approval (**PROJ-13**), **stock
reservation → issue-to-project WIP** (**INV-13**), and **project-tagged advances/petty cash** (**PROJ-14**).

Benchmarked against Mango ERP for Construction, that already covers **BoQ, budget/cost control, procurement→
project, and material control**. The gaps that remain are exactly the parts `docs/32 §10` **explicitly parked
as out of scope** — "subcontractor progress-claim certification" and "**retention accounting**" — plus the
**pre-award tender/estimate** that should seed the BoQ, and (a larger, separable track) a **real-estate
developer** vertical. This plan closes those four gaps.

### Baseline to build on (as of 2026-07-05)
- **RCM 180 controls** (`compliance/build_rcm.py`; never hand-edit the xlsx — regenerate).
- **`projects` cutover harness: 165 checks** (`tools/cutover/src/projects.ts`).
- Last project controls: **PROJ-14**, **INV-13**. PN-16 (project-accounting) at **rev 0.32**.
- Migrations applied through **0248** → **next free is 0249** (journal `idx`/`when` strictly ascending;
  copy `0232`'s org-clause RLS loop for every new tenant table — see CLAUDE.md tenancy note).
- UAT through **UAT-O2C-242** → next id **UAT-O2C-243+**.
- AR side: `finance` (`ar_invoices`/`ar_receipts`/`ar_dunning_log`), `revenue` (`rev_rec_schedules`/`_lines`).
  AP side: `finance` (`ap_transactions`/`ap_payments`), `procurement` (PR/PO/GR + `modules/match` 3-way).

---

## 1. Gap analysis — Mango capability vs. our system

| Mango capability | Our system today | Gap |
|---|---|---|
| BoQ as budget baseline | `project_boq`/lines, approve/lock/remeasure (`docs/32` M0) | ✅ Have |
| Budget & cost control (planned vs actual) | Commitment ledger **PROJ-12**, EVM, budget-vs-actual | ✅ Have |
| Procurement → project (PR/PO/GR, 3-way match) | Project-tagged P2P + `modules/match` | ✅ Have |
| Material control by BoQ/site (planned vs actual issue) | PMR + reservations + issue-to-WIP (M2/M3) | ✅ Have |
| Fixed assets/equipment, HR, accounting, CRM, dashboards | assets/EAM, HCM/payroll, GL/finance, CRM/pipeline, portfolio/BI | ✅ Have |
| **Subcontractor management** (subcontract vs BoQ scope, progress valuation, **retention payable**, back-charge) | Vendors/AP only — no subcontract document | ❌ **Track B** |
| **Progress billing / งวดงาน** (bill by % of BoQ/milestone, **retention receivable**, certificate → tax invoice, retention release) | Milestone/POC billing exists; no progress-claim certificate or retention accounting | ❌ **Track A** |
| **Tender / estimating** (pre-award bid: estimate → submit → win → seed project + BoQ) | CRM pipeline win/loss + opp→project, but no estimate/BoQ bridge | ⚠️ **Track C** |
| Real-estate developer suite (units, sale contracts, installments, transfer) — *MangoPMS* | None | ➖ **Track D** (opt-in vertical) |

**Cross-cutting foundation:** Tracks A & B both need a **retention sub-ledger** (withheld amounts, release
schedule, GL). Design it **once** (Phase 0) and reuse on both the AR (customer) and AP (subcontract) sides.

---

## Track A — Progress billing & retention (customer / AR side) — *งวดงาน*

*Highest cash-flow value; the contractor's revenue engine. Builds on `ar_invoices` + BoQ + milestones.*

**Problem.** A construction contract is billed in **progress claims** (งวดงาน): each period the contractor
certifies **work done to date** (by BoQ line % or milestone), the customer/QS approves, an **interim
certificate** is issued, **retention** (เงินประกันผลงาน, e.g. 5–10%) is **withheld**, and a **tax invoice**
for the net is raised. Retention is **released** in tranches (typically part on practical completion, the
remainder at the end of the defect-liability period). We can raise a flat AR invoice but cannot value work by
BoQ line, withhold/track/release retention, or express "billings in excess of / less than cost & profit."

### A1 — Progress-claim valuation & certificate (control **PROJ-15**)
- New `project_progress_claims` (header: `project_id`, `claim_no`, `period`, `status`
  draft/certified/invoiced/paid, `gross_this_claim`, `retention_pct`, `retention_amount`, `net_payable`,
  `certified_by`/`certified_at`) + `progress_claim_lines` (per **BoQ line** or milestone: `boq_line_id`,
  `pct_complete_to_date`, `value_to_date`, `previously_certified`, `value_this_claim`). Cumulative model:
  `value_this_claim = value_to_date − previously_certified`, so over-claim and negative movements are visible.
- **Maker-checker** certification (`proj_billing` raises, `proj_billing_certify`/`gl_close` certifies; SoD
  pair) → **PROJ-15**: work cannot be billed beyond certified % and retention is withheld per policy.
- On certify → invoice: reuse `finance.ar_invoices` for the **net** and post via the existing `postEntry`
  with `project_id`; recognise revenue through `revenue` (`rev_rec_*`) so POC revenue keeps working.

### A2 — Retention receivable & release (shares Phase-0 sub-ledger)
- Each certified claim posts **retention withheld** into the shared retention sub-ledger (contra-AR / retention
  asset) rather than AR. A **release schedule** (e.g. 50% @ practical completion, 50% @ end of DLP) drives a
  `POST /api/projects/:code/retention/release` that raises a retention invoice/receipt when due — surfaced as a
  new **action-center** exception `retention_due`.

### A3 — Billing dashboard & IA
- `/projects/[code]` **การวางบิล / Billing** tab: claim register, per-line valuation grid (BoQ line, % to
  date, this-claim value), retention withheld/released, certificate PDF (reuse `document-templates`).
  Top-level `/projects/billing` cross-project claim worklist. New nav item **`nav.pm_billing`**.

---

## Track B — Subcontractor management & retention payable (AP side)

*The other half of a contractor; mirrors Track A but outbound. Builds on procurement/AP + BoQ + retention.*

**Problem.** Contractors execute much of the BoQ through **subcontractors**. A subcontract is a **priced scope
against BoQ lines**; the subcontractor submits **progress valuations** we certify; we withhold **retention
payable** and issue **back-charges** (deductions for defects/materials supplied); the certified net flows to
**AP**. Today we have vendors/PO/AP but no subcontract document, no progress valuation, no retention payable,
no back-charge.

### B1 — Subcontract order against BoQ scope (control **PROJ-16**)
- New `project_subcontracts` (header: `project_id`, `subcontract_no`, `vendor_id`, `contract_value`,
  `retention_pct`, `status` draft/active/closed) + `subcontract_scope` lines linked to `boq_line_id`
  (the subcontracted portion of a BoQ line). A subcontract **registers a commitment** on its BoQ lines via the
  existing `project_commitments` engine, so subcontract value counts against the material/works budget exactly
  like a PO (reuse `CommitmentsService.reserve`).

### B2 — Progress valuation, certification & retention payable
- `subcontract_valuations` (per period: certified % / value this period, previous, retention withheld,
  back-charges, net certified). **Maker-checker** certify (`proj_subcon` raises, `proj_subcon_certify`
  certifies; SoD) → **PROJ-16**: no valuation beyond certified progress; retention withheld per policy;
  back-charges audited. Certified net posts to **AP** (`ap_transactions`) with `project_id`; retention payable
  lands in the shared sub-ledger and **releases** on the same schedule mechanism as Track A.
- Optional over-budget path reuses the **PMR/LINE** approval engine (a valuation that pushes a BoQ line over
  budget routes to LINE approval, exactly like `docs/32` M2).

### B3 — Subcontract IA
- `/projects/[code]` **ผู้รับเหมาช่วง / Subcontracts** tab + top-level `/projects/subcontracts`. New nav item
  **`nav.pm_subcontracts`**. Supplier scorecards (`docs/21`) extend to subcontractor on-time/quality.

---

## Track C — Tender / estimating → award

*Bridges the CRM pipeline you already have to the BoQ you already have.*

**Problem.** Before a contract exists, a contractor **estimates** a job (take-off → priced BoQ with rate
build-up and mark-up), **submits a bid**, and tracks the **outcome**. We have `crm-pipeline` (opportunity
win/loss) and `project_boq`, but nothing in between: won opportunities convert to a project with an **empty**
BoQ that must be re-keyed.

### C1 — Estimate / draft BoQ on the opportunity (control **PROJ-17**)
- New `project_tenders` (header: `crm_opp_no` link, `tender_no`, `status` estimating/submitted/won/lost,
  `estimated_cost`, `markup_pct`, `bid_price`, `submitted_at`, `outcome`) + `tender_boq_lines` (a **draft
  BoQ** with cost build-up: `description`, `uom`, `qty`, `unit_cost`, `markup_pct`, `bid_rate`). Estimating is
  a modelling surface; nothing hits GL.
- **On win → award:** `POST /api/tenders/:no/award` **seeds the project + an approved BoQ** from the tender
  lines (bid_rate → BoQ `rate`) in one step — the missing bridge. Governed by **PROJ-17** (award is an
  authorised act; the seeded BoQ enters as draft→maker-checker approve, so the budget baseline is controlled).
- Ties to the existing `crm-pipeline` `winLoss` and `projects.crm_opp_no`; reuses the win/loss BI report type.

### C2 — Tender IA
- `/projects/tenders` register (estimating → submitted → won/lost, win-rate, pipeline-weighted value) — nav
  **`nav.pm_tenders`**, cross-linked from `/projects/pipeline`. Estimate editor reuses the BoQ line grid.

---

## Track D — Real-estate developer vertical (MangoPMS-style) — *opt-in, larger track*

*A separable property-sales vertical. Sequenced last; own PN + control family (**RE-0x**). Feature-flagged so
non-property tenants never see it.*

**Problem.** A **developer** (not just a contractor) sells **units** (condos/houses/land plots) to buyers on
**installment plans**, then transfers ownership. This is a distinct sub-ledger from job-costing: unit
inventory, reservations/bookings, sale contracts, down-payment + installment schedules with receipts and
overdue dunning, and **ownership transfer** (โอนกรรมสิทธิ์) with the final settlement + tax. It reuses our
AR/receipts/CRM/document-templates but needs its own master data and contract lifecycle.

### D1 — Property master & unit inventory (control **RE-01**)
- `re_projects` (development), `re_units` (unit no, type, area, floor, list price, `status`
  available/reserved/contracted/transferred). Read models for availability grid & price list.

### D2 — Booking → sale contract → installment plan (controls **RE-02/03**)
- `re_bookings` (reservation deposit, expiry), `re_contracts` (buyer, unit, price, discounts,
  down-payment, `retention`/holdback if any), `re_installments` (schedule: due date, principal, status).
  Receipts reuse `ar_receipts`/`postEntry` with a `re_contract_id` dimension; overdue installments reuse the
  **dunning** engine. Maker-checker on contract (price/discount authority) → **RE-02**; installment
  application integrity → **RE-03**.

### D3 — Ownership transfer & settlement (control **RE-04**)
- `POST /api/re/contracts/:id/transfer` — final settlement, transfer fees/specific-business-tax, unit →
  `transferred`, revenue recognised. Governed **RE-04** (transfer is authorised, fully-settled-only).

### D4 — Real-estate IA & workspace
- **New nav group** `nav.group.realestate` (workspace `erp`, feature-flagged): Developments, Units, Bookings,
  Sale Contracts, Installments, Transfers, RE dashboard. Own PN (**PN-29 real-estate-sales**), user-manual
  chapter, UAT family.

---

## 2. Cross-cutting Phase 0 — shared retention sub-ledger

*Do first; Tracks A & B both depend on it.*

- New `retention_ledger` (`tenant_id`, `party_type` customer/subcontractor, `party_ref` (project/contract or
  subcontract), `source_doc_type`+`source_doc_no`, `withheld_amount`, `released_amount`, `status`
  held/partially_released/released) + `retention_release_schedule` (`due_basis` practical-completion/DLP-end/
  date, `pct`, `due_date`, `status`). GL: **Retention receivable** (asset, contra-AR) and **Retention payable**
  (liability) — the only genuinely new accounts this roadmap introduces; add them to the COA and to
  `CF_CLASSIFY` in `ledger.service.ts` so the indirect SCF buckets them correctly.
- Withhold on certify (A1/B2), release on schedule (A2/B2), both surfaced as `retention_due` action-center
  exceptions. Single service (`modules/retention`, DRIZZLE-only to avoid a module cycle, like
  `modules/commitments`).

---

## 3. Permissions, roles & SoD

Extend the PPM permission group in `packages/shared/src/permissions.ts` (wire `PERMISSION_IMPLICATIONS`,
`PERM_GROUPS`, `PERM_TO_ROUTE`, `DEFAULT_ROLE_PERMISSIONS`):

- **New permissions:** `proj_billing` / `proj_billing_certify` (raise vs certify progress claims);
  `proj_subcon` / `proj_subcon_certify` (raise vs certify subcontract valuations); `proj_tender` (estimate/
  award); real-estate `re_sales` / `re_contract_approve` / `re_transfer`.
- **New SoD pairs (`SOD_RULES`):** raise-claim ≠ certify-claim; raise-valuation ≠ certify-valuation;
  estimate ≠ award (or reuse an approvals holder); RE contract author ≠ approver; RE transfer ≠ receipting.
- Retention **release** is a treasury/controller act (`gl_close`/`approvals`), segregated from claim raising.

---

## 4. GL / controls impact (summary)

Everything routes through **existing GL paths** with the `journalLines.project_id` dimension. **Only new
accounts:** retention receivable/payable (Phase 0). New controls to add via `compliance/build_rcm.py` (then
regenerate the xlsx — currently **180**; `tools/cutover/src/compliance.ts` harness updated per control):

| Control | Type | Asserts |
|---|---|---|
| **PROJ-15** | Preventive | Progress-claim certification & retention — no billing beyond certified % to date; retention withheld per policy; maker-checker (raise ≠ certify). |
| **PROJ-16** | Preventive | Subcontract valuation & retention payable — no valuation beyond certified progress; back-charges & retention audited; certified net to AP; maker-checker. |
| **PROJ-17** | Preventive | Tender→award governance — award is authorised; the seeded project BoQ enters draft→approved (controlled budget baseline). |
| **RE-01..04** | Preventive/Detective | Unit inventory integrity; contract price/discount authority; installment application integrity; authorised, fully-settled ownership transfer. |

RCM would reach **~187** (PROJ-15/16/17 + RE-01..04). Narratives affected: **PN-16** (project-accounting —
Tracks A/B/C), **PN-12** (revenue-recognition-billing — progress billing), **PN-02** (P2P — subcontract AP),
and a **new PN-29** (real-estate sales — Track D).

---

## 5. Navigation & UI (URL-stable additions)

**Project Management group** (`apps/web/src/lib/nav.ts`) gains three items and three `/projects/[code]` tabs:
- `nav.pm_tenders` → `/projects/tenders` (Track C) · `nav.pm_billing` → `/projects/billing` (Track A) ·
  `nav.pm_subcontracts` → `/projects/subcontracts` (Track B).
- Project workspace tabs: **การวางบิล (Billing)**, **ผู้รับเหมาช่วง (Subcontracts)**, and a **การประมูล/
  Estimate** view on the pipeline. Reuse the existing DataTable/dialog + recharts + `document-templates` — no
  new dependency.

**New Real Estate group** `nav.group.realestate` (Track D, feature-flagged, workspace `erp`): Developments,
Units, Bookings, Contracts, Installments, Transfers, RE dashboard.

---

## 6. Phased delivery roadmap

Sequential, each a shippable doc-synced PR landing **code + docs together**. Migrations use the **next free
4-digit number** (0249+) with a journal entry (ascending `when`) and the **`0232`-form** RLS loop for new
tenant tables. Order chosen so shared foundations land before dependents, cash-flow value first.

| Phase | Deliverable | Migration (from) | Control(s) | Harness |
|---|---|---|---|---|
| **P0** ✅ **DELIVERED** | Shared **retention sub-ledger** + retention GL accounts (1170/2440) | 0249 | (structure; feeds PROJ-15/16) | `projects` 165→**178** — withhold/release, over-release guard, due worklist, SCF operating-bucket |
| **P1** ✅ **DELIVERED** | **Track A** progress billing (งวดงาน) + retention receivable | 0250 | **PROJ-15** | `projects` 178→**190** — BoQ-line cumulative valuation, certify SoD, retention withheld to sub-ledger, AR-net/retention/revenue JE, Fixed-contract cap |
| **P2** ✅ **DELIVERED** | **Track B** subcontracts + retention payable + back-charge | 0251 | **PROJ-16** | `projects` 190→**203** — subcontract BoQ commitment, valuation certify SoD, retention withheld payable, AP-net/WIP/retention JE, back-charge, over-budget cap |
| **P3** ✅ **DELIVERED** | **Track C** tender/estimate → award seeds project+BoQ | 0252 | **PROJ-17** | `projects` 203→**214** — estimate cost build-up, status machine, won-only idempotent award → Fixed project + draft BoQ (bid→rate), maker-checker approve baseline, win-rate |
| **P4** ✅ **DELIVERED** | **Track D1–D2** RE units + booking/contract/installments | 0253 | **RE-01/02/03** | `projects` 214→**230** — unit availability grid, book (no double-alloc), maker-checker contract, down-payment→2410, installment pay-once/exact/idempotent |
| **P5** | **Track D3–D4** ownership transfer + RE workspace/dashboard | 0254+ | **RE-04** | `realestate` — settled-only transfer, revenue, IA smoke |

**Suggested order:** P0 → P1 → P2 → P3 (the contractor completion), then P4 → P5 (the real-estate vertical) —
the property track is fully separable and can be deferred or dropped without affecting P0–P3.

---

## 7. Compliance & test strategy

- Extend `tools/cutover/src/projects.ts` (165 checks) per contractor phase; add a new
  `tools/cutover/src/realestate.ts` gate for Track D. `basics` (finance/GL) is the primary gate for the AR/AP
  and retention GL postings — extend it for retention withhold/release and progress-billing/subcontract
  journals. Keep both green (`NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover projects|basics`).
- UAT under `docs/uat/` from **UAT-O2C-243+** (contractor) and a new **UAT-RE-01+** family (property), each
  with positive + negative/control cases — especially **over-certification block**, **retention
  withhold/release integrity**, **award→BoQ seeding**, and **transfer-before-full-settlement rejection** —
  and keep the traceability matrix in sync (map to PROJ-15/16/17, RE-01..04).
- Reflect each new control in `tools/cutover/src/compliance.ts` and regenerate the RCM xlsx
  (`python3 compliance/build_rcm.py` from repo root; take *ours* on the binary, then regenerate).
- Every phase reconciles docs per the CLAUDE.md documentation-sync policy before it's "done".

---

## 8. Risks · assumptions · out of scope · open questions

- **Risk — revenue-recognition overlap.** Progress billing must reconcile with the existing POC
  `rev_rec_*` engine (billings-in-excess vs revenue-earned). Design A1 so certified value drives recognition
  and the invoice is the **billing** event, not a second recognition — prove with a `basics` case.
- **Risk — retention atomicity & release.** Withhold-on-certify and release-on-schedule must not double-count;
  mirror the commitment-ledger atomicity pattern. A retention balance = `withheld − released` per party/doc.
- **Risk — Track D scope creep.** Real-estate is a genuine vertical (masters, contract lifecycle, tax on
  transfer). Feature-flag it; deliver P4/P5 only if the property use-case is confirmed.
- **Out of scope (unless requested):** external estimating-tool / Excel take-off import; measurement-book
  photo evidence; multi-currency retention; variation-order pricing workflow beyond existing change orders;
  RE mortgage/loan-bank integration; RE common-area/juristic-person (นิติบุคคล) management.
- **Assumptions:** BoQ line remains the unit of budget & valuation; WIP 1260 stays the project cost sink;
  existing `workflow`/`messaging` (LINE) are the approval transport; `document-templates` render certificates.
- **Open questions to ratify with product/finance:**
  1. **Retention release triggers** — practical-completion % + DLP-end date the default two-tranche policy?
     Per-project configurable?
  2. **Progress-claim basis** — BoQ-line % complete, milestone %, or both selectable per project?
  3. **Back-charge modelling** — a negative valuation line vs a separate debit-note document?
  4. **Track D go/no-go** — is the real-estate developer vertical in scope now, or parked behind a flag until a
     property tenant is onboarded?

---

## Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.6 | 2026-07-05 | ERP / Product | **P4 DELIVERED — Track D (D1–D2) real-estate developer unit sales (RE-01/02/03).** `re_projects` + `re_units` + `re_bookings` + `re_contracts` + `re_installments` (migration **0253**, tenant-scoped RLS via the canonical 0232 loop, tenant-leading indexes); standalone `RealEstateService` (`modules/realestate`, imports Ledger — no cycle): developments/units + **availability grid** (**RE-01** — book only an available unit `UNIT_NOT_AVAILABLE`, contract only available/reserved `UNIT_NOT_CONTRACTABLE`, no double-allocation); **booking** (deposit → Dr 1000 / Cr 2210, unit reserved); **sale contract** draft→approve **maker-checker** (**RE-02**, `SOD_SELF_APPROVAL`/`CONTRACT_NOT_DRAFT`, price/discount bounds `BAD_DISCOUNT`/`BAD_DOWN_PAYMENT`; on approve unit→contracted, down-payment → Dr 1000 + Dr 2210 reclass / **Cr 2410 contract liability**, installment schedule generated; new **SoD rule R19**); **installments** pay-once/exact-amount/idempotent (**RE-03**, `INSTALLMENT_PAID`/`BAD_AMOUNT`, Dr 1000 / Cr 2410). Permission-gated (`re_sales` / `re_contract_approve`) so a non-property tenant never sees it — **no new GL accounts** (revenue recognises at transfer, P5). **3 new controls RE-01/02/03** → RCM **186** (xlsx regenerated, census 189/186 reconciled). Docs-synced: **new PN-31** (real-estate-sales), **new user-manual 15**, **new UAT-RE-01..03** (`docs/uat/12-real-estate-uat.md`) + traceability. `projects` harness 214→**230**; `basics` 251 / `compliance` 134 / `tenant-idx` (341/0) / `migration-parity` / `rcm-census` / `ts-debt` all green; API + web typecheck clean. |
| 0.5 | 2026-07-05 | ERP / Product | **P3 DELIVERED — Track C tender / estimating → award (PROJ-17). Contractor track (P0–P3) complete.** `project_tenders` + `tender_boq_lines` (migration **0252**, tenant-scoped RLS via the canonical 0232 loop); standalone `TendersService` (`modules/tenders`, imports ProjectsModule — no cycle): `createTender`/`addLine` (cost build-up, `bid_rate = unit_cost × (1+markup%)`), `submit` (`EMPTY_TENDER`), `setOutcome` (won/lost, `LOSS_REASON_REQUIRED`, `TENDER_DECIDED`), `award` (authorised, **won-only** `TENDER_NOT_WON`, **idempotent** — reuses `ProjectsService.create` + `createBoq` to seed a Fixed project + **DRAFT** BoQ from the winning bid, whose existing maker-checker approve sets the controlled budget baseline). Endpoints `/api/tenders` (create, `:no/lines|submit|outcome|award`, list, get), perm **`proj_tender`**. **No GL impact** (modelling surface). **New control PROJ-17** → RCM **183** (xlsx regenerated, census 186/183 reconciled). Docs-synced: PN-16 rev 0.38 (step 31), user-manual 14 rev 2.16, UAT-O2C-246 + traceability, O2C status v0.16. `projects` harness 203→**214**; `basics` 251 / `compliance` 134 / `tenant-idx` (336/0) / `migration-parity` / `rcm-census` / `ts-debt` all green; API + web typecheck clean. |
| 0.4 | 2026-07-05 | ERP / Product | **P2 DELIVERED — Track B subcontractor management + retention payable (PROJ-16).** `project_subcontracts` + `subcontract_scope` + `subcontract_valuations` (migration **0251**, tenant-scoped RLS via the canonical 0232 loop, tenant-leading indexes); standalone `SubcontractsService` (`modules/subcontracts`, imports Ledger + Retention + Commitments — no cycle): `createSubcontract` (scope → `CommitmentsService.reserve` against BoQ-line budget, `BUDGET_EXCEEDED` unless `allow_over`), `createValuation` (cumulative % valuation — `NOTHING_TO_CERTIFY`/`BAD_BACK_CHARGE`), `certifyValuation` (**maker-checker** `SOD_SELF_APPROVAL`, `VALUATION_NOT_DRAFT`, `VAL_EXCEEDS_SUBCONTRACT`; atomic JE **Dr 1260 (gross−back) / Cr 2000 AP net / Cr 2440 retention payable** + `RetentionService.withhold` in one tx; capitalises the works cost into project WIP/cost_to_date). Endpoints `/api/subcontracts` (create, `:subNo/valuations`, `valuations/:valNo/certify`, `project/:code`), perms **`proj_subcon`** (raise) vs **`proj_subcon_certify`** (certify) with **SoD rule R18**. **New control PROJ-16** → RCM **182** (xlsx regenerated, census 185/182 reconciled). Docs-synced: PN-16 rev 0.37 (step 30), user-manual 14 rev 2.15, UAT-O2C-245 + traceability, O2C status v0.15. `projects` harness 190→**203**; `basics` 251 / `compliance` 134 / `tenant-idx` (334/0) / `migration-parity` / `rcm-census` / `ts-debt` all green; API + web typecheck clean. |
| 0.3 | 2026-07-05 | ERP / Product | **P1 DELIVERED — Track A progress billing / งวดงาน + retention receivable (PROJ-15).** `project_progress_claims` + `progress_claim_lines` (migration **0250**, tenant-scoped RLS via the canonical 0232 loop); standalone `ProgressBillingService` (`modules/progress-billing`, imports Ledger + Retention — no cycle) with `createClaim` (BoQ-line **cumulative** valuation — `value_this_claim = budget×pct/100 − previously certified`; `BAD_PERCENT`/`NOTHING_TO_BILL`) and `certifyClaim` (**maker-checker** `SOD_SELF_APPROVAL`, `CLAIM_NOT_DRAFT`, `BILL_EXCEEDS_CONTRACT`; atomic JE **Dr 1100 net / Dr 1170 retention / Cr 4200 gross** + WIP relief 5800/1260 + `RetentionService.withhold` in one tx). Endpoints `/api/progress-billing` (create, `:claimNo/certify`, `project/:code`, `:claimNo`), perms **`proj_billing`** (raise) vs **`proj_billing_certify`** (certify) with **SoD rule R17**. **New control PROJ-15** → RCM **181** (xlsx regenerated, census 184/181 reconciled). Docs-synced: PN-16 rev 0.36 (step 29), user-manual 14 rev 2.14, UAT-O2C-244 + traceability, O2C status v0.14. `projects` harness 178→**190**; `basics` 251 / `compliance` 134 / `tenant-idx` (331/0) / `migration-parity` / `rcm-census` / `ts-debt` all green; API + web typecheck clean. |
| 0.2 | 2026-07-05 | ERP / Product | **Phase 0 DELIVERED — shared retention sub-ledger.** `retention_ledger` + `retention_release_schedule` (migration **0249**, tenant-scoped RLS via the canonical 0232 loop); standalone `RetentionService` (`modules/retention`, DRIZZLE-only) with `withhold`/`release` (atomic `FOR UPDATE` over-release guard → `RETENTION_OVER_RELEASE`)/`due`/`listForProject`, exposed at `/api/retention` (gl_close/exec/ar/creditors). Two new GL accounts **1170 Retention Receivable** (Asset) / **2440 Retention Payable** (Liability) added to the COA seed + bucketed **operating** in `CF_CLASSIFY`. Sub-ledger tracks balances only (A/B post the matching GL) — **no new control, RCM stays 180**. Docs-synced: PN-16 rev 0.35, user-manual 14 rev 2.13, UAT-O2C-243 + traceability. `projects` harness 165→**178**; `basics` 251 / `compliance` 134 / `tenant-idx` / `migration-parity` / `ts-debt` all green; API build + `pnpm -r typecheck` clean. |
| 0.1 DRAFT | 2026-07-05 | ERP / Product | Initial planning roadmap benchmarking Mango ERP for Construction: progress billing + retention receivable (Track A), subcontractor management + retention payable (Track B), tender/estimate→award (Track C), and an opt-in real-estate developer vertical (Track D), on a shared retention sub-ledger (Phase 0). Builds on `docs/32` material-control spine + PPM/PMO. No code yet. |
