# Data Backup, Retention & Disaster Recovery / Business Continuity Policy

**Policy ID:** ELC-POL-09 · **Owner:** `<<DevOps / CTO>>` · **Approved by:** `<<CTO>>`
**Version:** 0.1 (DRAFT) · **Effective:** `<<date>>` · **Last reviewed:** `<<date>>` · **Cadence:** Annual + quarterly restore test
**Related RCM controls:** ITGC-OP-01 (backup/restore), ITGC-OP-02 (DR/BCP)

> DRAFT template — set RTO/RPO with the business; OP-01/02 are currently remediating.

## 1. Purpose
Ensure financial and operational data can be recovered after loss or outage, with proven, tested procedures.

## 2. Backup
- **Scope:** production PostgreSQL database (and `<<object storage / config>>`).
- **Method & frequency:** automated `<<daily full + continuous WAL / point-in-time>>` via `<<Railway managed backups / pg_dump pipeline>>`.
- **Retention:** `<<e.g., 35 days PITR + monthly archive for 1 year>>`, aligned to statutory record retention.
- **Encryption & access:** backups encrypted; restore restricted to authorized DevOps.

## 3. Restore testing (the control auditors test)
- Perform and **evidence a restore test at least quarterly**: restore to an isolated environment, verify integrity (row counts, a balanced trial balance), and record date, performer, result.

## 4. Disaster Recovery / Business Continuity
- **RTO:** `<<target hours>>` · **RPO:** `<<target minutes>>`.
- **DR plan:** documented steps to recover the app + database in `<<region/provider>>`; roles and contacts defined.
- **BCP:** alternate procedures for `<<critical business functions>>` during an outage.
- **Testing:** DR exercise at least `<<annually>>`; results and gaps logged.

## 5. Evidence
Backup schedule/config, retention settings, quarterly restore-test records, DR/BCP document, DR-test report.

## Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-06-22 | `<<author>>` | Initial draft |
