# Delegation of Authority (DoA) Policy & Approval Matrix

**Policy ID:** ELC-POL-03 · **Owner:** CFO · **Approved by:** Board / CEO
**Version:** 1.0 · **Effective:** 2026-07-01 · **Last reviewed:** 2026-06-26 · **Cadence:** Annual
**Related RCM controls:** ELC-03 (DoA), EXP-01/03 (procurement approval), GL-05 (JE approval), REV-08 (credit), ITGC-AC-09 (SoD)

## 1. Purpose
Define who may authorize transactions and at what monetary thresholds, so that authority is explicit, segregated, and enforced in the system. The matrix is the business source of truth that the application's **approval-workflow engine** (`/api/workflow/definitions`, amount-based routing, maker-checker) is configured against.

## 2. Principles
- **Maker ≠ checker:** the initiator of a transaction may never approve it (enforced in code — workflow engine + GL-05 JE maker-checker).
- **Segregation of duties:** approvers must not hold a conflicting duty (enforced — SoD preventive block, ITGC-AC-09).
- **Thresholds escalate:** higher amounts require higher approval levels.
- **Delegation is temporary & logged:** an approver may delegate during absence (system delegations), but a delegate may not approve a document they created.

## 3. Approval matrix (set thresholds, then mirror in the workflow engine)

| Transaction | Initiator (role) | Approver L1 | Approver L2 | Threshold for L2 |
|---|---|---|---|---|
| Purchase Requisition / PO | Buyer (`procurement`) | Procurement Mgr | CFO | > THB 50,000 |
| AP payment | AP Clerk (`creditors`) | Financial Controller | CFO | > THB 100,000 |
| Manual Journal Entry | GL Accountant (`gl_post`) | Financial Controller (`gl_close`) | — | All manual JEs (GL-05) |
| Sales credit limit / new limit | Credit Manager (`crm`) | CFO | — | > THB 500,000 |
| Customer credit hold release | Credit Manager (`crm`) | Financial Controller | — | All |
| Period / year-end close | Financial Controller (`gl_close`) | CFO | — | All |
| User access / permission grant | Access Admin (`users`) | IT Security and Controller | — | All (UAR quarterly) |
| Vendor master add/change | Master Data Admin (`md_vendor`) | Procurement Mgr | — | All |
| Match-tolerance / pricing change | Controller (`gl_close`) | CFO / Pricing Manager | — | All |

> The roles in parentheses are the single-duty RBAC permissions in `packages/shared/src/permissions.ts`. Keep this matrix and `DEFAULT_ROLE_PERMISSIONS` aligned.

## 4. Procedures
- The CFO maintains this matrix; changes require Board / CEO approval.
- Eng configures the workflow definitions to match; a quarterly check confirms the active definitions equal this matrix (retain evidence).
- Out-of-system approvals (email/paper) are prohibited for in-scope transactions.

## 5. Evidence
The matrix (approved), the active workflow definitions export, and sampled approval records (approver ≠ initiator, threshold respected).

## Appendix A — Acknowledgement register format

The CFO countersigns this matrix annually; a summary record is retained in the evidence repository.

| Reviewer | Role | Date | Matrix version | Sign-off method |
|---|---|---|---|---|
| *(example)* Controller Name | Controller | 2026-07-01 | 1.0 | Email to Board |

## Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-06-22 | Platform / Controller | Initial draft |
| 1.0 | 2026-06-26 | Platform / Controller | Adopted — DRAFT removed; monetary thresholds set (PO > 50k, AP > 100k, credit limit > 500k); all role placeholders resolved; acknowledgement appendix added; effective 2026-07-01 |
