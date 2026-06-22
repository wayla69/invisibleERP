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

## Build / verify quick reference
- API: `pnpm --filter @ierp/api build` · Web: `pnpm --filter @ierp/web build` · Typecheck: `pnpm -r typecheck`
- Shared: `pnpm --filter @ierp/shared build` (build before harnesses that import dist)
- Control/Integration harnesses (CI gates, run with `NODE_OPTIONS=--experimental-sqlite`):
  `pnpm --filter @ierp/cutover compliance` (ICFR controls), `e2e`, `ext`, `worldclass`, `taxdocs`,
  `restaurant`; `pnpm --filter @ierp/parity writeflow|analytics`. Keep these green.

## Key references
- RCM / readiness / policies: `compliance/` (`Oshinei_ERP_SOX_RCM_v1.xlsx`, `build_rcm.py`,
  `COSO_ICFR_Audit_Readiness_Plan.md`, `policies/`, `vulnerability-triage.md`).
- Permissions / roles / SoD rules: `packages/shared/src/permissions.ts`. Web nav/workspaces: `apps/web/src/lib/nav.ts`.
