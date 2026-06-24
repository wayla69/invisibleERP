# 11 — Next Upgrade Roadmap: Real-World Production Use vs. Global POS & ERP Standards

> **Date:** 2026-06-23 · **Status:** DRAFT v0.1 · **Owner:** Platform / Controller
> **Scope:** Define the *next* upgrade cycle now that the prior world-class roadmaps
> (`09-worldclass-roadmap.md`, `pos-worldclass-roadmap.md`) are substantially **delivered**.
> This plan benchmarks the as-built system against global POS (Square/Toast/Lightspeed/Oracle
> Simphony) and ERP (SAP S/4HANA, Oracle Fusion, NetSuite, Odoo) standards, identifies what
> actually blocks real-world go-live, and sequences the work.

---

## 0. Read this first — the roadmaps are stale, the app moved

The two earlier roadmaps were written when the system was "a Thai sales-order tracker with no
GL, no payments, and RLS designed-but-not-enforced." **That is no longer true.** A fresh code
inventory (2026-06-23) confirms the T0/T1 "table-stakes" and most of "POS P0" are now built and
CI-gated:

| Prior roadmap claimed missing | Actual current state (verified) |
|---|---|
| RLS designed but not enforced | ✅ `FORCE ROW LEVEL SECURITY`, `app_user` non-superuser role, per-request `SET LOCAL app.tenant_id`, fail-closed in prod, cross-tenant test in `worldclass`/`compliance` harness |
| No double-entry GL | ✅ `ledger` module: balanced JE, 3 parallel books (TFRS/TAX/IFRS), idempotent posting, period close, **GL-05 maker-checker** (Draft until a *different* user approves) |
| No payment capture | ✅ `payments` module: multi-tender, auth→capture→settle, refunds/voids, idempotency keys, gateway abstraction (mock/Stripe/PromptPay/Adyen), **terminal layer** (Opn/2C2P/GBPrime), settlement batches |
| Tracker, not POS | ✅ Till sessions, X/Z reports, cash movements, split bills, KDS (SSE), table/floor management, public QR diner flow, gift cards, loyalty, ESC/POS receipts, **hash-chained fiscal journal + Thai e-Tax submission** |
| Tests = "it compiles" | ✅ 59 cutover harnesses (8.5k LOC) boot the real app over PGlite; 8+ are **required CI gates** alongside CodeQL, gitleaks, `pnpm audit`, Playwright |
| No compliance posture | ✅ COSO 2013 RCM (66 controls, **49 implemented** after Phase A · 11 partial · 6 gap), 26 ISO/SOX process narratives, 16 SoD rules enforced in code, 159 UAT cases, ICFR audit-readiness plan |

**Conclusion:** the differentiation problem is solved. The remaining problem is **operational
maturity and breadth** — the unglamorous layer that separates "passes a demo and a code review"
from "a regulated multi-site customer runs their business on it, 24/7, and an auditor signs off."
That is what this roadmap targets.

---

## 1. Honest verdict (2026-06-23)

This is now a **genuine multi-tenant ERP + POS with a credible Thai-compliance and SOX-controls
story** — tier-1 on isolation, audit controls, and F&B/retail verticalization; tier-2 on
manufacturing depth and supply planning. It is **feature-complete enough to pilot** with a real
Thai restaurant/retail group today.

What stops it from being *operated* at real-world scale and sold beyond a friendly pilot is **not
features — it's the run-time and trust envelope**:

1. **No deployment substrate.** No Dockerfile, no Kubernetes/IaC, no documented runtime topology.
   You cannot reproducibly ship or scale it.
2. **No business-continuity story.** No automated backups, no tested restore, no DR/RTO/RPO. One
   bad `DROP` or disk failure = the customer's books are gone. This is a go-live blocker, full stop.
3. **Secrets in `.env`, observability opt-in.** Vault/KMS deferred; OTel + Sentry wired but not
   enforced in prod. You'd run a financial system effectively blind.
4. **POS offline-first still not done.** The single biggest real-world POS gap — a restaurant
   cannot stop selling when the internet drops. Foundations (idempotency keys) exist; the client
   outbox + sync engine does not.
5. **Global breadth is Thailand-deep but one-country-wide.** Multi-currency ledger, non-Thai tax/
   e-invoicing, and a real i18n framework are not there yet — fine for Thailand, blocking for export.

The fix is **not** more modules. It is a disciplined ~6–9 month sequence: **harden to operate
(Phase A) → close the POS/ERP standard gaps that real customers hit (Phase B) → globalize and
certify (Phase C)** — with the agentic-write differentiator (Phase D) layered on a now-trustworthy
base.

---

## 2. Benchmark vs. global POS standard

Reference set: **Square, Toast, Lightspeed, Oracle Simphony, Shopify POS.**

| Capability | Global standard | Invisible POS today | Gap / next move |
|---|---|---|---|
| Multi-tender, split bill, tips | ✅ baseline | ✅ multi-tender, equal/by-item split, tips | — |
| KDS, coursing, table mgmt | ✅ | ✅ multi-station KDS (SSE), tables/zones, QR diner | Add **coursing/seat-level firing**, course holds |
| Card present (EMV/tap), pre-auth/tabs | ✅ | ✅ terminal abstraction (Opn/2C2P/GBPrime), pre-auth, capture, settlement | Certify against a **real acquirer sandbox**; tip-on-terminal |
| QR / local rails | ✅ regional | ✅ PromptPay EMVCo | Add e-wallets (LINE Pay, TrueMoney, Alipay+) |
| **Offline-first selling** | ✅ **table-stakes** | 🟡 saleDate replay only; no client outbox | ⛔ **Phase B1** — true offline (IndexedDB/PGlite outbox + idempotent sync). *Biggest gap.* |
| Hardware: printer, drawer, scanner, scale, CFD | ✅ | 🟡 ESC/POS render, scale module, CFD endpoint | Build **peripheral bridge** (WebUSB/WebSerial or local agent); drawer kick, scanner wedge |
| Pricing: happy-hour, BOGO, combos, surcharge | ✅ | 🟡 promo engine + markdown cap | Build **time/day pricing rules**, combos explode, auto service charge, satang rounding |
| Cashier speed (hotkeys, quick-tender, favorites) | ✅ | 🟡 basic cart UI | **Phase B2** — keypad, hotkeys, quick-tender, favorites grid |
| Park/recall, bar tabs | ✅ | ✅ held orders | Wire tabs to pre-auth |
| Manager overrides + reason codes + audit | ✅ | ✅ overrides, reason codes, append-only audit | — (strong) |
| Fiscal/e-invoice compliance | regional | ✅✅ **best-in-class for TH** (hash-chained journal, RD/ETDA e-Tax) | Extend pattern to other jurisdictions (Phase C) |
| Loyalty, gift cards, house accounts | ✅ | ✅ all three, GL-posted | — |
| Inventory deduction at sale | ✅ | ✅ recipe→ingredient, `FOR UPDATE`, COGS GL, oversold flag | — (strong) |
| Self-order kiosk / online channel | ✅ | 🟡 channel fields + public diner QR | Productionize kiosk + online ordering UX |
| Multi-site mgmt, central menu push | ✅ | 🟡 branch module | Central menu/price publish to branches; per-site reporting |

**POS verdict:** at parity or ahead on transactions, fiscal compliance, and inventory; **behind on
offline-first, hardware integration, pricing depth, and cashier ergonomics** — exactly the things a
busy floor feels on day one.

---

## 3. Benchmark vs. global ERP standard

Reference set: **SAP S/4HANA, Oracle Fusion, NetSuite, Odoo.**

| Module area | Global standard | Invisible ERP today | Gap / next move |
|---|---|---|---|
| Financials: GL/AR/AP, multi-book, consolidation, FX reval | ✅ | ✅ GL (3 books), AR/AP, intercompany, consolidation, FX reval | Deepen **multi-currency** (functional/transaction/reporting + reval already present; widen coverage) |
| Controlling/costing | ✅ | ✅ standard/actual costing, PPV, profitability, project WIP | Add cost-center allocations, activity-based costing |
| Procure-to-Pay + 3-way match | ✅ | ✅ PR/PO/GR, 3-way match, sourcing/RFQ | **Hard-gate** match on AP payment (control EXP-03) |
| Inventory / WMS | ✅ | ✅ lots, locations, stock-ops, WMS, scan | Add **bin-level WMS**, wave picking, cycle-count SoD |
| Manufacturing / MRP | ✅ (deep) | 🟡 BOM, work orders, recipe costing | ⛔ **No MRP / supply planning / multi-level BOM explosion / capacity scheduling** — biggest ERP gap |
| Fixed assets | ✅ | ✅ register, depreciation, disposal | — |
| HCM / payroll | ✅ (deep) | 🟡 payroll, timesheets, leave | Add **employee self-service portal**, org structure, expense mgmt |
| Tax engine | regional | ✅✅ TH VAT/WHT/e-Tax | **Pluggable tax engine** (Avalara/Stripe Tax) + non-TH e-invoicing (Phase C) |
| Revenue recognition / billing | ✅ | ✅ subscription, deferred rev, milestones | ASC 606 / IFRS 15 multi-element schedules — verify depth |
| Planning / budgeting / BI | ✅ | 🟡 budgets, forecasting, analytics, BI cubes | Semantic layer (dbt/Cube) + embedded BI; demand ML |
| CRM / CPQ / pipeline | ✅ | ✅ CRM, pipeline, CPQ, marketing | — |
| Projects / PSA | ✅ | ✅ project accounting, WIP, billing | — |
| Quality mgmt (QM) | ✅ (SAP/Oracle) | ❌ none | Add inspection/non-conformance if targeting mfg |
| Vendor/supplier portal | ✅ | ❌ none | Supplier collaboration portal |
| Localization packs (multi-country) | ✅ (Odoo l10n) | ❌ TH only | Country packs (Phase C) |

**ERP verdict:** financial-accounting breadth rivals NetSuite/Odoo and **exceeds them on Thai
statutory compliance and built-in SOX controls**. The real gaps are **MRP/advanced manufacturing,
HR self-service, multi-country localization, and supplier/employee portals** — plus the
production-ops layer covered next.

---

## 4. The real-world go-live blockers (prioritized)

These are ranked by "what stops a paying customer from running their business on this safely."

| # | Blocker | Why it blocks real-world use | Control ID | Effort |
|---|---|---|---|---|
| **1** | **No backup + tested restore** | A financial system with no recoverable backups cannot go live. Period. | ITGC-OP-01 | **M** |
| **2** | **No deployment substrate (Docker/IaC)** | Can't reproducibly ship, scale, or hand to ops/SRE | — | **M** |
| **3** | **Secrets in `.env`, no KMS/vault/rotation** | One leaked repo/host = full breach; fails every security questionnaire | ITGC-AC-12 | **M** |
| **4** | **Observability not enforced in prod** | Running a money system blind; no alerting/on-call/incident process | ITGC-OP-03/04 | **S/M** |
| **5** | **POS not offline-first** | Restaurants/shops lose sales (and trust) the moment the link drops | — | **L** |
| **6** | **No deploy-approval gate / branch protection** | Author can self-deploy to prod; fails change-management ICFR | ITGC-CM-01/03 | **S** |
| **7** | **Entity-level policies still DRAFT** | ELC-01/02/03 (Code of Conduct, Audit Committee, DoA) needed for IPO/audit | ELC-01..05 | **M** |
| **8** | **DB least-privilege roles + token hardening incomplete** | `app_user` exists but prod roles unformalized; tokens in localStorage | ITGC-AC-13/07 | **M** |

Items 1–4 and 6 are **cheap relative to their stakes** and should be the next sprint. Item 5 is the
single highest-ROI *feature* for POS customers.

---

## 5. Phased upgrade plan

Effort key: **S** ≈ 1–3 days · **M** ≈ 1–2 weeks · **L** ≈ 3–6 weeks. Every phase follows repo
conventions: Drizzle schema + hand-written migration in `meta/_journal.json`; tenant tables get
`tenant_id` + RLS; GL only via `ledger.postEntry`; `FOR UPDATE` on RMW; `ymd()`/Bangkok dates; a
`tools/cutover/*` harness green on PGlite; web page + nav; `tsc` clean; **docs synced per CLAUDE.md**.

### Phase A — Operate it for real (production hardening) · **DELIVERED 2026-06-23 (config/setup follow-ups noted)**
*Goal: a customer's data is safe, the system is observable, and we can ship it reproducibly.*

> Phase A landed as code + ops artifacts + docs. Items needing a one-time action in the GitHub/cloud
> console (apply the ruleset, set Environment reviewers, point secrets at a vault, run the first drill)
> are flagged **[setup]**; everything else is in the repo and CI-verified.

- **A1 — Backup & restore (ITGC-OP-01).** ✅ `tools/ops/pg-backup.sh` (existing) + **new scripted
  `restore.sh` and automated drill `verify-restore.sh`** (restore into scratch DB → sanity-check core
  tables → evidence). RTO/RPO + evidence table in `tools/ops/BACKUP-RUNBOOK.md`. **[setup]** run the
  first quarterly drill; enable provider PITR. *Blocker #1 closed.*
- **A2 — Containerize + IaC.** ✅ Multi-stage non-root `apps/api/Dockerfile` + `apps/web/Dockerfile`,
  `docker-compose.yml` (Postgres+api+web), `.dockerignore`, entrypoint with optional migrate; topology
  in `docs/ops/deployment.md`. (Helm/Terraform left as a later infra choice; Railway remains primary.)
- **A3 — Secrets (ITGC-AC-12).** ✅ Boot-time **fail-closed** validation `apps/api/src/common/env.validation.ts`
  (refuses prod boot without `DATABASE_URL`/`JWT_SECRET`/`APP_ENC_KEY`/PSP secret; verified). Policy +
  matrix + rotation in `docs/ops/secrets.md`. **[setup]** move values into a managed vault; KMS-envelope
  for `APP_ENC_KEY` tracked as follow-up.
- **A4 — Observability + health (ITGC-OP-03/04).** ✅ Prod warns at boot when OTel/Sentry unset;
  new `/healthz` (liveness) + `/readyz` (DB readiness) probes; alerting/on-call/incident +
  batch-job-failure runbook in `docs/ops/observability-incident.md`. **[setup]** wire the dashboards/
  alert rules + on-call rotation.
- **A5 — Change-management gates (ITGC-CM-01/03/04).** ✅ `.github/CODEOWNERS`, PR template (ticket +
  control-impact + docs-sync), approval-gated `deploy.yml` (GitHub `production` env ⇒ deployer ≠ author),
  importable `.github/rulesets/main-branch-protection.json`, runbook `docs/ops/change-management.md`.
  **[setup]** import the ruleset + set Environment required reviewers + `RAILWAY_TOKEN`.
- **A6 — DB least-privilege + token hardening (ITGC-AC-13/07).** ✅ `tools/ops/sql/prod-db-roles.sql`
  (dedicated non-owner `ierp_app` login in the `app_user` group; FORCE-RLS re-assert; revoke PUBLIC) —
  run by the DBA, intentionally outside the migration chain so it can't hit the PGlite harnesses.
  🟡 **Deferred:** web auth `localStorage` → httpOnly cookie + CSRF is a cross-cutting web+api change;
  scheduled as its own tested workstream.
- **Exit:** ✅ restore drill scripted + repeatable; one-command reproducible build (compose/Docker);
  prod boot blocked without secrets (verified); change/deploy gates in repo; `main` ruleset ready to
  import. Verified: `pnpm -r typecheck` + API build clean; `e2e`/`compliance`/`worldclass` harnesses green.

### Phase B — Close the POS standard gaps customers hit · **IN PROGRESS (2026-06-23)**
*Goal: the floor experience matches Square/Toast on the things staff feel hourly.*

> Reality check (verified on the as-built code): the pricing **engine** and the offline-sync
> **backend** already existed. The gaps were (a) rules not applied at the till, (b) cashier
> ergonomics, (c) the offline client + hardware bridge. Backend/verifiable work landed and is
> CI-gated; browser/hardware pieces ship as typecheck-only scaffolds (no runtime verification here).

- **B1 — Offline-first POS.** ✅ *Backend already present* — `portal/offline-sync.service.ts` replays a
  batch idempotently, dedup `UNIQUE(tenant_id, client_uuid)`, per-op savepoints (`offline-sync`
  harness, CI-gated). ✅ *Client outbox added* — `apps/web/src/lib/offline-pos.ts` (IndexedDB
  enqueue/pending/sync → `POST /api/portal/pos/offline-sync`, auto-sync on reconnect). 🟡 **scaffold**
  (needs browser/IndexedDB to verify); service worker for app-shell/menu caching is the follow-up.
- **B2 — Cashier speed & control.** ✅ `/pos/new` quick-tender (exact/฿100/฿500/฿1000) + live change +
  hotkeys (F2 add line, F9 confirm). Build-verified. (Favorites grid + POS-native returns wrapper = next.)
- **B3 — Peripheral bridge.** 🟡 **scaffold** `apps/web/src/lib/peripherals.ts` — WebUSB/WebSerial
  ESC/POS print, cash-drawer kick, keyboard-wedge scanner. Typecheck-only (needs hardware + a browser
  gesture; acquirer-terminal certification remains).
- **B4 — Pricing engine → at the till.** ✅ *Engine existed*; now **applied at checkout**: dine-in
  checkout opt-in (`apply_pricing_rules`) runs item/category/time-day/BOGO/qty-break + order rules
  through the existing discount/VAT/markdown-cap path, plus auto service charge (VATable → acct 4400)
  and satang rounding (→ acct 4900), balanced GL. New `pricing` harness (18 checks); restaurant/
  pos-discount/splitbill stay green. (Wiring into retail `pos.service`/portal = next.)
- **Exit (target):** sell through a 30-min outage with deterministic sync; sub-second tender on
  hotkeys; printer/drawer/scanner working; happy-hour + combo + service-charge priced correctly.
  **Done so far:** rules + service charge + rounding priced & GL-correct at the till (verified);
  cashier quick-tender/hotkeys (build-verified); offline + peripheral clients scaffolded.

### Phase C — Globalize & certify · ~8–12 weeks
*Goal: legally and operationally sellable beyond Thailand; passes enterprise security review.*

- **C1 — Multi-currency depth.** Confirm functional/transaction/reporting currency on every money
  row; FX reval coverage across AR/AP/GL/inventory; rounding policy per currency.
- **C2 — Pluggable tax + e-invoicing.** `TaxProvider` interface (Avalara/Stripe Tax adapter beyond
  TH 7%); e-invoicing adapters following the proven TH pattern (Peppol / India IRN / Italy SdI /
  MX CFDI).
- **C3 — Real i18n framework.** Replace hardcoded TH/EN dicts with ICU/`next-intl`; abstract
  locale/currency/date/number formatting; extract strings.
- **C4 — Certifications.** SOC 2 Type II + ISO 27001 readiness (leverage existing RCM/policies);
  PCI-DSS scope design (SAQ-A via tokenized PSPs); third-party pen test.
- **C5 — Entity-level policies finalized (ELC-01..05).** Move DRAFT policies to approved; Code of
  Conduct + Audit Committee charter + Delegation of Authority + whistleblower + fraud-risk register;
  acknowledgement registers. *Needed for IPO/audit track.*
- **Exit:** a non-THB tenant transacts and reports correctly; clears one non-TH e-invoice mandate in
  sandbox; SOC 2 Type I report or readiness assessment in hand; policies board-approved.

### Phase D — Differentiate (agentic ERP, deepen verticals) · **STARTED (2026-06-23)**
*Goal: the moat — an ERP that does the work, governed and auditable, on a now-trustworthy base.*

- **D1 — Agentic write-ops.** ✅ **Delivered (propose → approve → execute).** The agent is read-only by
  default; its write-tools (`propose_journal_entry`/`propose_purchase_order`) file a **PENDING**
  `ai_action_requests` row (RLS-scoped, migration 0063). A **different** authorized human approves via
  `/ai-actions`; `approve()` enforces SoD (approver ≠ proposer) + the kind permission (`gl_post`/
  `procurement`), then executes through `LedgerService.postEntry`/`ProcurementService.createPo` with
  `result_ref` + audit. New `ai-actions` harness (14 checks); approval-queue UI shipped. *Next: stock-
  adjust/tax-file kinds, $-threshold escalation, agent-action attribution in audit (`source='ai'`).*
- **D2 — RAG over policies/SOPs/contracts (cite-or-refuse).** ✅ **Delivered.** `kb_documents`/`kb_chunks`
  (migration 0064, RLS-scoped); pluggable `EmbedderService` (default deterministic local embedder → no
  API key, no pgvector) with embeddings as `number[]` + in-service cosine; `KnowledgeService.search/ask`
  retrieves the tenant's own docs and **refuses** below `KB_MIN_SCORE` (no hallucinated policy); agent
  tool `search_knowledge_base` + cite-or-refuse system prompt; endpoints `/api/ai/kb/*`. New `rag`
  harness (8 checks). *Prod upgrade: swap `EMBED_PROVIDER` for a real model + move `embedding` to a
  pgvector ANN column behind the same API.*
- **D3 — Close the ERP depth gaps.** ✅ **MRP deepened.** `MrpService.run` now does **multi-level
  (recursive) BOM explosion** with per-item on-hand netting (shared pool), planned Make orders at every
  level + Buy orders for leaves, a circular-BOM guard, and **`POST /api/mrp/plan-to-pr`** that turns the
  planned Buy into a real consolidated PR (reuses the PR→PO→GR workflow). New `mrp` harness (10 checks);
  `mfg-depth`/`manufacturing` stay green.
  ✅ **Employee self-service (ESS)** — `/api/ess/*` self-scopes from the JWT (own timesheets/leave/
  payslips/expenses); expense claims approve with SoD (approver ≠ claimant) + GL (Dr 5100/Cr 2000). New
  `ess` harness (9). ✅ **Supplier portal** — `/api/supplier/*` vendor-facing self-scoped: own POs,
  acknowledge, submit invoice → pending AP (can't touch another vendor's PO). New `supplier` harness (8).
  Linkage via `employees.user_name`/`vendors.user_name` (migration 0065). ✅ **Lot-sizing (EOQ)** — MRP
  `lot_sizing` flag raises each planned-buy to the item's min-order-qty / order-multiple / EOQ
  (`sqrt(2DS/H)`); item master gains those fields (migration 0066). ✅ **Rough-cut capacity** —
  `POST /api/mrp/capacity` loads each work-centre from routings (setup + run·qty) vs supplied available
  minutes and flags overloads. `mrp` harness now 16 checks. **D3 is complete.**
- **D4 — Analytics plane + demand ML.** ✅ **Demand ML shipped.** A new `DemandForecastService`
  (`/api/demand/*`) builds a dense daily demand series from POS sales and **walk-forward backtests** five
  classic, explainable models (SMA, SES, Holt linear-trend, seasonal-naive, Croston for intermittent
  demand), scoring **WAPE / MASE / RMSE / bias** per model; `forecast` **auto-selects the lowest-WAPE
  model** (or honours a pinned one), clamps the horizon non-negative, and persists each run (tenant-scoped,
  migration 0067) for an accuracy audit trail. `GET /api/demand/accuracy` is the forecast-accuracy KPI for
  the analytics plane. The parity-locked `forecasting.service.ts` (reorder points) is untouched. New
  `demand-ml` harness (14 checks) is a **CI gate** — it asserts Holt beats SMA on trend and Croston beats
  SMA on intermittent demand, plus RLS isolation. *Deferred (heavier infra): dbt + external semantic layer
  / embedded BI — the in-app BI module (`/api/bi/*`) + this accuracy KPI cover the near-term need.*

---

## 6. Sequenced summary & the strategic bet

**Now (next sprint):** Phase A1–A6 — *operate it safely.* Backups+restore, containerize, secrets→
vault, observability+alerting, change-management gates, DB roles/token hardening. Cheap relative to
stakes; unblocks every customer conversation and the audit track.

**Next (1 quarter):** Phase B — *win the floor.* Offline-first POS (B1) is the headline; pair with
cashier speed, peripheral bridge, and the pricing engine.

**Then (2 quarters):** Phase C — *go global & get certified.* Multi-currency depth, pluggable tax/
e-invoicing, real i18n, SOC 2 / ISO 27001 / PCI scope, entity-level policies finalized.

**Throughout:** Phase D — *the differentiator.* Agentic write-ops + RAG on top of trustworthy books
and DB-enforced isolation; deepen MRP/HR/portals where the target market demands.

> **The bet (one line):** The hard parts — DB-enforced isolation, double-entry GL with maker-checker,
> real payments, Thai fiscal compliance, and a SOX controls framework — are **already built and
> tested**. The next dollar should buy **operational trust (backups, deploy, secrets, observability)
> and floor-grade POS (offline-first, hardware, pricing)** — the unglamorous layer that turns a
> demo-perfect system into one a multi-site customer bets their business on — *then* layer the
> agentic-write moat that incumbents can't quickly copy.

---

## 7. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 DRAFT | 2026-06-23 | Platform / Controller | Initial next-upgrade roadmap; benchmarks as-built system vs global POS/ERP; supersedes the "missing GL/payments/RLS" premise of `09-worldclass-roadmap.md` and `pos-worldclass-roadmap.md`, which are now substantially delivered. |
| 0.2 | 2026-06-23 | Platform | **Phase A delivered** (production hardening): Docker/compose, scripted restore + automated restore-drill, fail-closed secret validation, `/healthz`+`/readyz`, observability/incident + change-management + secrets + deployment runbooks, CODEOWNERS + PR template + approval-gated deploy + branch-protection ruleset, prod DB least-privilege SQL. Marked `[setup]` items (console actions) + deferred httpOnly-cookie workstream. |
| 0.3 | 2026-06-23 | Platform | **Phase B in progress**: B4 pricing rules now apply at dine-in checkout (+ service charge acct 4400, satang rounding acct 4900, `pricing` harness); B2 cashier quick-tender + hotkeys; B1 offline client outbox + B3 peripheral bridge scaffolds (backend offline-sync already existed). Verified pieces CI-gated; browser/hardware pieces are typecheck-only scaffolds. |
