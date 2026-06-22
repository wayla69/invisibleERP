# Fraud Risk Assessment Policy & Register

**Policy ID:** ELC-POL-05 · **Owner:** `<<CFO / Internal Audit>>` · **Approved by:** `<<Audit Committee>>`
**Version:** 0.1 (DRAFT) · **Effective:** `<<date>>` · **Last reviewed:** `<<date>>` · **Cadence:** Annual
**Related RCM controls:** ELC-05 (fraud risk assessment); links to ITGC-AC-09 (SoD), GL-05, EXP, REV

> DRAFT template — perform the assessment with finance + IT + the SOX advisor; review results with the Audit Committee.

## 1. Purpose
COSO Principle 8 requires the organization to consider the potential for fraud in assessing risks. This policy establishes an annual, documented fraud risk assessment that identifies fraud scenarios, evaluates likelihood/impact, and maps each to mitigating controls (or a remediation action).

## 2. Method
1. **Identify** fraud schemes across cycles (revenue, expenditure, payroll, cash, journal entries, master data, access).
2. **Assess** inherent likelihood and impact (High/Med/Low) considering incentives, opportunities, and rationalization (the "fraud triangle").
3. **Map** to existing controls; rate residual risk.
4. **Remediate** gaps; assign owners and dates (feed the RCM gap-remediation plan).
5. **Report** to the Audit Committee.

## 3. Fraud risk register (starter — extend & rate)

| # | Cycle | Fraud scenario | Mitigating control(s) | Residual | Owner |
|---|---|---|---|---|---|
| F1 | Expenditure | Fictitious vendor created and paid | Vendor-master vs AP-pay SoD (R02); 3-way match (EXP-01); DoA | `<<>>` | `<<>>` |
| F2 | Expenditure | Buyer orders and pays own PO | Procurement vs AP SoD (R03); maker-checker | `<<>>` | `<<>>` |
| F3 | GL | Unauthorized manual JE to hide misstatement | JE maker-checker (GL-05); period lock; audit log | `<<>>` | `<<>>` |
| F4 | Revenue | Sales beyond credit limit / to insiders | Credit-limit + hold check (REV-08); credit SoD (R09) | `<<>>` | `<<>>` |
| F5 | POS/Cash | Cashier rings, refunds, and reconciles own till | pos_sell/refund/till SoD (R08); Z-report variance review | `<<>>` | `<<>>` |
| F6 | Access | Admin grants self extra access then transacts | Access-admin vs transact SoD (R01); UAR; MFA; audit log | `<<>>` | `<<>>` |
| F7 | Inventory | Shrink concealed via adjustments | adjust vs count SoD (R11); variance approval | `<<>>` | `<<>>` |
| F8 | IT | Direct DB change bypasses app controls | Least-privilege DB roles (AC-13); append-only audit_log/journal | `<<>>` | `<<>>` |

## 4. Evidence
The completed register (rated), supporting workshop notes, and Audit Committee minutes approving it and the resulting remediation actions.

## Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-06-22 | `<<author>>` | Initial draft |
