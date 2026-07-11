# 44 — PPM + CRM Next-Level Depth Roadmap

> **Date:** 2026-07-11 · **Status:** v0.1 DRAFT — PLANNING (no feature code yet) · **Owner:** ERP / Product
> **Scope:** Take the now-mature **PPM** (`docs/19`/`20`/`23`, `modules/projects`) and **CRM**
> (`modules/crm`, CRM-1..6) to the next level of *depth* — plus a **port backlog** distilled from the
> companion Salesforce-clone repo **`wayla69/constellation-crm`**.
> **Discipline (same as docs/19/20/23):** each feature is an independently-shippable, doc-synced PR —
> migration + module + permissions/SoD + a **new RCM control** (`build_rcm.py` → regen xlsx + census markers)
> + process-narrative + user-manual + UAT + cutover-harness — merged only on a fully-green CI matrix.

---

## 0. Read this first — both modules are already mature

This is **not** UI-surfacing of orphaned backends (the recent 5-PR wave). Going deeper here means **net-new
features**. Already delivered — do **not** re-propose:

- **PPM** (`apps/api/src/modules/projects/`): WBS/tasks (FS deps + RACI), milestones w/ billing triggers,
  resource assignment + rate cards + utilization + month-horizon capacity, full EVM (PV/EV/AC/CPI/SPI/EAC +
  S-curve + RAG), CPM schedule + critical path, change-controlled baselines + variance, templates,
  risk/issue register + portfolio top-risks, change orders (PROJ-10), health snapshots, portfolio EVM
  rollup, programs + program critical path, action/exception center (PROJ-11), POC recognition (PROJ-09),
  commitment/encumbrance ledger (PROJ-12), site cash (PROJ-14), BoQ + PMR (docs/32),
  subcontracts/tenders/progress-billing, period close review (PROJ-03), pipeline-weighted forecast,
  governance pack. **Controls PROJ-02..18.**
- **CRM** (`apps/api/src/modules/crm/`, `modules/cpq/`): unified pipeline spine
  (leads/accounts/contacts/opportunities/stage_history/activities), lead capture (web-to-lead + import
  wizard + A–D scoring + round-robin, CRM-4), opportunities w/ governed stage machine + audit + deal
  workspace, win/loss + funnel + source-ROI (CRM-5), commit/best-case/pipeline forecast + quota attainment,
  follow-up SLA/rotting sweep, two-way email/LINE/SMS comms (CRM-6), Customer-360 (CRM-3), RFM/churn/LTV,
  CPQ quoting, deep loyalty/campaign/marketing/NPS stack. **Controls CRM-1..6.**

**Grounding (verified at audit time):** next control ids **PROJ-19** and **CRM-7** (per-domain sequences);
migrations are hand-journaled — **take the live next-free 4-digit number** at each wave's build (main is very
active: it was `0336` at audit and has already advanced past `0341`). Canonical RLS =
`apps/api/drizzle/0232_reapply_org_rls.sql` (org-clause DO-loop — copy *this* body for every new tenant
table + a leading `(tenant_id,…)` index); census/ratchet gates in `tools/ci/` + `.github/workflows/ci.yml`.

---

## Wave 0 — constellation-crm intake & diff (DONE — findings below)

`wayla69/constellation-crm` is a **Salesforce-platform clone** (NestJS 10 + React/Vite): a metadata engine
(custom objects/fields, formula + roll-up fields, validation rules, record types, page layouts), Lightning
UX (App Launcher, ⌘K palette, global search, feed), a full **record-level security model** (OWD, role
hierarchy, sharing rules, manual shares, FLS), and **declarative automation** (workflow rules, time-based
scheduler, multi-step approval processes, visual Flow builder). Modules: `metadata record record-type layout
list-view validation fls permissions sharing access security` · `approval routing sla scoring` · `convert
cpq pricebook contract campaign forecast duplicates knowledge` · `email email-to-case webtox calendar
activity feed notification` · `reports reportbuilder dashboard(s) nl-report copilot` · `import files audit
recycle-bin search`.

It is a **platform**, not an ERP-embedded CRM. We do **not** port the metadata engine or SPA wholesale.
We cherry-pick the highest-value features that map to invisibleERP's CRM depth gaps, adapted to our
Drizzle/RLS/SOX architecture.

### Port-candidate backlog (ranked; feeds the CRM waves)

| # | constellation feature (module) | invisibleERP today | Verdict | Maps to |
|---|---|---|---|---|
| 1 | **Persisted quotas + territory** (`forecast/quotas`) | quota is an optional forecast param | **net-new** | CRM-9 (C1) |
| 2 | **Pricebooks + entries** (`pricebook`) | CPQ has configs/rules, no pricebook | **net-new** | CRM-14 (C3) |
| 3 | **Duplicate check + merge** (`duplicates`) | import-wizard dup governance only | **partial→net-new** | CRM-17 (C4) |
| 4 | **Service Cloud: Case + Email-to-Case + Entitlements/SLA + Knowledge + routing** (`email-to-case sla knowledge routing`) | `/service` (SVC-1..3) thin; CRM-6 email→lead/opp (no Case) | **net-new module** | **new Service track** |
| 5 | **Campaign influence / attribution** (`campaign`) | single-touch `crm_source_roi` | **net-new** | CRM-15 (C4) |
| 6 | **Declarative validation rules** (`validation`) | per-DTO Zod only | **net-new (scoped to CRM objects)** | CRM data-quality |
| 7 | **Activity feed (Chatter-style) + unified timeline** (`feed activity calendar`) | per-entity activity list | **partial→net-new** | CRM-8 (C1) |
| 8 | **⌘K command palette + global search** (`search`) | per-page search | **net-new (cross-app UX)** | platform UX win |
| 9 | **Self-serve report/dashboard builder + NL report** (`reportbuilder nl-report`) | fixed BI report types | **net-new** | BI depth (separate) |
| 10 | **AI Copilot** (`copilot`, Anthropic) | limited | **net-new** | platform (separate) |
| 11 | **Multi-step declarative approval engine** (`approval`) | hardcoded maker-checker per feature | **net-new (big)** | platform (separate) |
| 12 | **Record-level sharing / role hierarchy** (`sharing fls`) | RLS + permissions (no record sharing) | **net-new (big, ERP-questionable)** | park |
| 13 | Recycle bin (soft-delete + restore) + field-history audit (`recycle-bin audit`) | audit log exists; no restore | **partial** | platform (separate) |

**Headline recommendation:** the single biggest *coherent* port is **#4 — a Service Cloud track**
(Case object + Email-to-Case + Entitlements/SLA milestones + Knowledge base + routing), because
invisibleERP's `/service` is thin and constellation ships a complete, integration-tested pattern. #1
(quotas/territory) and #2 (pricebooks) slot directly into the CRM waves below.

---

## PPM waves (net-new; ranked value/effort). `[UI-mostly]` reuses backend · `[net-new BE]` new tables

### Wave P1 — cheap EVM/PM credibility wins
- **PROJ-19 Earned Schedule (ES / SPI(t) / SV(t))** `[BE-light]` — off the existing time-phased PV/EV
  S-curve in `projects-evm.service.ts`; `GET /api/projects/:code/earned-schedule` + ES card. No new tables.
- **PROJ-20 Multi-baseline comparison / trend** `[UI-mostly]` — `project_baselines` already stores
  snapshots; `GET /api/projects/:code/baselines/compare?a=&b=` + trend chart.
- **PROJ-21 Quantitative risk (P×I + risk-adjusted contingency) + issue→risk link** `[BE-light]` — add
  cols to `project_risks`; `project_issue_risk_links`; P×I heatmap.

### Wave P2 — cost & change integrity (SoD-rich)
- **PROJ-22 Bottom-up cost-to-complete / manual ETC→EAC + EAC scenarios** `[net-new BE]` — `project_etc`,
  `project_eac_scenarios`; ETC grid on WBS.
- **PROJ-23 Timesheet approval workflow + T&M billing + billability targets** `[net-new BE]` —
  `project_timesheets(+lines)`, `resource_utilization_targets`; submit/approve maker-checker (new
  `proj_timesheet` / `proj_timesheet_approve` SoD split in `permissions.ts` + `build_sod.py`).
- **PROJ-24 Change-order impact simulation** `[BE-light]` — reuse EVM+CPM pre-commit;
  `POST …/change-orders/:id/simulate` inside the PROJ-10 flow.

### Wave P3 — scheduling engine depth (biggest effort; after P1–P2)
- **PROJ-25 Rich dependencies (SS/FF/SF + lag/lead) + working calendars + constraints (SNET/FNLT) +
  interactive Gantt** `[net-new BE + heavy UI]` — replace `project_tasks.dependsOn` CSV with
  `project_task_deps`, `project_calendars`, `project_task_constraints`.
- **PROJ-26 Resource capacity heatmap + skills/role supply-vs-demand + named-vs-generic booking +
  leveling/smoothing** `[mixed]` — `resource_skills`, `role_demand`, `resource_bookings`; consumes PROJ-25.

### Wave P4 — portfolio & program governance (exec-facing)
- **PROJ-27 Portfolio scenario / what-if / prioritization / stage-gate selection** `[net-new BE]` —
  `portfolio_scenarios(+items)`, `portfolio_gates`.
- **PROJ-28 Program benefits-realization + cross-project dependency Gantt** `[net-new BE]` —
  `program_benefits(+actuals)`, `program_cross_deps`.
- **PROJ-29 Project phase-gate governance + benefits** `[net-new BE]` — `project_phase_gates`,
  `project_benefits` (maker-checker gate decisions).

---

## CRM waves (net-new; refined by the Wave-0 backlog)

### Wave C1 — daily-use depth + foundation
- **CRM-7 Pipeline kanban depth** `[UI-mostly]` — WIP limits, per-stage exit criteria / required fields
  (playbooks), bulk actions; `crm_stage_playbooks`; enhance existing `/crm` kanban.
- **CRM-8 Unified activity timeline + auto-capture (+ optional Chatter-style feed, port #7)** `[UI-mostly +
  hooks]` — `GET …/crm/timeline?entity=`; auto-capture from CRM-6 comms + stage history.
- **CRM-9 Territory & quota management** `[net-new BE, port #1]` — `crm_territories(+rules)`, `crm_quotas`;
  assignment rules + team roll-up. **Precedes CRM-12 forecasting depth.**

### Wave C2 — B2B account depth + forecasting
- **CRM-10 B2B Account/Contact 360 depth** `[net-new BE]` — parent-child hierarchy, buying-committee /
  relationship map, contact roles on deals, account plans, whitespace. **Precedes CRM-15/CRM-16.**
- **CRM-11 Forecasting depth** `[net-new BE]` — manual override roll-up (rep→manager), snapshots,
  forecast-vs-actual, pipeline-coverage, waterfall. **Requires CRM-9.**

### Wave C3 — sales-motion automation (reuses CRM-6 comms)
- **CRM-12 Sequences / cadences** `[net-new BE]` — `crm_sequences(+steps+enrollments)`; multi-step
  outreach (steps/waits/branch) on the existing comms engine.
- **CRM-13 Email/calendar 2-way sync + open/click tracking on SALES comms** `[net-new BE]` —
  `crm_email_sync_state`, `crm_comm_tracking`.
- **CRM-14 CPQ guided selling + pricebooks + bundles + in-deal discount-approval matrix + subscription/
  renewal/usage quoting** `[BE + UI, port #2]` — extend `modules/cpq`; add `cpq_bundles`,
  `cpq_pricebooks(+entries)`, `cpq_guided_rules`.

### Wave C4 — retention, attribution & data quality
- **CRM-15 Multi-touch campaign attribution → won revenue** `[net-new BE, port #5]` —
  `crm_campaign_influence`, `crm_attribution_models`. **Needs CRM-10 contact roles.**
- **CRM-16 B2B account health/churn + renewal & expansion pipeline (CS)** `[net-new BE]` —
  `crm_account_health`, `crm_renewals`, `crm_cs_tasks`. **Requires CRM-10.**
- **CRM-17 Dedupe/merge + enrichment + data-quality scoring** `[net-new BE, port #3]` — `crm_dq_scores`,
  `crm_merge_log` (maker-checker merge).

### New track — Service Cloud (port #4, the biggest coherent constellation port)
- **SVC-4 Case object + Email-to-Case** — a real Case entity (beyond CRM-6 email→lead/opp).
- **SVC-5 Entitlements + SLA milestones + routing** — `case_entitlements`, `case_sla_milestones`,
  assignment routing (constellation `sla`/`routing`).
- **SVC-6 Knowledge base** — articles + deflection, linked to cases.
  *(Deepens the existing `/service` SVC-1..3; sequence as its own mini-track after C1.)*

### Cross-cutting
- **CRM-G1 Consolidate legacy `api/pipeline` alias into `api/crm/pipeline`** (refactor; re-pin `golden` +
  `cutover:pipeline`). **Do early** (right after Wave 0) to de-risk every later CRM PR — the write path must
  stay byte-identical (`pipeline.service.ts` is a thin adapter over the spine).
- **CRM↔PPM back-flow (PROJ-30 / CRM-18 paired)** — auto renewal/expansion opportunity on project close
  (PROJ-03); delivered-project health signal onto `crm_account_health`. **Do last** (needs CRM-16 + close).

---

## Top picks — "if we only do a few" (ranked)
1. **Service Cloud track (SVC-4/5/6, port #4)** — biggest coherent, differentiated port; `/service` is thin.
2. **Earned Schedule (PROJ-19)** — tiny effort, marquee EVM gap.
3. **CRM kanban depth (CRM-7)** — UI-mostly, highest-frequency surface.
4. **Territory & Quota (CRM-9, port #1) → Forecasting depth (CRM-11)** — exec sales rigor, ordered.
5. **Timesheet approval + T&M billing (PROJ-23)** — real revenue-leakage control, SoD-rich.
6. **B2B Account-360 depth (CRM-10)** — unblocks health/churn + attribution.
7. **Pricebooks in CPQ (CRM-14, port #2)** — concrete CPQ gap constellation fills cleanly.
8. **Pipeline alias consolidation (CRM-G1)** — de-risks every later CRM PR; do early.

## Sequencing / dependencies
- **Wave 0 done** → **CRM-G1 alias consolidation** next (re-pin golden once) → then heavy CRM waves.
- CRM-9 (territory/quota) **before** CRM-11 (forecasting depth).
- CRM-10 (account depth) **before** CRM-15 (attribution) + CRM-16 (health/churn).
- PROJ-25 (dep-types/calendars) **before** PROJ-26 (leveling) + interactive Gantt.
- CRM-16 (health) + PROJ-03 (close) **before** CRM↔PPM back-flow.

## Risks / gotchas (this codebase)
1. **RLS DO-loop**: every new tenant table copies the **0232 org-clause body** + a leading `(tenant_id,…)`
   index, or `cutover:tenant-idx`/`tenant-isolation` fails.
2. **Census/ratchets**: each control PR bumps `build_rcm.py` (+ regen xlsx) + tagged census spans
   (`check-rcm-census`); `check-overclaims`, `check-ts-debt` (as-any down-only), `check-use-client`
   (client-first files down-only — reuse `crm-client.tsx`/`project-detail-client.tsx` shells for Gantt/kanban).
3. **Golden-master re-pin**: `crm-pipeline.service.ts` (~1100 loc) + `projects.service.ts` (~1150 loc) are
   god-services; shape changes force a `parity:golden` re-pin — batch spine changes around **CRM-G1**.
4. **Two-pipeline hazard**: keep the `/api/pipeline` adapter write path byte-identical through the spine
   (`cutover:pipeline` + `cutover:crm` both exercise it).
5. **SoD matrix drift**: new maker-checker features add single-duty splits in `permissions.ts` + a rule in
   `build_sod.py` (regenerate the SoD xlsx), mirroring R17/R18/R20.
6. **Harness shard bloat**: the `crm` shard already runs ~11 harnesses — consider a `crm-b`/`projects-b`
   shard in `ci.yml` rather than overloading one.
7. **Very active main**: expect repeated rebases + doc-status-line/UAT-id renumbering per PR (5× on one PR
   this session). Keep each wave's PR small and doc-scoped.
8. **License**: constellation is **MIT** — ports must still pass `check-licenses.mjs`; re-implement against
   our Drizzle/RLS stack rather than copying files verbatim.

## Verification (per wave/PR)
`pnpm -r typecheck` · `pnpm --filter @ierp/api build` · `pnpm --filter @ierp/web build` · ratchets
(`check-use-client`, `check-ts-debt`) · `check-rcm-census` · the feature's cutover harness
(`tools/cutover/src/projects.ts` for PPM; a new CRM/Service harness) · `parity:golden` (no unintended drift)
· drive the new screen end-to-end (Playwright mobile+desktop where UI-critical).

## Revision history
| Version | Date | Author | Summary |
|---|---|---|---|
| 0.1 DRAFT | 2026-07-11 | Platform | Initial roadmap. Audit of the (already-mature) PPM + CRM; Wave-0 diff vs `constellation-crm` (Salesforce clone) → port backlog; PPM waves PROJ-19..30, CRM waves CRM-7..18, a Service Cloud track (SVC-4..6), cross-cutting + sequencing + risks. No feature code yet. |
