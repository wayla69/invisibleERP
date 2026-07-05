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
   **Definitive proof it's stale:** compare the capital `CodeQL` gate's `completed_at` against the lowercase
   `codeql` job's SARIF-upload time (`get_job_logs` → "Analysis upload status is complete" / "Successfully
   uploaded results"). If the gate concluded *before* this commit's SARIF finished uploading, it physically
   read the prior commit's results — do not chase it. And remember `js/sql-injection` needs a **taint
   source**: a `sum(${col} - ${col})` aggregate that interpolates only column refs (no `@Query` value) can't
   legitimately fire, so a persistent count that survives your fix means those weren't your sinks.
8. **A `dirty` PR silently starves CI — re-merge the *current* main.** When `main` advances under an open PR
   and conflicts, `mergeable_state` goes `dirty` and GitHub **stops scheduling the `pull_request` CI
   entirely** (it can't build the test-merge ref) — `get_check_runs` returns **0**, and the newest run in
   `list_workflow_runs` is stuck on the pre-conflict SHA. That looks identical to "CI is slow"; it isn't.
   Diagnose: `mergeable_state` recomputes lazily (the first `get` after a push returns the stale value and
   kicks a background recompute; `get` again to see fresh). Fix: **always re-fetch `origin/main` and check
   `git merge-base --is-ancestor origin/main HEAD`** — main may have advanced *again* since your last merge,
   so a branch that "should be clean" still conflicts. Merge the live tip, resolve, push; an empty commit
   only helps if the branch genuinely already contains main. `mergeable_state: unstable` (not `dirty`) means
   mergeable but a **non-required** check is red/pending — the stale `CodeQL` keeps it at `unstable` (never
   `clean`) yet does **not** block merge, so verify the *required* gates (`build`, `web-e2e`, harnesses)
   directly instead of waiting for `clean`.

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
  Use the typed builders (`gte`/`lte`/`eq`/`ne`/`and`) instead of a raw `sql` template at user-input sites —
  same parameterized SQL, no sink. (Bit `cashFlowDirect`'s date filter; and `fxExposure`'s `${col}::text <>
  'Paid'` → `ne(col, 'Paid')`.) But note the query needs a **taint source**: a `sql\`sum(${col} - ${col})\``
  aggregate that interpolates only column refs (no user input) is **not** a real sink and can't be rewritten
  with a typed builder anyway — leave it, and don't burn a CI cycle "fixing" a phantom alert on it.
- **Drizzle migrations MUST be journaled.** Every new `apps/api/drizzle/NNNN_*.sql` needs a matching entry
  appended to `apps/api/drizzle/meta/_journal.json` (sequential `idx`, ascending `when`), or the CI
  `migrations-journaled` gate fails and prod `drizzle-kit migrate` skips it. Verify no duplicate `idx`.
  Sequence is at `0121` / idx 126 as of the gap-pack work.
- **The RCM xlsx is a generated binary — never hand-merge it.** `compliance/Oshinei_ERP_SOX_RCM_v1.xlsx`
  conflicts on essentially every merge. Edit `build_rcm.py`, take **ours** on the `.xlsx` (or `--theirs`,
  doesn't matter), then **regenerate**: `python3 compliance/build_rcm.py` (run from repo root) and stage
  the result. Currently **187 controls**. **When `main` added controls too** (a concurrent PR bumped the
  count): `build_rcm.py` auto-merges cleanly (both control sets combine), so the merged total = base +
  main's Δ + yours (e.g. 183 + 1 + 3 = 187). Get the truth from `python3 compliance/build_rcm.py --counts`,
  then reconcile the `<!-- rcm-total -->`/`-implemented`/`-partial`/`-gap` markers in the conflicting census
  docs (`CONTROL_STATUS_HONEST.md`, `COSO_ICFR_Audit_Readiness_Plan.md`, `iso27001-gap-analysis.md`,
  `soc2-readiness.md`) to match — resolve to *ours* then `sed` the two differing numbers — and confirm with
  `node tools/ci/check-rcm-census.mjs` before regenerating the xlsx.
- **Adding/removing an RCM control also breaks the `check-rcm-census` gate — bump the tagged census spans.**
  That gate (a step *inside* the `migrations-journaled` CI job) re-derives the census from `build_rcm.py`
  and fails if any `<!-- rcm-total -->N<!-- /rcm-total -->` (also `rcm-implemented`/`rcm-partial`/`rcm-gap`)
  span across `compliance/**.md` + `docs/**.md` disagrees. After a new `add(...)` in `build_rcm.py`, run
  `node tools/ci/check-rcm-census.mjs`, then update the stale tagged numbers (the 2026-07 PROJ-15 add moved
  implemented 180→181 / total 183→184, and the finance-analytics ELC-07/GL-22/TR-01 adds then moved it to
  184→187) across `CONTROL_STATUS_HONEST.md`, `COSO_ICFR_Audit_Readiness_Plan.md`, `iso27001-gap-analysis.md`,
  `soc2-readiness.md`. `pnpm install openpyxl` may be needed to run `build_rcm.py`.
- **Stacked PRs + squash-merge conflicts.** When a feature PR is stacked on another and the base
  squash-merges to `main`, the dependent PR goes `dirty` because main now holds the same content under a
  *different* commit SHA. Resolve by merging `origin/main` and taking **ours** (the stacked branch already
  contains the base's content as a superset) for every conflict, then regenerate the RCM xlsx. Retarget the
  PR base to `main` only after the base PR merges.
- **`check-use-client` ratchet + the RSC-serialization trap.** `tools/ci/check-use-client.mjs` counts files
  whose first line is `'use client'` and may only go DOWN vs `tools/ci/use-client-baseline.json`; a new
  client-first page must be offset by converting an existing one (or a justified baseline bump, documented
  in the `_note`, matching the existing precedents). **Two hard constraints learned the hard way:** (1)
  there is **no server-side `t()`** — i18n is the client `useLang` context — so a display page that shows
  translated text **cannot** become a pure server component; the canonical pattern is a server-shell
  `page.tsx` (prefetch via `serverApi`) + a `'use client'` island (renders + `t()` + interactivity), and
  that island is **irreducible** (it does NOT lower the count). (2) A layout/page can only become a **server
  component** if every prop it passes to a client child is **serializable** — passing the icon-bearing
  `INTERNAL_NAV`/`PORTAL_NAV` (Lucide components are functions) across the RSC boundary **fails the web
  build**: `Functions cannot be passed directly to Client Components`. Fix pattern (how the app layouts were
  made server components): have the *client* child select the non-serializable data itself behind a
  serializable prop — `AppShell({ variant: 'internal'|'portal' })` imports the nav internally rather than
  receiving it. **Always `pnpm --filter @ierp/web build` before claiming a server-conversion works** — the
  serialization error only surfaces at build/prerender, not typecheck.
- **After merging `main`, rebuild `@ierp/shared` before trusting typecheck/ratchets.** If the merge brings
  in new shared exports (e.g. main's `qr.ts` adding `qrLink`/`stripTrailingSlashes`), code importing them
  fails with `TS2305: has no exported member` against the **stale dist** — which the `check-ts-debt` gate
  surfaces as phantom "new errors". Read the actual error (`TS2305` ≠ a `noUncheckedIndexedAccess` index
  error) before assuming new debt, and run `pnpm --filter @ierp/shared build` to resolve.
- **Authoring `basics` harness GL assertions:** trial-balance rows expose `debit`, `credit`, *and* `balance`
  (= debit − credit). Use `balance` for net-position checks (e.g. a control account that gets both a debit
  and a later credit) — reading the gross `debit` column alone misses the offsetting credit. Service errors
  surface as `json.error.code` (the `AllExceptionsFilter` wraps the body in `{ error: {...} }`), not
  `json.code`.
- **A `tenant_id` COLUMN makes a table "tenant-scoped" to the guards — name platform tables differently.** The
  `cutover/tenant-idx` gate (R1-1 / AUD-ARC-01) flags **any** table with a `tenant_id` column that lacks a
  leading `(tenant_id, …)` index, and the generic RLS loop forces RLS on it. A **platform-level** table (read
  only by gods via the `@PlatformAdmin` bypass — no per-tenant isolation) must therefore **not** call its
  company column `tenant_id`: use `about_tenant_id` / `created_tenant_id` (see `platform_notifications`,
  `signup_requests`) so both the guard and the RLS loop skip it. Grant `app_user` on the new table in the
  migration's `DO $$ … GRANT … $$` block (mirror `0234`/`0247`); no RLS clause needed.
- **Two web ratchets gate the `build` job (both may only go DOWN, but feature PRs routinely bump them by the
  count they add — that's the norm, see the baselines' own `_note`).** `tools/ci/check-use-client.mjs` counts
  files whose first statement is `'use client'` (`use-client-baseline.json`) — a genuinely-interactive new
  page adds one island; keep it flat by inlining into an existing `'use client'` file, else bump the baseline
  with a justification. `tools/ci/check-ts-debt.mjs` counts `as any` in **`apps/api/src/**/*.ts` only** (not
  `.tsx`, not web) (`ts-debt-baseline.json`) — type interceptor-set request fields on the `req` annotation
  instead of `(req as any)`. Run both locally before pushing; they run AFTER typecheck+build+coverage, so a
  green typecheck can still fail the `build` job on a ratchet.
- **A merged PR is finished — restart the branch, don't reuse it.** After your designated branch's PR
  squash-merges to `main`, follow-up work is a FRESH change: `git fetch origin main && git checkout -B <branch>
  origin/main`, build, then **`git push --force-with-lease`** (the remote branch still holds the now-merged
  pre-squash commits, so a fast-forward is impossible — force-with-lease is correct and safe here). The auto
  classifier blocks force-push + `commit --amend` until the user explicitly authorizes; if the stop-hook flags
  your tip as unverified, `git commit --amend --no-edit --reset-author` fixes the committer email
  (`noreply@anthropic.com`). Open a NEW PR for the follow-up. Repo merge convention: **squash**.

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
- **Platform Console / god (cross-company operations) — DELIVERED (PRs #418 + #420).** The platform owner
  ("god", `PLATFORM_ADMIN_USERNAMES`) runs the whole fleet from **`/platform`** (a god-only nav group in
  `apps/web/src/components/app-shell.tsx`, gated on `is_platform_owner` from `GET /api/auth/me`, injected
  AFTER the perm-filter so per-tenant Admins never see it). UI island: `apps/web/src/app/(internal)/platform/
  platform-client.tsx` — tabs **ภาพรวม** (SaaS KPIs + needs-attention + system-health + AI-spend), **บริษัท**
  (provision/suspend/act-as, bulk actions, tags), **Onboarding** (requests/invites), **แจ้งเตือน** (god event
  inbox), **กิจกรรม** (cross-company audit). Company **switcher + scope banner** live in `app-shell.tsx`.
  Backend: `@PlatformAdmin` routes in `modules/billing/billing.controller.ts` (`admin/tenants[/:id][/plan|/extend-trial|/tags|/suspend|/reactivate]`, `admin/ai-usage`), `modules/platform-notifications/` (god inbox).
  **God act-as** is header-driven in `common/tenant-tx.interceptor.ts`: `X-Act-As-Tenant` narrows god to one
  company (only for a god; a non-god's header is ignored); `X-Act-As-Read-Only: 1` rejects mutations
  (`403 READONLY_IMPERSONATION`). Web sends both from `apps/web/src/lib/api.ts`. Full model + revision
  history: `docs/ops/tenancy-model.md` §2bis–§2quinquies. ToE: `cutover/pg-core.ts` + `cutover/onboarding.ts`.
- **Project material control + shop-for-a-project (docs/32, PN-16):** the requester-facing shop for a project
  is a thin surface over the **PMR** spine — do NOT add budget logic to `createPr`. Flow: `/shop` project picker
  (or the *Shop for this project* button on `/projects/[code]`) → `/shop/project/[code]` browses ONLY the
  approved BoQ's material lines and checks out into `POST /api/pmr` (`modules/pmr`), so PROJ-12/PROJ-13 enforce
  it (within budget → PR/stock-issue; over budget → planner/exec maker-checker). The `pr_raise`-safe reads are
  `GET /api/pmr/projects` + `GET /api/pmr/project/:code/boq` (the projects/BoQ endpoints proper stay
  exec/planner/ar). An **off-budget** item can't be carted; it goes through **PROJ-15** — `POST /api/pmr/boq-request`
  (pr_raise, parks pending; `ITEM_ALREADY_BUDGETED`/`NO_APPROVED_BOQ` guards) → `…/boq-request/:reqNo/approve`
  (planner/exec, ≠ requester) appends a BoQ line + syncs the project budget (table `project_boq_change_requests`,
  migration 0249). ToE in `tools/cutover/src/projects.ts`. NB: **`items` has no `tenant_id`** (shared master) so
  new item columns need NO RLS loop (e.g. `items.barcode`, migration 0250, for `/shop` exact scan-to-add via
  `GET /api/procurement/catalog?barcode=`). `/shop` per-user favourites + basket templates sync via
  `GET/PUT /api/user-prefs` (`shop_favs`/`shop_templates`, merged by key), localStorage kept as offline cache.
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
