# Financial Close & Reporting Policy

**Policy ID:** ELC-POL-11 · **Owner:** `<<Controller>>` · **Approved by:** `<<CFO>>`
**Version:** 0.1 (DRAFT) · **Effective:** `<<date>>` · **Last reviewed:** `<<date>>` · **Cadence:** Each period
**Related RCM controls:** GL-01..06 (JE, period close, reconciliations)

> DRAFT template — formalize the close calendar; GL-06 (close checklist) currently partial.

## 1. Purpose
Ensure each accounting period closes accurately, completely, and on time, with appropriate review and segregation of duties.

## 2. Close calendar (template)
| Day | Task | Owner | Control |
|---|---|---|---|
| BD-2..BD+1 | Cut-off: sales, purchases, GR/IR | `<<>>` | cut-off |
| BD+1 | Sub-ledger postings complete (AR/AP/inventory) | `<<>>` | completeness |
| BD+2 | Reconciliations: bank, AR↔GL(1100), AP↔GL(2000), inventory | `<<>>` | GL-06; recon |
| BD+2 | Manual JEs prepared and **independently approved** | GL Acct / Fin Controller | GL-05 (maker≠checker) |
| BD+3 | Trial balance reviewed; flux/variance analysis vs prior/budget | `<<>>` | management review |
| BD+3 | **Lock the period** (`POST /api/ledger/periods/{p}/close`, `gl_close`) | Fin Controller | period-lock |
| BD+4 | Financial statements reviewed & signed | CFO | review |

## 3. Controls
- **JE maker-checker:** every manual JE requires an approver ≠ preparer; drafts are excluded from balances until approved (GL-05 — implemented & evidenced).
- **Period lock:** posting into a closed period is rejected (`PERIOD_CLOSED`); only the year-end close may post into the period it closes.
- **Reconciliations:** prepared and independently certified (preparer ≠ certifier).
- **Management review:** documented flux/variance review with explanations for movements over `<<threshold>>`.
- **SoD:** JE posting (`gl_post`) is separate from period close (`gl_close`) (rule R05).

## 4. Evidence
Approved close calendar, completed reconciliations with sign-offs, manual-JE approval records, period-lock confirmation, signed flux analysis, and the financial statements review.

## Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-06-22 | `<<author>>` | Initial draft |
