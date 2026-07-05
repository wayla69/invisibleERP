# Trust & Security — Invisible ERP V2

**Audience:** customers, prospects, and their IT/security reviewers (a customer-facing summary).
**Status:** published summary · reconciled to code and to the internal control library on the date below.
**Source of truth:** the controls referenced here are implemented in the codebase and re-tested automatically
on every CI run; the internal evidence lives in `compliance/` (RCM, policies, readiness) and
`docs/security/2026-06-28-security-and-load-test-report.md`.

> **Read this first — our honesty position.** We do **not** claim to be "audit-certified" today. What is
> true, and independently verifiable, is that the security and reliability controls below are **built into
> the product and automatically re-tested on every code change**, and that the system has been through an
> independent penetration test and load test. External attestation (SOC 2 Type I) is an active, scheduled
> roadmap item — see §7. We would rather tell you exactly where we are than overclaim; that discipline is
> itself part of how the platform is run.

---

## Why this document exists

Some customers ask, reasonably: *"Is my data safe on a platform built by a domain company rather than a
big-name tech vendor?"* The honest answer is that security and reliability here are not marketing — they are
engineered controls, database-enforced, and continuously tested. This page lets you (and your IT reviewer)
verify that for yourself. Every claim below maps to a real control with an internal control ID.

---

## 1. Your data is isolated from every other customer

- **Database-enforced multi-tenant isolation (Row-Level Security).** Separation between customers is enforced
  by PostgreSQL itself, not just by application code. Every table carrying tenant data has `FORCE ROW LEVEL
  SECURITY` and a `tenant_isolation` policy; each request runs under a restricted `app_user` role scoped to
  your tenant. Application bugs cannot silently cross that boundary.
- **Fails closed.** If the per-request tenant scoping cannot be established, the request is **refused**
  (`503 RLS_UNAVAILABLE`) rather than served with the wrong scope. The safe default is "deny," never "leak."
- **Independently verified.** Our 2026-06-28 penetration test attempted cross-tenant reads and writes against
  a live instance and confirmed they are blocked. The report calls tenant isolation *"the strongest part of
  the system."*

## 2. Access is controlled, and privileged access is protected

- **Multi-factor authentication (MFA/TOTP)** is **required** for privileged, finance, and access-admin roles
  (not merely optional).
- **Passwords** are hashed with **scrypt** (hardened parameters), compared in constant time, and transparently
  re-hashed on login as parameters strengthen. We never store passwords in a reversible form.
- **Sessions are revocable.** Access tokens carry a unique ID (`jti`) with a denylist and a per-user
  "valid-from" watermark, so an administrator can invalidate a user's sessions immediately — a permission
  change takes effect at once, not at token expiry.
- **Refresh tokens rotate** and are single-use with theft detection: if a stolen token is replayed, the whole
  token family is revoked.
- **Role-based access control** with ~60 fine-grained permissions and per-user overrides; the live database
  role is trusted over anything in the token, so a downgraded or forged role loses privilege immediately.
- **Segregation of Duties (SoD).** 16 codified conflict rules block one person from holding both sides of a
  sensitive duty (e.g. creating *and* approving a payment) unless an administrator explicitly overrides with a
  logged reason. Enterprise SSO (OIDC with PKCE + `state`/nonce validation) and SCIM provisioning are supported.

## 3. Data is encrypted and inputs are defended

- **Encryption at rest:** sensitive fields (national/tax IDs, bank accounts, MFA seeds, integration secrets)
  are encrypted with **AES-256-GCM**; the service **fails closed** in production if the encryption key is
  absent. **In transit:** TLS everywhere.
- **Application hardening:** strict security headers (helmet, locked-down Content-Security-Policy),
  an explicit CORS allow-list (no wildcards), CSRF double-submit protection on cookie-authenticated mutations,
  segmented rate limiting (global / auth / OTP), and schema validation (Zod) on inputs.
- **SQL-injection resistant by construction:** all database access uses a parameterized query builder
  (Drizzle ORM); raw SQL is swept for unsafe interpolation as part of our vulnerability triage.

## 4. Everything is auditable and tamper-evident

- **Append-only, hash-chained audit log:** every data mutation writes an immutable audit row, and each row is
  **SHA-256 hash-chained** to the one before it, so any tampering with history is detectable. A database-level
  trigger blocks updates/deletes on the audit log and on posted accounting entries.
- **Maker-checker controls:** manual journal entries post as *Draft* and are excluded from balances until a
  **different** user approves them; the same maker-checker discipline covers payroll and three-way
  purchase-order/receipt/invoice matching.

## 5. Security is enforced in our build pipeline, not just at review time

Every code change must pass automated gates before it can ship:

- **Static analysis (SAST):** CodeQL scans on every change.
- **Dependency scanning:** `pnpm audit` runs as a **hard gate**; any accepted advisory is documented with an
  exploitability assessment in our vulnerability-triage register.
- **Secret scanning:** gitleaks scans the full history to prevent committed credentials.
- **License compliance:** a gate blocks disallowed licenses in production dependencies.
- **Independent testing:** a white-box audit + live penetration test + load test was performed (2026-06-28).
  The top-severity findings from that report — SSO callback hardening, per-account login lockout, and an
  admin-grant privilege-escalation path — have since been **remediated in code** (verifiable in the auth,
  identity, and admin-users modules).

## 6. Reliability is engineered and measured

- **We are the tech company for this product.** The platform is a continuously integrated codebase with a
  large automated test suite: typecheck, build, unit tests, and a matrix of ~100 integration harnesses that
  boot the real application against a real database on every change — including tenant-isolation,
  maker-checker, SoD, and control-effectiveness gates.
- **Load-tested:** scaled to **200 concurrent sessions with zero errors**; under saturation the system
  **degrades gracefully** (it queues, it does not crash). Multi-process horizontal scaling is supported.
- **Backups & disaster recovery:** hourly backups with restore verification and offsite copies
  (**RPO ≈ 1 hour, RTO < 30 minutes**), plus periodic DR "game-day" exercises.
- **Observability:** structured logging, OpenTelemetry tracing, Sentry error monitoring, and health/readiness
  endpoints.
- **Change discipline:** hundreds of forward-only, journaled database migrations under an integrity gate; a
  documented change-management/SDLC policy governs releases.

## 7. Compliance & external attestation

- **SOX/ICFR control library:** a **184-control** Risk & Control Matrix (181 implemented), each key control
  re-performed by an automated Test-of-Effectiveness harness on every CI run. This is the ITGC/financial-
  controls backbone auditors care about.
- **Policy suite:** 13 adopted policies (information security, access control, SoD, change management,
  incident response, backup/DR/BCP, fraud risk, vendor management, and more).
- **Data protection:** Thai **PDPA** support with a 30-day DSAR workflow; optional AI features redact personal
  contact data before any model call and customer data is **not** used to train models.
- **On the roadmap (in progress, not yet certified):** **SOC 2 Type I** (Security criteria) is the first
  external attestation target, with **ISO 27001** and **PCI-DSS** gap analyses already drafted. We will share
  the report and letter of engagement with customers under NDA as they become available.

---

## What to ask us for

Depending on your review needs, we can provide (some under NDA):

- The penetration-test & load-test report summary.
- The security policy suite and the SOX/ICFR control matrix.
- A completed vendor-security questionnaire (SIG-lite / CAIQ-style).
- A Data Processing Agreement (DPA) and sub-processor list (see the Privacy Policy).
- SOC 2 status and target dates.

**Contact:** security@ — (route to the security/compliance owner).

---

## Revision history

| Date | Version | Change | Author |
|------|---------|--------|--------|
| 2026-07-05 | 1.0 | Initial customer-facing trust summary. Reconciled to the control library, the 2026-06-28 pen-test/load-test report, and current auth/identity/admin-users code (top pen-test findings confirmed remediated). | Security/Compliance |
