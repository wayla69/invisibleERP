# Data Retention & Deletion Policy

> **Status: DRAFT v0.1** — owner `<<DPO / Head of Engineering>>`. Retention periods marked `<<…>>` must be
> confirmed against Thai statutory requirements and customer contracts before this is treated as final.

Governs how long each class of data is kept, when it is deleted, and which data is under a **statutory legal
hold** (and therefore must **not** be auto-purged). Referenced by the customer [Terms of Service](../legal/terms-of-service.md)
and [DPA](../legal/data-processing-agreement.md).

## 1. Retention schedule

| Data class | Examples | Retention | Deletion mechanism |
|---|---|---|---|
| **Financial / accounting records** | GL entries, AR/AP, invoices, payments, tax docs | **`<<7 years>>`** (Thai accounting/tax statute) — **LEGAL HOLD, never auto-purged** | Manual, post-statute only, with sign-off |
| **Audit trail** | `audit_log` (append-only, hash-chained), `data_change_log` | **`<<7 years>>`** — **LEGAL HOLD, immutable, never auto-purged** | Manual archival post-statute only |
| **Operational transactional** | POS sales, inventory movements, orders | `<<per contract, typically 5–7 years>>` | Manual/archival; not auto-purged |
| **Member / customer PII** | `pos_members`, contacts, consents, `loyalty_receipt_submissions` (member-submitted receipt photos, LYL-17) | While the relationship is active; on PDPA **erasure** request → redacted + pseudonymised immediately | PDPA DSAR erasure workflow (`/api/pdpa/dsar`) |
| **Ephemeral security tokens** | `revoked_tokens`, `refresh_tokens`, `sso_login_state`, `member_otps` | Until expiry/consumption (minutes–days) | **Auto-purged** by the scheduled `data_retention_purge` job once dead |
| **Backups** | DB snapshots | **`<<90 days>>`** rolling | Automatic backup rotation |
| **AI token usage** | `ai_token_usage` (daily counters) | `<<13 months>>` (trend/billing) | Auto-purge candidate (future) |
| **Observability** | logs, traces, metrics | `<<30–90 days>>` per provider | Provider retention settings |

## 2. Statutory legal hold (must NOT be auto-deleted)
Financial/accounting records and the audit trail are retained for the full statutory period regardless of any
deletion request. A PDPA erasure request does **not** delete these; instead, personal identifiers within them
are **pseudonymised/masked at read time** while the underlying records (and the tamper-evident hash chain)
remain intact (see `docs/process-narratives/08-itgc.md`, PDPA-02). This reconciles PDPA erasure with the
accounting-retention obligation.

## 3. Automated purge (safe scope only)
The scheduled **`data_retention_purge`** job (BI scheduler; idempotent) deletes only **dead ephemeral security
rows**:
- `revoked_tokens` where `expires_at < now()` (the JWT is already expired → denylist entry is moot),
- `refresh_tokens` where `expires_at < now()` OR already `revoked_at`/`rotated_at` is set and expired,
- `sso_login_state` where `expires_at < now()`,
- `member_otps` that are consumed or where `expires_at < now()`.

It **never** touches financial, audit, transactional, or PII tables. Run it on a `daily` schedule.

## 4. Customer data on termination
On subscription termination the customer may export their data; the Provider returns or deletes customer data
within `<<60 days>>` except data under statutory hold; backups purge within `<<90 days>>`. See the
[DPA §8](../legal/data-processing-agreement.md).

## 5. Review
This policy is reviewed `<<annually>>` and on any change to statutory requirements or the data model.

---

### Revision history
| Version | Date | Author | Notes |
| --- | --- | --- | --- |
| 0.1 DRAFT | 2026-06-29 | Platform | Initial policy (panel/legal remediation): retention schedule by data class, statutory legal hold on financial + audit data (excluded from auto-purge, reconciled with PDPA erasure via read-time masking), and the safe automated `data_retention_purge` of dead ephemeral security tokens. Retention periods `<<…>>` pending statutory/contract confirmation. |
| 0.2 | 2026-07-01 | Platform | Added `loyalty_receipt_submissions` (member-submitted receipt photos, LYL-17) to the Member/customer PII row — same treatment as other member PII (kept while active; redacted on PDPA erasure via `/api/pdpa/dsar`). |
| 0.3 | 2026-07-02 | Platform | **Coalition cross-shop data minimisation (docs/27 W2, LYL-19):** partner-shop member resolution (`GET /api/coalition/resolve`) is coalition-scoped and returns code/name/tier/points/home-shop ONLY — contact data (phone/email/birthday) and consent records never cross the shop boundary, so no new PII data class or retention row is created; the phone used for lookup is the query input, not stored by the resolving shop. Coalition master data (`coalitions`/`coalition_members`) is configuration, not PII. |
