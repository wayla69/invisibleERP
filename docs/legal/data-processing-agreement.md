# Data Processing Agreement (DPA) — Oshinei Enterprise ERP

> **Status: DRAFT v0.2 — requires review and execution by qualified legal counsel before use.**
> Complete `<<…>>` placeholders. Not legal advice; not in force until executed by both parties.
>
> **Counsel TODO (must close before production AI is enabled):**
> - [ ] Fill all `<<…>>` placeholders (effective date, legal entity, jurisdiction, notice periods, deadlines).
> - [ ] **Execute the Anthropic data addendum** for the AI sub-processor (the precondition gated in code —
>       see note below) and confirm the model-provider's data-handling/retention terms.
> - [ ] Confirm the sub-processor list (Alibaba Cloud, Stripe, Anthropic, Sentry/OTel) and notice mechanism.
> - [ ] Counsel review of cross-border transfer basis (PDPA s.28–29; GDPR Ch. V where EU subjects served).
>
> **Runtime enforcement of this precondition:** the platform fails **closed** — when an Anthropic API key is
> set in production but `AI_DPA_ACKNOWLEDGED` is not, AI endpoints return `AI_DPA_REQUIRED` and the
> AI-assisted services degrade to their deterministic (no-transmission) path. Set `AI_DPA_ACKNOWLEDGED=1`
> only **after** this DPA and the Anthropic addendum are executed (see `apps/api/src/common/ai-models.ts`
> `aiDpaBlocked()`).

**Processor:** `<<Invisible Consulting Co., Ltd.>>` · **Controller:** the subscribing Customer
**Effective date:** `<<effective-date>>` · **Framework:** Thailand PDPA B.E. 2562 (and, where the Customer
serves EU data subjects, GDPR Art. 28 as applicable)

---

## 1. Scope & roles
The Processor processes personal data on behalf of the Controller solely to provide the Service. "Personal
data" includes employee names/credentials, customer/member contact details (name, phone, email, LINE id),
and any personal data within transaction memos or uploaded documents. For the Controller's own customers/
employees the Controller is the Controller (or joint controller) and the Provider is the Processor.

## 2. Processing instructions
The Processor processes personal data only on the Controller's documented instructions (this DPA + the
Service configuration), and as required by Thai law (with notice unless prohibited).

## 3. Sub-processors
The Controller authorizes the following sub-processors:

| Sub-processor | Location | Purpose | Data categories |
|---|---|---|---|
| `<<Alibaba Cloud>>` | `<<Bangkok, Thailand>>` | Hosting, managed PostgreSQL, object storage, backups | All Service data |
| `<<Stripe>>` | `<<USA/EU>>` | Subscription payment processing | Billing contact, payment metadata (no card data stored by Provider) |
| `<<Anthropic>>` | `<<USA>>` | AI-assisted summaries/insights & document field extraction (optional feature) | Business data sent to the model; **direct contact identifiers minimized/redacted before transmission** (`AI_PII_REDACTION`); feature disableable per tenant |
| `<<Sentry / OpenTelemetry>>` | `<<…>>` | Error monitoring / observability (optional) | Diagnostic metadata |

The Processor will give the Controller `<<30 days'>>` notice of any new sub-processor; the Controller may
object on reasonable data-protection grounds, in which case the parties will work in good faith to resolve
(or the Controller may terminate the affected feature).

> **AI sub-processor note (required before enabling AI in production):** execute a data-processing addendum
> with `<<Anthropic>>` that (a) restricts processing to providing the feature, (b) prohibits use of Customer
> data for model training without explicit opt-in, and (c) provides audit/security commitments. Until that is
> in place, AI features should be disabled (`ANTHROPIC_API_KEY` unset / per-tenant opt-out).

## 4. Security measures
The Processor maintains technical and organizational measures including: PostgreSQL row-level security
tenant isolation; encryption in transit (TLS) and AES-256-GCM for secrets at rest; RBAC + segregation of
duties; MFA for privileged roles; append-only, hash-chained audit logging; short-lived access tokens with
refresh-token rotation; per-endpoint rate limiting; and least-privilege database roles. See the ICFR/ITGC
documentation (`docs/process-narratives/08-itgc.md`, `compliance/`).

## 5. Data-subject rights (PDPA)
The Processor assists the Controller in fulfilling data-subject requests via the platform DSAR workflow:
- **Access / portability** — `POST /api/pdpa/dsar` + export bundle (profile, consents, points ledger).
- **Erasure** — operational PII is redacted and consents withdrawn; the immutable hash-chained audit log is
  preserved and erased PII is masked at read time (so PDPA erasure and audit tamper-evidence both hold).
- Statutory **30-day** response clock is tracked.

## 6. Personal-data breach
The Processor will notify the Controller without undue delay (target `<<72 hours>>`) after becoming aware of
a personal-data breach affecting the Controller's data, with available details to support the Controller's
PDPA notification obligations.

## 7. International transfer
Personal data of Thai data subjects is hosted in Thailand. Any transfer outside Thailand (e.g. the AI
sub-processor) occurs only under an appropriate lawful mechanism and the safeguards in §3.

## 8. Return & deletion
On termination, the Processor will, at the Controller's choice, return or delete personal data within
`<<60 days>>`, except where retention is required by law (e.g. statutory accounting-record retention);
backups purge within `<<90 days>>`. See `../ops/data-retention-policy.md`.

## 9. Audit
The Processor will make available information reasonably necessary to demonstrate compliance and allow for
audits `<<subject to reasonable notice and confidentiality>>`.

---

### Revision history
| Version | Date | Author | Notes |
| --- | --- | --- | --- |
| 0.1 DRAFT | 2026-06-29 | Platform | Initial DPA template (panel remediation): roles, sub-processor register (incl. **Anthropic AI** with redaction + no-training note), security measures, PDPA data-subject-rights assistance, breach notice, transfer, return/deletion, audit. **Requires counsel review + an executed Anthropic data addendum before AI is enabled in production.** |
