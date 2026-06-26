# Fraud Risk Assessment Policy & Register

**Policy ID:** ELC-POL-05 · **Owner:** CFO / Controller · **Approved by:** Audit Committee
**Version:** 1.0 · **Effective:** 2026-07-01 · **Last reviewed:** 2026-06-26 · **Cadence:** Annual
**Related RCM controls:** ELC-05 (fraud risk assessment); links to ITGC-AC-09 (SoD), GL-05, EXP, REV

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
| F1 | Expenditure | Fictitious vendor created and paid | Vendor-master vs AP-pay SoD (R02); 3-way match (EXP-01); DoA | Low | Controller / Procurement Mgr |
| F2 | Expenditure | Buyer orders and pays own PO | Procurement vs AP SoD (R03); maker-checker (preventive block) | Low | Controller / Procurement Mgr |
| F3 | GL | Unauthorized manual JE to hide misstatement | JE maker-checker (GL-05); period lock; append-only audit log (immutable trigger) | Low | CFO / Controller |
| F4 | Revenue | Sales beyond credit limit / to insiders | Credit-limit + hold check (REV-08); credit SoD (R09) | Medium | Credit Manager / CFO |
| F5 | POS/Cash | Cashier rings, refunds, and reconciles own till | pos_sell/refund/till SoD (R08); Z-report variance review (manual) | Medium | Store Manager / Controller |
| F6 | Access | Admin grants self extra access then transacts | Access-admin vs transact SoD (R01); quarterly UAR; MFA enforcement; audit log | Low | IT Security |
| F7 | Inventory | Shrink concealed via adjustments | adjust vs count SoD (R11); variance approval workflow | Medium | Inventory Manager / Controller |
| F8 | IT | Direct DB change bypasses app controls | Least-privilege DB roles (AC-13); append-only audit_log + fiscal journal (immutable trigger) | Low | IT Security / DBA |

## 4. Evidence
The completed register (rated), supporting workshop notes, and Audit Committee minutes approving it and the resulting remediation actions.

## Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-06-22 | Platform / Controller | Initial draft |
| 1.0 | 2026-06-26 | Platform / Controller | Adopted — DRAFT removed; fraud register rated (residual Low/Medium); owners assigned; approved by Audit Committee; effective 2026-07-01 |
