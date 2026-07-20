# Segregation of Duties (SoD) Policy

**Policy ID:** ELC-POL-13 · **Owner:** `<<Controller / IT Security>>` · **Approved by:** `<<CFO>>`
**Version:** 0.1 (DRAFT) · **Effective:** `<<date>>` · **Last reviewed:** `<<date>>` · **Cadence:** Annual + quarterly conflict review
**Related RCM controls:** ITGC-AC-09 (SoD ruleset), and the underlying rules R01–R16

> DRAFT template — the rule registry, preventive block, and detective report are already implemented; this policy documents how they operate. Linked artifact: `compliance/Invisible_ERP_SoD_Matrix_v1.xlsx`.

## 1. Purpose
Prevent any single individual from controlling all phases of a transaction in a way that enables error or fraud to go undetected. SoD is enforced **preventively** (conflicting access cannot be granted without a justified, logged override) and monitored **detectively** (periodic conflict reporting).

## 2. Principles
- No one person should both **initiate and approve** the same transaction (maker ≠ checker).
- **Custody, recording, and authorization** of assets are separated.
- **Access administration** is separated from transacting.
- Conflicts that cannot be eliminated (small-team reality) require **documented compensating controls** and management acceptance.

## 3. Conflict rule registry (R01–R16)
The conflict rules are codified in `packages/shared/src/permissions.ts` (`SOD_RULES`) and evaluated on each user's *effective* (resolved + expanded) permissions. Summary:

| Rule | Duty A ✗ Duty B | Severity |
|---|---|---|
| R01 | Access administration ✗ any transactional duty | High |
| R02 | Maintain vendor master ✗ disburse AP | High |
| R03 | Raise PR/PO ✗ approve & pay AP | High |
| R04 | Purchase ordering ✗ goods receipt/custody | High |
| R05 | Post journal entries ✗ close period | High |
| R06 | Prepare reconciliation ✗ certify it | Medium |
| R07 | Initiate transactions ✗ approve workflow items | High |
| R08 | Record sale ✗ refund / reconcile till | High |
| R09 | Maintain customer/credit master ✗ enter sales orders | Medium |
| R10 | Maintain prices/promotions ✗ enter sales | Medium |
| R11 | Adjust inventory ✗ stock custody & counting | Medium |
| R12 | Process returns ✗ issue refund | Medium |
| R13 | Maintain master data/config ✗ transact on it | Medium |
| R14 | Configure rewards/vouchers (`crm_reward`) ✗ POS redemption at till (`pos_sell`) | High |
| R15 | Manual points adjustment (`crm_points_adjust`) ✗ member master maintenance (`crm_member`) | High |
| R16 | Campaign issuance of point-bearing value (`crm_campaign`) ✗ points adjustment (`crm_points_adjust`) | High |

The remediated single-duty role design (`Invisible_ERP_SoD_Matrix_v1.xlsx`, "Remediated Matrix") yields **0 residual conflicts** (Admin inherent superuser, by compensating control).

## 4. Controls (how SoD operates)
- **Preventive (ITGC-AC-09):** assigning a permission set that holds both sides of a rule is **blocked** (`422 SOD_CONFLICT`) unless an authorized admin records an explicit override **with a reason**, which is logged (`assertNoSodConflict` in `admin-users.service.ts`). Operating effectiveness is re-performed by the control harness (`cutover/compliance.ts`).
- **Maker-checker:** the workflow engine and GL-05 JE control enforce approver ≠ preparer regardless of permissions held — even Admin cannot approve its own item.
- **Detective:** the per-user SoD conflict report (`GET /api/admin/sod/conflicts`) is reviewed **quarterly** alongside the User Access Review (ELC-POL-07); each flagged conflict is remediated or has a documented, approved compensating control.

## 5. Override governance
Each SoD override requires: business justification, the compensating control, an approver `<<Controller/CFO>>`, and an expiry/recertification date. Overrides are re-reviewed every quarter.

## 6. Evidence
The SoD matrix, the rule registry, override records (reason + approver), quarterly conflict reports with dispositions, and the harness output.

## Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-06-22 | `<<author>>` | Initial draft |
| 0.2 | 2026-06-24 | Platform | Added CRM SoD rules R14–R16 (loyalty value issuance segregation) — now 16 rules. |
