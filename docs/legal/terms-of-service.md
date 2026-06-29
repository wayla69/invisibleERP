# Terms of Service — Oshinei Enterprise ERP

> **Status: DRAFT v0.1 — requires review and execution by qualified legal counsel before use.**
> Placeholders in `<<…>>` must be completed by `<<Invisible Consulting>>` and its counsel. This document is
> a starting template prepared alongside the platform; it is **not** legal advice and is not in force until
> signed/published.

**Provider:** `<<Invisible Consulting Co., Ltd.>>` ("Provider", "we") · **Effective date:** `<<effective-date>>`
**Governing law:** Laws of the Kingdom of Thailand · **Jurisdiction:** `<<courts of Bangkok>>`

---

## 1. The Service
The Provider offers a multi-tenant, cloud-hosted ERP/POS platform ("Service") for accounting, point-of-sale,
inventory, finance, reporting and related business functions, with optional AI-assisted features. Access is
by subscription (see §3 and the [SLA](./sla.md)).

## 2. Accounts & acceptable use
2.1 The Customer is responsible for its users, credentials, and for configuring roles/permissions (RBAC,
segregation-of-duties) appropriately. 2.2 The Customer must not attempt to access other tenants' data,
reverse-engineer the Service, or use it unlawfully.

## 3. Subscriptions, billing & trials
3.1 Plans, prices and included features are as published in-app and at checkout. 3.2 A free trial (currently
`<<14>>` days) converts to a paid subscription only on the Customer completing checkout; access to paid
features ends when a trial expires or a subscription is `Canceled`/`PastDue` (enforced by the platform's
plan gate). 3.3 Fees are billed in advance per period via the payment processor (Stripe). 3.4 Taxes (incl.
Thai VAT) are the Customer's responsibility except where the Provider is legally required to collect them.

## 4. Limitation of liability
4.1 **TO THE MAXIMUM EXTENT PERMITTED BY LAW, the Provider's total aggregate liability arising out of or
related to the Service shall not exceed `<<the fees paid by the Customer in the 12 months preceding the
event giving rise to the claim>>`.** 4.2 The Provider shall not be liable for indirect, incidental, special,
consequential, or punitive damages, or for lost profits, revenue, goodwill, or data, even if advised of the
possibility. 4.3 Nothing in this section limits liability that cannot be limited under applicable law (e.g.
liability for fraud or wilful misconduct).

## 5. Financial-data accuracy (IMPORTANT)
5.1 The Service is provided **"as is"**. While it implements internal controls (maker-checker, audit trails,
SoD), **the Provider does NOT warrant that GL balances, AR/AP reports, tax computations, or financial
statements produced by the Service are free from error.** 5.2 **The Customer remains solely responsible for
reviewing and verifying all financial data before relying on it, filing tax returns, or submitting
regulatory or statutory reports.** 5.3 The Customer is responsible for maintaining its own books of account
as required by Thai law and for engaging its own auditors.

## 6. Data protection (PDPA)
6.1 Personal data is processed in accordance with the [Data Processing Agreement](./data-processing-agreement.md)
and the Personal Data Protection Act B.E. 2562 (PDPA). 6.2 Customer personal data of Thai data subjects is
hosted in Thailand (`<<Alibaba Cloud, Bangkok region>>`). 6.3 Data-subject requests (access, rectification,
erasure, portability, objection) are supported via the platform's DSAR workflow.

## 7. Third-party services & AI
7.1 The Service uses sub-processors listed in the [DPA](./data-processing-agreement.md) (e.g. the payment
processor and cloud host). 7.2 Optional **AI-assisted features** send business data to a third-party model
provider (`<<Anthropic>>`) to generate summaries/insights and extract document fields. **Direct contact
identifiers are minimized/redacted before transmission where feasible** (`AI_PII_REDACTION`), and AI features
can be disabled per tenant. Use of AI features is governed by the DPA. 7.3 AI output may be inaccurate or
incomplete and must not be relied upon without human verification; AI may only **propose** (not post)
financial transactions, which require human approval.

## 8. Data retention & return
On termination, the Customer may export its data; the Provider retains/deletes data per the
[Data Retention & Deletion Policy](../ops/data-retention-policy.md) and applicable Thai statutory retention
periods (e.g. accounting records). Backups are retained for `<<90 days>>` then deleted.

## 9. Availability
Service levels, including uptime targets and recovery objectives (RTO/RPO), are set out in the [SLA](./sla.md).

## 10. Suspension & termination
The Provider may suspend access for non-payment (`PastDue`) or material breach, with notice where practicable.
Either party may terminate per `<<the subscription terms>>`.

## 11. Changes
The Provider may update these Terms with notice; continued use after the effective date of an update
constitutes acceptance.

## 12. Contact
`<<legal@invisible-consulting.example>>`

---

### Revision history
| Version | Date | Author | Notes |
| --- | --- | --- | --- |
| 0.1 DRAFT | 2026-06-29 | Platform | Initial template drafted alongside the platform (panel remediation). Liability cap, financial-data-accuracy disclaimer, PDPA + AI/sub-processor disclosure, retention, SLA cross-reference. **Requires counsel review + completion of `<<…>>` placeholders before publication.** |
