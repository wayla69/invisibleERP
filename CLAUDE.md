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
- **drizzle-orm is pinned at `^0.36.4`.** 0.45 fixes a non-exploitable SQLi advisory but **regresses an
  insert path** (see `compliance/vulnerability-triage.md`) — do not bump casually; it needs its own tested
  workstream.
- **CI runner pnpm version comes from `package.json` `packageManager` (pnpm@11.8.0).** Do **not** also pin
  `version:` in `pnpm/action-setup` — the two conflict (`ERR_PNPM_BAD_PM_VERSION`) and break every job.
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
- **Hand-written Drizzle migrations must be journaled, and numeric prefixes collide under parallel branches.**
  Every `apps/api/drizzle/NNNN_*.sql` needs a matching entry in `meta/_journal.json` or the
  `migrations-journaled` CI gate fails. Append `{idx, version:"7", when, tag:"NNNN_name", breakpoints:true}`
  and write the file with **CRLF** line endings (`JSON.stringify(j,null,2).replace(/\n/g,"\r\n")`). On a
  long-lived feature branch, `main` merges keep claiming your number (`0120`→`0121`→`0122`…): on each
  `git merge origin/main`, take **theirs** for `_journal.json`, then `git mv` your `.sql` to the next free
  number and re-append at the next `idx`. Verify with a quick node check that the journal tag-set and the
  `.sql` filename-set match exactly (no missing, no orphan) before committing. **Gotcha:** if you `git add`
  `_journal.json` during conflict resolution *before* re-appending your entry, the merge ships it unjournaled
  and CI fails — always re-add after the node append.
- **`js/sensitive-get-query` (CWE-598) fires on CLIENT code too.** It flags reading a sensitive-named
  param (`token`, `id_token`, `code`, `secret`, …) from the URL — including `new URLSearchParams(
  window.location.search).get('id_token')` in a web page, not just server `req.query`/Nest `@Query`. Fix
  by **not naming** the sensitive param at the read site: forward the raw query string opaquely and parse
  it server-side from the POST **body** (the body is not a GET-query source). This bit the SSO `/sso/callback`
  page (the IdP redirect carries `code`/`id_token` in the URL).

## Build / verify quick reference
- API: `pnpm --filter @ierp/api build` · Web: `pnpm --filter @ierp/web build` · Typecheck: `pnpm -r typecheck`
- Shared: `pnpm --filter @ierp/shared build` (build before harnesses that import dist)
- Web E2E (Playwright UI smoke, e.g. ERP/POS switcher): `pnpm --filter @ierp/web test:e2e`
  (one-time `pnpm --filter @ierp/web exec playwright install chromium`; needs browser-download network access)
- Control/Integration harnesses (CI gates, run with `NODE_OPTIONS=--experimental-sqlite`):
  `pnpm --filter @ierp/cutover compliance` (ICFR controls), `e2e`, `ext`, `worldclass`, `taxdocs`,
  `restaurant`, `production-plan`, `financial-health`, `line-automation`; `pnpm --filter @ierp/parity
  writeflow|analytics`. Keep these green.

## Key references
- RCM / readiness / policies: `compliance/` (`Oshinei_ERP_SOX_RCM_v1.xlsx`, `build_rcm.py`,
  `COSO_ICFR_Audit_Readiness_Plan.md`, `policies/`, `vulnerability-triage.md`).
- Permissions / roles / SoD rules: `packages/shared/src/permissions.ts`. Web nav/workspaces: `apps/web/src/lib/nav.ts`.
- POS growth features (PR #70): **demand-ML production forecast** — `ProductionPlanService` forecasts each
  dish via `demand-ml/DemandForecastService.planForecast(itemId, horizon)` (non-persisting; walk-forward
  backtest, auto-selects lowest-WAPE model; transparent **day-of-week fallback** when history < 14 days);
  the parity-locked `ForecastingService` (reorder points) is untouched. **Working-capital health score** —
  `GET /api/finance/health` (`FinancialHealthService`, 0–100 / A–E; read-only, no GL postings; complements
  the GL module's `/api/ledger/cash-flow-forecast`). **LINE marketing automation** — `/api/marketing/
  automation/{preview,campaigns,campaigns/:id,redeem}` (closed loop: trigger → coupon push → till redemption
  attributed to sale; tables `automation_campaigns` + `campaign_sends`, migration `0123_marketing_campaigns`).
  Web pages: `/production-plan`, `/financial-health`, `/campaigns`.
