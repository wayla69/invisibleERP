# Service Level Agreement (SLA) — Oshinei Enterprise ERP

> **Status: DRAFT v0.1 — requires review and execution by qualified legal counsel before use.**
> Targets below are proposed defaults to be confirmed against the production deployment
> (`<<Alibaba Cloud, Bangkok>>`) and commercial terms. Complete `<<…>>` placeholders.

**Provider:** `<<Invisible Consulting Co., Ltd.>>` · **Effective date:** `<<effective-date>>`

---

## 1. Uptime commitment
- **Target availability:** `<<99.5%>>` of each calendar month, measured on the production API + web app.
- **Exclusions:** scheduled maintenance announced ≥ `<<48 hours>>` in advance; Customer-side network/config
  issues; force majeure; third-party provider outages (cloud host, payment processor) outside the Provider's
  control; abuse/DDoS.

## 2. Service credits
For each `<<0.1%>>` below the monthly target (outside exclusions), the Customer is eligible for a service
credit of `<<5% of the monthly fee, capped at 50%>>`, applied to a future invoice on written request within
`<<30 days>>`. Service credits are the Customer's sole and exclusive remedy for availability shortfalls.

## 3. Recovery objectives
- **RTO (Recovery Time Objective):** `<<4 hours>>` — time to restore service to a failover environment.
- **RPO (Recovery Point Objective):** `<<24 hours>>` — maximum data loss (aligned to backup cadence).
- Backups are taken `<<daily>>`, restore-tested per the backup runbook (`docs/ops/BACKUP-RUNBOOK.md`), and
  retained `<<90 days>>`.

## 4. Support
| Severity | Definition | Target response |
|---|---|---|
| Critical (S1) | Service down / data-integrity risk | `<<4 business hours>>` |
| High (S2) | Major feature unusable, no workaround | `<<8 business hours>>` |
| Medium/Low (S3/S4) | Minor issue / question | `<<1 business day>>` |

Support channel: `<<support@invisible-consulting.example>>` · Hours: `<<Mon–Fri, business hours, Asia/Bangkok>>`.

## 5. Maintenance
Routine maintenance is scheduled in low-traffic windows (`<<Asia/Bangkok overnight>>`) and announced in
advance. Emergency security patches may be applied without prior notice; the Provider will notify promptly
after.

## 6. Monitoring & status
Availability and incident history are tracked via the Provider's observability stack; a status page is
`<<planned / at … >>`.

---

### Revision history
| Version | Date | Author | Notes |
| --- | --- | --- | --- |
| 0.1 DRAFT | 2026-06-29 | Platform | Initial SLA template (panel remediation): uptime target + service credits, RTO/RPO aligned to the backup runbook, support severity/response matrix, maintenance windows. **Targets are proposals pending confirmation against the production deployment + commercial terms; requires counsel review.** |
