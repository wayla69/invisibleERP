# Third-Party / Vendor & Sub-Service Organization Management Policy

**Policy ID:** ELC-POL-12 · **Owner:** `<<Procurement / CFO>>` · **Approved by:** `<<CFO>>`
**Version:** 0.1 (DRAFT) · **Effective:** `<<date>>` · **Last reviewed:** `<<date>>` · **Cadence:** Annual
**Related RCM controls:** EXP-02 (approved vendors), and sub-service-organization reliance (hosting, payments)

> DRAFT template — central to the auditor's "complementary user-entity controls" review for outsourced infra/payments.

## 1. Purpose
Govern selection, approval, and ongoing oversight of third parties — especially **sub-service organizations** whose controls the company relies on for ICFR (hosting, payment processing).

## 2. Vendor onboarding & approval
- Vendors are created in master data (`md_vendor`) and **approved** before transacting; blocklisted/unapproved vendors are blocked at PO/quote (EXP-02 — implemented).
- Vendor-master maintenance is segregated from AP payment (SoD R02).
- Risk-tier each vendor (`<<low/med/high>>`); high-risk/financially-significant vendors require enhanced due diligence.

## 3. Sub-service organizations (reliance for ICFR)
Identify providers whose controls affect financial reporting and **obtain and review their assurance reports annually**:

| Provider | Service | Assurance to obtain | Reviewer | Last reviewed |
|---|---|---|---|---|
| `<<Railway>>` | Managed hosting + PostgreSQL | `<<SOC 2 Type II>>` | DevOps / CISO | `<<>>` |
| `<<Stripe>>` | Card payments (PSP) | `<<SOC 1 / PCI DSS AoC>>` | Controller | `<<>>` |
| `<<Omise>>` | Card payments (PSP) | `<<SOC 1 / PCI DSS>>` | Controller | `<<>>` |
| `<<email/other>>` | `<<service>>` | `<<report>>` | `<<>>` | `<<>>` |

For each report: confirm scope/period covers our usage, note any qualified opinions, and **identify Complementary User Entity Controls (CUECs)** we must perform on our side (e.g., webhook-signature verification — implemented).

## 4. Ongoing monitoring
- Annual re-review of assurance reports and vendor performance (supplier scorecards exist).
- Track contract renewals, data-processing terms (PDPA), and incident history.

## 5. Evidence
Approved-vendor list, vendor-block evidence, the sub-service-org assurance reports + review notes, and the CUEC mapping.

## Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-06-22 | `<<author>>` | Initial draft |
