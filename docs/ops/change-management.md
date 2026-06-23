# Ops — Change Management (ITGC-CM-01 … CM-05)

> **Status:** v1.0 · **Date:** 2026-06-23 · **Owner:** Platform / Eng Lead
> Phase A deliverable of `docs/11-next-upgrade-realworld-roadmap.md`.

## 1. Branch protection (ITGC-CM-01/02)
`main` is protected. Apply the importable ruleset at
[`.github/rulesets/main-branch-protection.json`](../../.github/rulesets/main-branch-protection.json)
(Settings → Rules → Rulesets → Import, or `gh api … --input`). It enforces:
- PR required; **≥ 1 approving review**; **CODEOWNERS** review required
  ([`.github/CODEOWNERS`](../../.github/CODEOWNERS)); stale approvals dismissed on push.
- Required status checks (strict): `build`, `test-harnesses`, `security`, `codeql`, `web-e2e`.
- No force-push, no branch deletion, review threads must be resolved.

> No direct commits to `main`; schema changes only via reviewed migrations in `apps/api/drizzle/` —
> never hand-applied in prod.

## 2. Deploy approval — deployer ≠ author (ITGC-CM-03)
Production deploys run via [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml), pinned to
the GitHub **`production` Environment**. Configure that Environment with **Required reviewers** (people
other than the typical author) and store `RAILWAY_TOKEN` there. Result: a merge cannot ship until an
independent approver releases it.

**One-time setup:** Settings → Environments → `production` → add Required reviewers + add the
`RAILWAY_TOKEN` secret.

## 3. Traceability (ITGC-CM-04)
The PR template ([`.github/pull_request_template.md`](../../.github/pull_request_template.md)) requires a
linked issue/ticket, a control-impact checklist, and the **docs-sync checklist** (per CLAUDE.md). Every
production change therefore traces: ticket → PR (+ reviews) → merge → gated deploy run.

## 4. Emergency change (ITGC-CM-05)
When a SEV-1 needs an out-of-band fix:
1. Create an `hotfix/*` branch from `main`; make the minimal fix.
2. Get an **expedited review** from any second engineer (still no self-merge).
3. Merge; deploy via `deploy.yml` with an emergency approver.
4. **Within 1 business day:** open a retro ticket, backfill the normal PR description/tests, and record
   it in the change log (evidence for ITGC-CM-05). Emergency changes are the exception, logged and reviewed.

## 5. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-06-23 | Platform / Eng Lead | Initial change-management: branch protection, deploy gate, traceability, emergency procedure. |
