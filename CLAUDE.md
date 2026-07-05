# CLAUDE.md — working agreement for this repository

Invisible ERP V2 — NestJS (Fastify) API + Next.js web, Drizzle ORM, PostgreSQL (multi-tenant, RLS),
Thai-localized. This is a SOX/ICFR-and-ISO-documented codebase preparing for a NASDAQ listing, so the
documentation is a first-class deliverable, not an afterthought.

## 📌 Documentation-sync policy (MANDATORY)

**Whenever you change the application, you MUST update the documentation in the same change so it stays in
line with the code.** "A change in the app" includes (non-exhaustive): new/changed/removed API endpoints,
permissions/roles/SoD rules, business-cycle logic, GL postings, validation/error codes, workflows/approvals,
controls, screens/routes/navigation, or any user-facing behavior.

For every such change, review and update as needed:

1. **Process narratives + workflows** — `docs/process-narratives/` (ISO-style, per cycle). Update the
   affected cycle's narrative, Mermaid workflow, control matrix (and RCM/SoD control IDs), and revision
   history. If a control changes, also reflect it in `compliance/` (RCM `build_rcm.py` → regenerate the
   xlsx; readiness plan; policies) and the control-test harness `tools/cutover/src/compliance.ts`.
2. **User manual** — `docs/user-manual/`. Update the affected module guide (route, required
   role/permission, steps, control callouts) and the troubleshooting/FAQ for any new error codes.
3. **UAT documents** — `docs/uat/`. Add/adjust the relevant test cases (positive + negative/control),
   keep the traceability matrix in sync, and mirror exact expected results/error codes.

### How to apply it
- Treat docs as part of "done": a code change is not complete until these docs reflect it.
- Keep changes proportionate — touch the sections actually affected; don't rewrite unrelated docs.
- Note the change in the affected document's revision-history table and bump the date.
- If a change genuinely has no doc impact, say so explicitly in your summary rather than skipping silently.
- Prefer one commit (or a tightly-coupled series) that contains both the code and the doc updates.

## 🐞 Debug mantra (follow in order)

1. **Reproduce first.** Get a deterministic failing signal before changing anything. Read the actual
   error/log — don't guess.
2. **Is it even mine?** Before assuming your change broke it, check whether the failure **pre-exists on
   `main`** or is **environmental**. Verify on a clean baseline (`git worktree add /tmp/wt origin/main`)
   and use `git log -S"<string>"` / `git log -p <file>` to find *when/why* behaviour changed.
3. **Root cause, not symptom.** Keep digging until you can *explain* the failure (instrument it — print
   the real value, e.g. a series length or a computed date — rather than theorise). Do **not** paper over
   it by loosening assertions or rewriting expected values to match buggy output.
4. **Fix at the right layer, smallest change.** Don't mask: never edit parity-locked code
   (`forecasting.service.ts` says `ห้ามเปลี่ยน — parity`), and prefer fixing the test seeding/harness over
   bending the product. If a "fix" causes new regressions, **revert** and record why (see the drizzle 0.45
   note below) rather than forcing it.
5. **Verify the fix.** Re-run the *exact* failing check to green, then run the broader suite for
   regressions (harnesses + typecheck + build). State results honestly, with the output.
6. **Leave it greener.** If you find a pre-existing failure, fix it or clearly flag it to the user; never
   silently step over a red gate. Reconcile docs per the policy above.
7. **For a CI gate, get the real finding before you touch code — and don't trust a stale check.** Read the
   gate's actual output (e.g. `get_check_run` for the `CodeQL` results gate gives the alert count/severity)
   and **enumerate the diff for the exact sink** rather than guessing at the cause; a wrong guess costs a
   full ~5-min CI cycle. Also check **timing**: the `CodeQL` results gate concludes a few seconds *before*
   the `codeql` analysis job finishes, so a red gate often reflects the **previous** commit's SARIF — a
   freshly-pushed fix can show red purely because the gate is one analysis behind (see gotcha below).

## ⚠️ Known constraints & gotchas (this environment / codebase)

- **Business timezone = Asia/Bangkok (UTC+7).** `ymd()`/`bizYmdDash` date everything on the business day,
  not UTC. Seed/compare dates on that basis or you get off-by-one window drift (root cause of the
  `analytics` flake).
- **GL-05:** a manual JE via `POST /api/ledger/journal` posts as **Draft** and is excluded from balances
  until a *different* user approves it; `closeYear`/aggregations scope to the caller's tenant (HQ/Admin
  ⇒ pass an explicit `tenant_id`). These bit the `worldclass` year-end harness when its setup went stale.
- **Tenancy / `TENANCY_MODE` (AC-18):** self-service `POST /api/auth/signup` mints a **new tenant + an
  `Admin`** per signup, and the **default `single-company`** mode gives every Admin a **global RLS bypass**
  (sees ALL tenants) — so any deploy where outsiders can sign up MUST set **`TENANCY_MODE=multi-company` on
  every API service on that DB**. Per-company isolation (`org_id=NULL` ⇒ own tenant only) then holds; branches
  are **intra-tenant** (`branches.tenant_id`) so a company is one tenant (no `org_id` backfill needed unless
  several separate accounts must share). Gotcha (**fixed in 0232, keep it that way**): cross-account org
  `sharing` (an org-scoped Admin seeing a SIBLING tenant's DATA rows in its own org) **works** — but it broke
  once and can silently regress. `0196` added the per-table org clause via a `DO $$…EXECUTE…$$` loop; `0218`'s
  index-backfill then re-ran the generic RLS loop and recreated `tenant_isolation` with the PLAIN body,
  silently dropping the org clause on **every data table** (`pg-core` saw `org1=1`, fail-**closed**, no leak);
  `0232` re-applies it. **The org-clause body is CANONICAL** — any new tenant table's hand-appended RLS loop,
  or any migration that DROP/CREATEs `tenant_isolation`, MUST copy `0232`'s form (not the plain
  `0081`/`0121`/`0002` one), or the bug returns. The `tenants` self-policy is set by *direct* DDL (not the
  loop; `tenants` has no `tenant_id` column) so tenants-level org isolation + `pg-smoke` can look green while
  data-table sharing is broken — `pg-core` now **hard-asserts** data-table sharing (`org1===2`). **NB PGlite
  DOES execute the `DO`-loop** (verified 0.2.17) — a DO-loop migration needs no parallel statement list. Full
  model: `docs/ops/tenancy-model.md`.
- **drizzle-orm is on `^0.45.2`** (bumped from 0.36.4 in W4, 2026-06-30 — the SQLi advisory is remediated).
  **0.45 wraps every driver error in a `DrizzleQueryError` with the original pg/PGlite error (SQLSTATE
  `code`/`constraint`/`detail`) nested under `.cause`** — so never read `e.code`/`e.constraint` directly on a
  caught DB error; use the `common/db-error.ts` helpers (`pgError`/`pgErrorCode`/`isUniqueViolation`) which
  walk the `.cause` chain. This was the root cause of the old "0.45 regresses an insert path" (the 23505
  retry/dedup sites + the global exception filter all silently stopped matching). See
  `compliance/vulnerability-triage.md`.
- **Migration numbering — use the NEXT FREE 4-digit number.** Migrations are hand-written or drafted with
  `db:generate` and hand-journaled in `apps/api/drizzle/` (the snapshot baseline was resynced in
  `0129_baseline_resync`, so `db:generate` again emits a minimal diff — but still hand-append the RLS loop
  for new tenant tables). When two PRs are open at once they often both grab the same next number (e.g.
  `0119_*`) → on merge the
  `meta/_journal.json` lines conflict and one `.sql` silently wins. The `migrations-journaled` CI gate now
  **fails on duplicate migration numbers** (and duplicate journal tag/idx); when you merge `main` and your
  number is taken, **renumber your `.sql` + journal entry to the next free id** and bump the comment header.
  A few pre-existing historical collisions (`0085/0088/0104/0105`) are grandfathered in the gate. Full
  context + the snapshot-resync remediation plan: `docs/ops/drizzle-migration-debt.md`.
- **Journal `when` must be strictly greater than the current max.** `drizzle-kit migrate` only applies
  entries with `when` **>** the last applied timestamp, so a non-monotonic `when` is **silently skipped in
  prod forever** while fresh-DB CI stays green (root cause of the 2026-07-03 deploy outage: 0145/0146 were
  never applied in prod, and 0218's index on the missing `tip_distribution_lines` failed every deploy). The
  `migrations-journaled` gate now fails on non-monotonic `when` (0145/0146 grandfathered — their objects are
  re-created idempotently inside 0218). See `docs/ops/drizzle-migration-debt.md` §3bis.
- **CI runner pnpm version comes from `package.json` `packageManager` (pnpm@11.8.0).** Do **not** also pin
  `version:` in `pnpm/action-setup` — the two conflict (`ERR_PNPM_BAD_PM_VERSION`) and break every job.
- **The `build` gate ends with two down-only RATCHETS that fail on *new* debt (not just real errors)** — a
  clean `tsc`/`next build` locally is **not** enough. (1) `tools/ci/check-ts-debt.mjs`: a new `as any` over
  `ts-debt-baseline.json.asAny`, **or** any `tsc --noUncheckedIndexedAccess` error over `.strictIndexErrors`,
  fails. Never add `as any` — use a precise cast (`x as unknown as Parameters<typeof fn>[0]` for cross-pkg
  Buffer/type friction) or narrow the type. NB the strict-index pass reruns the *whole* `tsc` with the flag,
  so an **ordinary** type error (e.g. a bad cast) also counts as a strict-index regression — one bad line can
  trip **both** counters. (2) `tools/ci/check-use-client.mjs`: a new `'use client'` file over
  `use-client-baseline.json` fails. A shared **client island imported only by already-`'use client'` pages
  must OMIT its own directive** (it inherits the boundary — pattern: `apps/web/src/components/state-view.tsx`);
  adding the directive needlessly is what trips it. Run both scripts locally before pushing. Also: **PR CI runs
  on the branch⋈main *merge* commit**, so a ratchet reads against *current* `main`'s baseline — your local
  count can be off by the files `main` added since you branched (relative pass/fail still holds).
- **Bulk master-data import/export is registry-driven; extend it, don't rebuild.** `modules/masterdata`
  (`master-registry.ts` + `masterdata.service.ts`) drives export/template/validate/import for all entities and
  accepts **csv / rows / base64 `xlsx`** (`rowsFromInput` → `parseXlsx`/`parseCsv`). Setup screens surface the
  two item-posting lists (`item_categories`, `tax_codes`) via `/api/item-setup/io/*` — the **same** engine,
  gated to the setup duties (`md_item`/`md_config`/`masterdata`/`exec`) and allow-listed to those keys so a
  narrow role gets the bulk surface without the coarse `masterdata` duty (SoD R13). Shared web island
  `components/master-io.tsx`. Coverage: `ext` harness. Narrative PN-17 §7.3b/3c.
- **Sandbox networking:** direct `git push` to `main` is blocked (use the PR flow — open + merge via the
  GitHub MCP), `api.github.com` returns **403** from the shell (poll CI via the GitHub MCP, not curl),
  Playwright's Chromium download (`cdn.playwright.dev`) is blocked (runs in CI), branch **deletion** is
  blocked (403), and the commit-signing server is occasionally flaky (retry the commit).
- **CodeQL `CodeQL` results gate races / is one commit behind.** The capital-`CodeQL` PR check (distinct
  from the lowercase `codeql` analysis *job*) concludes ~5–8s **before** that run's analysis finishes
  uploading, so on a fresh push it reports the **prior** commit's alerts — a pushed fix can read red even
  when its own analysis is clean. Confirm via `get_check_run` (the `output.summary` carries the count, e.g.
  "2 high"; `output.text`/annotations are **not** exposed via MCP, nor is a code-scanning-alerts list tool,
  and no SARIF artifact is uploaded). Diagnose by **enumerating the diff** for the flagged sink, not by
  re-reading the gate. The merge is **not** hard-blocked by this gate, so a verified-clean fix can be
  merged even while the gate still displays its stale red (the post-merge `main` analysis is the
  authoritative confirmation).
- **`js/sensitive-get-query` (CWE-598) fires on CLIENT code too.** It flags reading a sensitive-named
  param (`token`, `id_token`, `code`, `secret`, …) from the URL — including `new URLSearchParams(
  window.location.search).get('id_token')` in a web page, not just server `req.query`/Nest `@Query`. Fix
  by **not naming** the sensitive param at the read site: forward the raw query string opaquely and parse
  it server-side from the POST **body** (the body is not a GET-query source). This bit the SSO `/sso/callback`
  page (the IdP redirect carries `code`/`id_token` in the URL).
- **`js/sql-injection` false-positives on Drizzle `sql` templates.** CodeQL flags a `@Query()`-derived
  value interpolated into a `sql\`${col} >= ${param}\`` template even though Drizzle **binds** `${param}`.
  Use the typed builders (`gte`/`lte`/`eq`/`and`) instead of a raw `sql` template at user-input sites —
  same parameterized SQL, no sink. (Bit `cashFlowDirect`'s date filter.)
- **Drizzle migrations MUST be journaled.** Every new `apps/api/drizzle/NNNN_*.sql` needs a matching entry
  appended to `apps/api/drizzle/meta/_journal.json` (sequential `idx`, ascending `when`), or the CI
  `migrations-journaled` gate fails and prod `drizzle-kit migrate` skips it. Verify no duplicate `idx`.
  Sequence is at `0121` / idx 126 as of the gap-pack work.
- **The RCM xlsx is a generated binary — never hand-merge it.** `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx`
  conflicts on essentially every merge. Edit `build_rcm.py`, take **ours** on the `.xlsx` (or `--theirs`,
  doesn't matter), then **regenerate**: `python3 compliance/build_rcm.py` (run from repo root) and stage
  the result. Currently **169 controls**.
- **Stacked PRs + squash-merge conflicts.** When a feature PR is stacked on another and the base
  squash-merges to `main`, the dependent PR goes `dirty` because main now holds the same content under a
  *different* commit SHA. Resolve by merging `origin/main` and taking **ours** (the stacked branch already
  contains the base's content as a superset) for every conflict, then regenerate the RCM xlsx. Retarget the
  PR base to `main` only after the base PR merges.
- **Authoring `basics` harness GL assertions:** trial-balance rows expose `debit`, `credit`, *and* `balance`
  (= debit − credit). Use `balance` for net-position checks (e.g. a control account that gets both a debit
  and a later credit) — reading the gross `debit` column alone misses the offsetting credit. Service errors
  surface as `json.error.code` (the `AllExceptionsFilter` wraps the body in `{ error: {...} }`), not
  `json.code`.

## Build / verify quick reference
- API: `pnpm --filter @ierp/api build` · Web: `pnpm --filter @ierp/web build` · Typecheck: `pnpm -r typecheck`
- Shared: `pnpm --filter @ierp/shared build` (build before harnesses that import dist)
- Web E2E (Playwright UI smoke, e.g. ERP/POS switcher, sidebar favourites/collapsible Settings):
  `pnpm --filter @ierp/web test:e2e` (one-time `playwright install chromium`; needs browser-download in CI).
  To run e2e **locally in this env**: the project's pinned headless-shell isn't present, but a full Chromium
  is at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` — run with a throwaway config that extends
  `playwright.config` and sets `use.launchOptions.executablePath` to it (+ `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`).
  `*.capture.spec.ts` (screenshot tools, e.g. `e2e/sidebar.capture.spec.ts`) are excluded from CI via
  `testIgnore`; run them by clearing `testIgnore` in that local config.
- Control/Integration harnesses (CI gates, run with `NODE_OPTIONS=--experimental-sqlite`):
  `pnpm --filter @ierp/cutover compliance` (ICFR controls), `basics` (the finance/GL/EAM smoke — **the
  primary gate for AR/AP, GL, fixed-assets/EAM, leases, cash-flow, collections work; extend it for any such
  change**), `e2e`, `ext`, `worldclass`, `taxdocs`, `restaurant`; `pnpm --filter @ierp/parity writeflow|analytics`. Keep these green.

## Key references
- RCM / readiness / policies: `compliance/` (`Oshinei_ERP_SOX_RCM_v1.xlsx`, `build_rcm.py`,
  `COSO_ICFR_Audit_Readiness_Plan.md`, `policies/`, `vulnerability-triage.md`).
- Permissions / roles / SoD rules: `packages/shared/src/permissions.ts`. Web nav/workspaces: `apps/web/src/lib/nav.ts`
  (groups support collapsible `subgroups`; the sidebar `AppShell` renders ERP/POS switcher + favourites/recents).
- Per-user UI prefs (sidebar favourites + nav fold-state) sync across devices via `GET/PUT /api/user-prefs`
  (`UserPrefsModule`, table `user_prefs`, RLS + owner-scoped, no `@Permissions`); recents stay per-device
  (localStorage). See `docs/15-ui-ux-menu-restructure-plan.md`.
- **Project Management (PPM) — `docs/19-project-management-ppm-plan.md` (DELIVERED).** Operational PPM on the
  `modules/projects` + `modules/crm-pipeline` spine: opportunity win/loss → project conversion (CRM-WL),
  WBS/tasks/milestones, resourcing & rate cards (PROJ-05), timesheet→labor maker-checker (PROJ-04),
  dependencies & EVM (PROJ-06), the sleek web workspace (`/projects`, `/projects/[code]` Gantt/EVM,
  `/projects/pipeline`), and BI report types `project_evm`/`crm_win_loss`. Narrative PN-16; harness
  `tools/cutover/src/projects.ts` (44 checks).
- **Project Management — next-level roadmap:** `docs/20-project-management-next-level-plan.md` (DELIVERED) —
  Portfolio command center, delivery depth (baselines/templates/RACI/risk-issue, controls PROJ-07/08),
  and a dedicated PM workspace IA. Phased, doc-synced PRs like docs/19.
- **PMO command center:** `docs/23-pmo-command-center-plan.md` (DELIVERED — PMO-1..5 shipped) — turn the PPM signals into
  a PMO operating loop: a single *what-needs-me-now* **action center** (`GET /api/projects/action-center`,
  proactive via the `BiLiveService` SSE bus; new detective control **PROJ-11**), a **pipeline-weighted
  forward** resource/cash forecast (`pipelineSummary` × `resourceCapacity` × milestone/POC billing), and a
  schedulable **period governance pack** (`project_governance_pack` BI report). Read-only aggregators on the
  existing spine — build on, don't duplicate. Three sequential doc-synced PRs.
- **Adjacent-ERP depth (Track D) — reconciled:** `docs/21-track-d-adjacent-erp-plan.md` (v0.2 RECONCILED) —
  an audit found Track D **already built + harness-tested**: MRP/RCCP/plan-to-PR (`modules/mfg-depth/mrp.service.ts`,
  `api/mrp`), QC disposition/scrap (`mfg-depth/quality.service.ts`, `api/quality`), shop-floor ops + routings,
  RFQ (`modules/sourcing`, `api/procurement/rfqs`), three-way AP-payment hold (`modules/match`,
  `api/procurement/match`), budget-vs-actual (`modules/budget` `budgetVsActual`), supplier scorecards. Only
  thin residual gaps remain → BI `exec_scorecard`/`budget_variance`/`supplier_scorecard` report types +
  optional close pre-lock validation (GL-19). **Do not rebuild the above — extend it.**
- **APS scheduling + streaming analytics:** `docs/22-aps-streaming-analytics-plan.md` (DELIVERED — APS + BiLive SSE shipped) —
  finite-capacity production scheduler (extends `mfg-depth` routings/RCCP; new `work_centers` master) +
  a live KPI SSE feed (reuses the `@Sse` `RealtimeService` bus; BI is poll-based today). Build on, don't duplicate.
- **Finance/GL feature map (controls + where the logic lives):**
  - GL maker-checker / recurring / prepaid: `modules/ledger/ledger.service.ts` — `postEntry` (Draft+approve, **GL-05**),
    `createRecurring`/`runDueRecurring` (**GL-08**), `createPrepaid`/`runDuePrepaid` (**GL-09**); cash flow
    `cashFlowStatement`/`cashFlowDirect`/`cashFlowForecast` (**GL-07**).
  - Cash flow account buckets live in the `CF_CLASSIFY` map + COA array at the top of `ledger.service.ts` —
    **add new balance-sheet accounts there** or the indirect SCF mis-buckets them.
  - Leases (IFRS 16, **LSE-01**): `modules/leases/` — `createLease` (ROU+liability at PV), `runDueLeases`
    (interest/payment/ROU-dep, off the running `rou_nbv`), `modifyLease` (remeasurement).
  - AR/AP statements (multi-currency), petty-cash advances (**EXP-07**): `modules/finance/finance.service.ts`
    (`customerStatement`/`vendorStatement`, `issueAdvance`/`settleAdvance`).
  - Asset revaluation/impairment + disposal recycling (**FA-07**): `modules/assets/assets.service.ts`
    (`revalue`, `dispose` recycles surplus 3200→3100). EAM work orders/PM/reliability (**FA-06**): `modules/eam/`.
  - Collections/dunning + credit-hold workflow (**REV-08/REV-12**): `modules/finance/collections.service.ts`.
  - Scheduled "action" jobs ride the BI report scheduler (`modules/bi/bi.service.ts` `REPORT_TYPES` +
    `generateReport`): `ar_collections_dunning`, `eam_pm_generate`, `gl_recurring_journals`,
    `gl_prepaid_amortize`, `lease_periodic_run` — each is idempotent and injected `@Optional()` to keep
    partial harnesses constructible.
