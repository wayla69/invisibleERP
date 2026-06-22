# Information Security Policy

**Policy ID:** ELC-POL-06 · **Owner:** `<<CISO / Head of Engineering>>` · **Approved by:** `<<CEO>>`
**Version:** 0.1 (DRAFT) · **Effective:** `<<date>>` · **Last reviewed:** `<<date>>` · **Cadence:** Annual
**Related RCM controls:** ITGC-AC-* (access), AC-12 (secrets), AC-04 (encryption), AC-05 (API keys)

> DRAFT template — tailor to your hosting (Railway) and tooling; confirm data-protection obligations (PDPA) with counsel.

## 1. Purpose & scope
Protect the confidentiality, integrity, and availability of company and customer information across the Invisible ERP application, its data, and supporting infrastructure. Applies to all personnel and systems.

## 2. Policy statements
- **Encryption in transit:** all external traffic over TLS/HTTPS; HSTS enabled (Helmet).
- **Encryption at rest:** sensitive secrets (TOTP seeds, webhook secrets) encrypted with AES-256-GCM (`APP_ENC_KEY`); production fails closed if the key is unset.
- **Secrets management:** no secrets in source or logs; `JWT_SECRET`, `APP_ENC_KEY`, `DATABASE_URL`, PSP keys held in `<<KMS/vault>>` and **rotated** at least `<<annually>>` and on suspected compromise (AC-12 — currently remediating).
- **Authentication:** scrypt password hashing; MFA (TOTP) required for privileged/finance roles (AC-06).
- **Vulnerability management:** CI runs dependency advisories (`pnpm audit`), secret scanning (gitleaks), and SAST (CodeQL); high/critical findings are triaged within `<<SLA>>`. Annual penetration test by `<<firm>>`.
- **Logging & monitoring:** application errors to Sentry; tracing via OpenTelemetry; the append-only `audit_log` records financially-relevant mutations.
- **Data classification & retention:** classify data (public/internal/confidential/restricted); retain financial records `<<per statutory requirement>>`.
- **Endpoint & access hygiene:** least privilege; unique named accounts; no shared credentials.

## 3. Roles & responsibilities
- **CISO/Head of Eng:** owns the program, risk decisions, and exceptions.
- **DevOps:** infra hardening, secrets, monitoring, patching.
- **All personnel:** protect credentials, report incidents (ELC-POL-10).

## 4. Exceptions & enforcement
Exceptions require documented `<<CISO>>` approval with compensating controls and an expiry. Violations are subject to discipline.

## 5. Evidence
Vault config, rotation logs, CI security-scan results, pen-test report, Sentry/OTel configuration, encryption boot-gate proof.

## Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-06-22 | `<<author>>` | Initial draft |
