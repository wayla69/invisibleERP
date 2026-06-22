# Change Management & SDLC Policy

**Policy ID:** ELC-POL-08 · **Owner:** `<<Head of Engineering>>` · **Approved by:** `<<CTO>>`
**Version:** 0.1 (DRAFT) · **Effective:** `<<date>>` · **Last reviewed:** `<<date>>` · **Cadence:** Annual
**Related RCM controls:** ITGC-CM-01..05, ITGC-SD-01..03

> DRAFT template — pair with branch-protection + deploy-approval configuration (CM gaps currently remediating).

## 1. Purpose
Ensure changes to the ERP are authorized, reviewed, tested, and traceable from request to production — so no unauthorized or untested change reaches financial systems.

## 2. SDLC stages & control gates
1. **Request:** every change ties to a tracked ticket (`<<issue tracker>>`) with a business/technical rationale (CM-04 — require ticket ID in each PR).
2. **Design:** significant/financially-relevant changes get a brief design + reviewer sign-off (SD-01).
3. **Build:** developed on a branch; no direct commits to `main` (branch protection — CM-01).
4. **Review:** ≥1 independent reviewer approval; **author may not self-merge** (CM-01).
5. **Test:** CI must pass — build, typecheck, unit tests, and the integration/control harnesses (incl. `compliance`) are **gates** (SD-03). Key-control regression evidence is archived.
6. **Approve to deploy:** deployment approved by someone **other than the author** (CM-03).
7. **Release & traceability:** retain the ticket → PR → CI run → deploy linkage (CM-04).

## 3. Database changes
Schema changes ship only as reviewed migrations (`apps/api/drizzle/*` + journal); **no direct production DDL** (CM-02).

## 4. Emergency changes
Expedited fixes follow the emergency procedure: `<<who can authorize>>`, deploy, then **retroactive review/approval within `<<24–48h>>`** and ticketing; logged and reviewed by `<<Head of Eng>>` (CM-05).

## 5. Environment & data separation
Development/test use non-production data; production secrets never used outside production.

## 6. Evidence
Branch-protection settings, sample PRs (reviewer + ticket ID), CI run logs, deploy-approval records (deployer ≠ author), migration history, emergency-change log.

## Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-06-22 | `<<author>>` | Initial draft |
