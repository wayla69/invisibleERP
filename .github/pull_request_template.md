<!-- ITGC-CM-04 — change traceability. Every change is reviewable, linked to a reason, and keeps
docs in lock-step with code (CLAUDE.md documentation-sync policy). -->

## What & why
<!-- Brief description of the change and the business/technical reason. -->

## Linked issue / ticket
<!-- e.g. Closes #123 — required so each merge traces back to an approved request. -->
Closes #

## Type
- [ ] Feature
- [ ] Fix
- [ ] Refactor / chore
- [ ] Infra / CI / ops
- [ ] Docs only

## Control & risk impact
- [ ] Touches GL/payments/permissions/SoD or another financial control (RCM)
- [ ] Touches authentication, RLS, secrets, or audit logging (ITGC-AC)
- [ ] Adds/changes a DB migration (`apps/api/drizzle/`)
- [ ] None of the above

## Documentation sync (per CLAUDE.md — MANDATORY when app behavior changes)
- [ ] Process narrative / workflow / control matrix updated (`docs/process-narratives/`)
- [ ] User manual updated (`docs/user-manual/`)
- [ ] UAT cases + traceability updated (`docs/uat/`)
- [ ] RCM / compliance artifacts updated (`compliance/`) if a control changed
- [ ] No doc impact (state why): …

## Verification
<!-- Paste the commands you ran and their result (typecheck/build/harnesses). -->
- [ ] `pnpm -r typecheck`
- [ ] `pnpm -r build`
- [ ] Relevant cutover/parity harness(es) green
