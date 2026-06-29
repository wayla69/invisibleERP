# Customer-facing legal documents

> **All documents here are DRAFT v0.1 templates requiring review and execution by qualified legal counsel
> before publication or reliance.** They were drafted alongside the platform to close the "no customer-facing
> legal framework" gap flagged in the investor/legal review. They are **not** legal advice.

| Document | Purpose | Key clauses |
|---|---|---|
| [Terms of Service](./terms-of-service.md) | Master customer agreement | Liability cap; **financial-data accuracy disclaimer** (customer must verify before filing); subscription/trial; PDPA + AI/sub-processor disclosure; retention; SLA cross-ref |
| [Data Processing Agreement](./data-processing-agreement.md) | PDPA Art-28-style processor terms | Sub-processor register (**Alibaba Cloud, Stripe, Anthropic**); security measures; data-subject-rights assistance (DSAR); breach notice; return/deletion; **Anthropic data addendum required before AI in prod** |
| [SLA](./sla.md) | Availability & support commitments | Uptime target + service credits; **RTO/RPO** (aligned to the backup runbook); support severity matrix; maintenance windows |

## Before going live (checklist)
- [ ] Counsel reviews all three documents and completes every `<<…>>` placeholder.
- [ ] Execute a data-processing addendum with **Anthropic** (no-training clause, purpose limitation) — or keep
      AI features disabled per tenant until done.
- [ ] Confirm SLA targets (uptime/RTO/RPO/support) against the production deployment and commercial terms.
- [ ] Publish ToS + offer the DPA; capture acceptance at signup.
- [ ] Cross-check with `../ops/data-retention-policy.md`, `../process-narratives/08-itgc.md`, and `compliance/`.

These complement the **internal** governance docs in `compliance/policies/` (code of conduct, infosec,
access-control, change-management, backup/DR) — those govern the Provider's operations; the documents here
govern the **Provider↔Customer** relationship.
