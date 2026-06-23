# Incident Response Policy

**Policy ID:** ELC-POL-10 · **Owner:** `<<DevOps / CISO>>` · **Approved by:** `<<CISO>>`
**Version:** 0.1 (DRAFT) · **Effective:** `<<date>>` · **Last reviewed:** `<<date>>` · **Cadence:** Annual + after each incident
**Related RCM controls:** ITGC-OP-03 (alerting/incident process)

> DRAFT template — define on-call and severity SLAs; OP-03 is currently remediating.

## 1. Purpose
Detect, respond to, and learn from operational and security incidents (outages, data breaches, failed financial jobs, suspected fraud) to limit impact and preserve evidence.

## 2. Detection & alerting
- Monitoring: Sentry (errors), OpenTelemetry (tracing), `<<uptime/alerting tool>>`.
- **Scheduled financial jobs** (pg-boss) are monitored; failures alert `<<channel>>` and are reviewed (links to OP-04).

## 3. Severity & response SLA
| Severity | Definition | Ack SLA | Resolve target |
|---|---|---|---|
| SEV-1 | Outage / data breach / financial-data integrity risk | `<<15 min>>` | `<<4 h>>` |
| SEV-2 | Major degradation | `<<1 h>>` | `<<1 day>>` |
| SEV-3 | Minor | `<<1 day>>` | `<<1 week>>` |

## 4. Process
1. **Detect & log** in the incident register (`id, time, severity, summary`).
2. **Triage & assign** an incident lead (on-call).
3. **Contain, eradicate, recover** (invoke DR/BCP if needed — ELC-POL-09).
4. **Communicate** to stakeholders; for breaches, follow `<<PDPA / legal notification>>` requirements.
5. **Post-incident review** for SEV-1/2: root cause, corrective actions, owners, dates.

## 5. Evidence
Incident register, alert configuration, SEV-1/2 post-mortems with corrective actions tracked to closure.

## Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-06-22 | `<<author>>` | Initial draft |
