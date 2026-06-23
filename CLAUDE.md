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
2. **Is it even mine? Did it even run?** Before assuming your change broke it, check whether the failure
   **pre-exists on `main`** or is **environmental**. Verify on a clean baseline (`git worktree add /tmp/wt
   origin/main`) and use `git log -S"<string>"` / `git log -p <file>` to find *when/why* behaviour changed.
   Also confirm the check was **actually executing**: a "gated" job that silently never runs rots unnoticed
   (the harness matrix was dead for weeks because CI died upstream at `pnpm/action-setup` and skipped the
   whole job). Inspect the *run's jobs*, not just that a workflow file exists.
3. **Root cause, not symptom — don't guess the label.** Keep digging until you can *explain* the failure
   (instrument it — print the real value: a series length, a computed date, an HTTP `status`/response body —
   rather than theorise). A long-unrun test that fails is usually **stale against a shipped feature**, not a
   wall-clock/"date bomb" or flake: reproduce against the *real app* and read what it actually returns (e.g.
   a manual JE coming back `status: 'Draft'` ⇒ maker-checker; an SoD `403`; a count vs `MODULE_KEYS`) before
   blaming the clock or the environment. Never commit a *guessed* cause (a quarantine comment, a loosened
   assertion, or expected values rewritten to match buggy output).
4. **Fix at the right layer, smallest change.** Don't mask: never edit parity-locked code
   (`forecasting.service.ts` says `ห้ามเปลี่ยน — parity`), and prefer fixing the test seeding/harness over
   bending the product. If a "fix" causes new regressions, **revert** and record why (see the drizzle 0.45
   note below) rather than forcing it.
5. **Verify the fix.** Re-run the *exact* failing check to green, then run the broader suite for
   regressions (harnesses + typecheck + build). State results honestly, with the output.
6. **Leave it greener.** If you find a pre-existing failure, fix it or clearly flag it to the user; never
   silently step over a red gate. Reconcile docs per the policy above.

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

## Build / verify quick reference
- API: `pnpm --filter @ierp/api build` · Web: `pnpm --filter @ierp/web build` · Typecheck: `pnpm -r typecheck`
- Shared: `pnpm --filter @ierp/shared build` (build before harnesses that import dist)
- Web E2E (Playwright UI smoke, e.g. ERP/POS switcher): `pnpm --filter @ierp/web test:e2e`
  (one-time `pnpm --filter @ierp/web exec playwright install chromium`; needs browser-download network access)
- Control/Integration harnesses (CI gates, run with `NODE_OPTIONS=--experimental-sqlite`): **every**
  `tools/cutover/src/*.ts` + `tools/parity/{writeflow,analytics}` now runs as its own parallel job in the
  `harnesses` matrix in `.github/workflows/ci.yml` (one check per harness) — add a matrix entry whenever you
  add a harness. Run one locally with e.g. `pnpm --filter @ierp/cutover compliance` (ICFR controls), `e2e`,
  `worldclass`. Excluded (need external services, not self-contained on PGlite): `shadow`, `reconcile`,
  `smoke-http`. Keep these green.

## Key references
- RCM / readiness / policies: `compliance/` (`Oshinei_ERP_SOX_RCM_v1.xlsx`, `build_rcm.py`,
  `COSO_ICFR_Audit_Readiness_Plan.md`, `policies/`, `vulnerability-triage.md`).
- Permissions / roles / SoD rules: `packages/shared/src/permissions.ts`. Web nav/workspaces: `apps/web/src/lib/nav.ts`.
