# Change Management & SDLC Policy

**Policy ID:** ELC-POL-08 · **Owner:** `<<Head of Engineering>>` · **Approved by:** `<<CTO>>`
**Version:** 1.0 · **Effective:** `<<date>>` · **Last reviewed:** 2026-06-30 · **Cadence:** Annual
**Related RCM controls:** ITGC-CM-01..05, ITGC-SD-01..03

> v1.0 — control gates wired (branch protection + required review + deploy-approval + CI/coverage gates).
> Placeholders `<<…>>` (owners/dates/tracker) are for the entity to finalize at adoption.

## 1. Purpose
Ensure changes to the ERP are authorized, reviewed, tested, and traceable from request to production — so no unauthorized or untested change reaches financial systems.

## 2. SDLC stages & control gates
1. **Request:** every change ties to a tracked ticket (`<<issue tracker>>`) with a business/technical rationale (CM-04 — require ticket ID in each PR).
2. **Design:** significant/financially-relevant changes get a brief design + reviewer sign-off (SD-01).
3. **Build:** developed on a branch; no direct commits to `main` (branch protection — CM-01).
4. **Review:** ≥1 independent reviewer approval; **author may not self-merge** (CM-01).
5. **Test:** CI must pass — build, typecheck, unit tests, the **ratchet coverage gate** (coverage on the curated set can't regress below the locked floor), and the integration/control harnesses (incl. `compliance`, `pg-core`) are **gates** (SD-03). Key-control regression evidence is the archived CI run.
6. **UAT sign-off:** for a financially-relevant change, the affected UAT cases in `docs/uat/` (positive + negative/control, with exact expected results/error codes) are executed and **signed off** by the business owner before go-live (SD-01). The traceability matrix ties cases → controls.
7. **Approve to deploy (go-live sign-off):** deployment to production is approved by someone **other than the author** via the GitHub Environment deploy-approval gate (deployer ≠ author) — this approval IS the go-live sign-off and is retained as evidence (CM-03).
8. **Release & traceability:** retain the ticket → PR → CI run → UAT sign-off → deploy-approval linkage (CM-04). Documentation (process narrative / user manual / UAT) is updated in the same change per the repo doc-sync policy.

## 3. Database changes
Schema changes ship only as reviewed migrations (`apps/api/drizzle/*` + journal); **no direct production DDL** (CM-02).

## 4. Emergency changes
Expedited fixes follow the emergency procedure: `<<who can authorize>>`, deploy, then **retroactive review/approval within `<<24–48h>>`** and ticketing; logged and reviewed by `<<Head of Eng>>` (CM-05).

## 5. Environment & data separation
Development/test use non-production data; production secrets never used outside production.

## 6. Evidence
Branch-protection settings, sample PRs (reviewer + ticket ID), CI run logs (incl. coverage gate), **UAT
sign-off records** (`docs/uat/` + traceability matrix), deploy-approval records (deployer ≠ author),
migration history, emergency-change log.

## Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-06-22 | `<<author>>` | Initial draft |
| 1.0 | 2026-06-30 | Platform / Eng | Finalized SDLC stages with explicit **UAT sign-off** (docs/uat) + **go-live sign-off** (deploy-approval gate, deployer ≠ author) and the ratchet coverage gate; closes ITGC-SD-01. Control gates are wired in CI + GitHub Environment. |
