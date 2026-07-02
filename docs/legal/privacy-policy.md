# นโยบายความเป็นส่วนตัว / Privacy Policy — Invisible ERP

> **DRAFT v0.1 — for counsel review; not in force until reviewed, completed and published.**
> Placeholders in `<<…>>` must be completed by `<<Invisible Consulting Co., Ltd.>>` and its counsel.
> Closes the SOC 2 CC2.3 external-communications gap (docs/24 R0-2 / AUD-LGL-02) at the *drafted* level;
> publication + counsel sign-off remain organizational steps.

**Controller/Processor:** `<<Invisible Consulting Co., Ltd.>>` (registration no. `<<…>>`), Thailand
**Contact / DPO channel:** `<<privacy@…>>` · **Effective date:** `<<effective-date>>`
**Framework:** Thailand Personal Data Protection Act B.E. 2562 (PDPA); GDPR where it applies to a Customer's own data subjects.

## 1. Who this covers, and our two roles

- **As a processor:** for personal data our Customers put into the Invisible ERP service (their customers,
  members, employees, vendors), the Customer is the data controller and we process on their documented
  instructions under the [Data Processing Agreement](./data-processing-agreement.md).
- **As a controller:** for account/registration data (tenant admin name, email, login records), billing
  contacts, and website telemetry, we decide the means and purposes and this policy applies directly.

## 2. What we collect

| Category | Examples | Basis |
|---|---|---|
| Account & authentication | username, password hash, MFA enrolment, login/audit records | contract; legitimate interest (security) |
| Billing | plan, billing contact, payment status (card data is handled by the payment provider — we never store PAN/CVV) | contract |
| Service content (as processor) | the Customer's business records incl. their customers/members/employees/vendors | Customer's instructions (DPA) |
| Diagnostics | error traces, request metadata | legitimate interest (service operation) |

## 3. How personal data is protected (as built)

- **Tenant isolation enforced in the database** — PostgreSQL Row-Level Security (FORCE) on every
  tenant-scoped table; fail-closed in production.
- **Field-level encryption at rest (AES-256-GCM)** for sensitive identifiers: Thai citizen/tax IDs, SSO
  numbers, bank accounts (customer master, employees, payslips, vendors) — control ITGC-AC-19.
- **Append-only, hash-chained audit trail**; posted financial records are immutable at the database layer.
- **AI features:** optional; direct contact identifiers (email/phone/citizen ID/address/LINE id) are
  **redacted before any transmission** to the AI provider; AI is blocked in production until the provider
  data-processing addendum is executed (`AI_DPA_REQUIRED` fail-closed gate); AI may propose but never post
  financial transactions.
- Access is role-based with segregation-of-duties controls; privileged roles require MFA.

## 4. Sub-processors

Hosting/DB/backups: Alibaba Cloud (Thailand region) · Payments: Stripe · AI (optional): Anthropic ·
Observability: Sentry. The current register, transfer safeguards and notice terms live in the
[DPA §sub-processors](./data-processing-agreement.md).

## 5. Retention

Account data for the life of the account plus `<<12 months>>`; financial/accounting records per Thai
statutory periods (typically ≥ 5 years, Revenue Code / Accounting Act); backups `<<90 days>>`; diagnostic
traces `<<90 days>>`. Erasure honours statutory-retention carve-outs (see §6).

## 6. Your rights (PDPA)

Data subjects may request **access, rectification, erasure, portability, or objection** — via their
controller (our Customer) for service content, or `<<privacy@…>>` for data we control. The platform
implements a DSAR workflow with a **30-day statutory SLA**; erasure redacts operational personal data and
pseudonymises it at read time in audit views, preserving the tamper-evident financial trail (control
PDPA-02). We do not sell personal data; we do not use Customer content to train AI models.

## 7. Breach notification

We notify affected Customers without undue delay and within `<<72 hours>>` of confirming a personal-data
breach, with the facts, likely consequences and mitigations (see DPA §breach).

## 8. Changes

Material changes are announced `<<30 days>>` in advance to tenant admins.

## Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 0.1 DRAFT | 2026-07-02 | Platform | Initial draft (docs/24 R0-2): dual controller/processor scope, collection/basis table, as-built protections (RLS, ITGC-AC-19 field encryption, audit chain, AI redaction + DPA gate), sub-processor pointer, PDPA rights incl. DSAR/erasure design, breach/retention terms. **Requires counsel review + completion of `<<…>>` placeholders before publication.** |
