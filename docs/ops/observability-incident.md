# Ops — Observability, Alerting & Incident Response (ITGC-OP-03 / OP-04)

> **Status:** v1.0 · **Date:** 2026-06-23 · **Owner:** Platform / SRE
> Phase A deliverable of `docs/11-next-upgrade-realworld-roadmap.md`.

## 1. What the system emits
- **Traces** — OpenTelemetry (`apps/api/src/observability/instrumentation.ts`), HTTP + Postgres
  instrumented, OTLP/HTTP export. Enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Errors** — Sentry (`@sentry/node`) when `SENTRY_DSN` is set; release/environment tagged.
- **Logs** — structured JSON via **pino**; every mutation carries `requestId` + tenant; audit trail in
  the append-only `audit_log` table (ITGC-AC-10).
- **Health** — `/healthz` (liveness) and `/readyz` (readiness, DB ping) — see `deployment.md`.

In **production**, missing `SENTRY_DSN`/`OTEL_EXPORTER_OTLP_ENDPOINT` is **warned at boot**
(`env.validation.ts`) so reduced-visibility deploys are visible, not silent. Set both in prod.

## 2. Required alerts (configure in your APM/uptime tool)

| Signal | Condition | Severity |
|---|---|---|
| Availability | `/readyz` failing > 2 min, or healthcheck restarts | **SEV-1** |
| Error rate | 5xx rate > 2% over 5 min (Sentry/OTel) | SEV-2 |
| Latency | p95 API latency > 1s over 10 min | SEV-3 |
| Saturation | DB connections > 80% of pool (`DB_POOL_MAX`) / CPU > 85% | SEV-3 |
| **Batch jobs** | any scheduled job (billing, FX revaluation, subscriptions) **fails or misses its window** | SEV-2 |
| Backups | `tools/ops/pg-backup.sh` non-zero exit / no new dump in 26h | SEV-2 |
| Security | gitleaks/CodeQL finding on `main`; spike in 401/403 | SEV-2 |

> **Batch-job monitoring (OP-04):** the scheduler (`pg-boss`) jobs must each record success/failure and
> alert on failure. Track an explicit job-run log and surface it on the ops dashboard.

## 3. Incident response (ITGC-OP-03)

| Severity | Definition | Response | Comms |
|---|---|---|---|
| **SEV-1** | Outage / data-integrity / security breach | Page on-call immediately; all-hands | Status page + stakeholders ≤ 30 min |
| **SEV-2** | Major degradation, no full outage | On-call within 30 min | Internal channel |
| **SEV-3** | Minor / single-tenant / cosmetic | Next business day | Ticket |

**Lifecycle:** detect → acknowledge → triage/assign IC → mitigate (rollback via `deploy.yml` to last
good release; restore via `tools/ops/BACKUP-RUNBOOK.md` if data) → resolve → **blameless postmortem**
within 5 business days (timeline, root cause, action items). Log every incident in the incident register
(evidence for ITGC-OP-03).

**On-call:** maintain a rotation + escalation path (primary → secondary → eng lead). Record contact
routing in the paging tool.

## 4. Follow-ups
- Stand up dashboards (latency/error/saturation/job-runs) and wire the alert rules above.
- Formalize the on-call rotation + incident register location.

## 5. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-06-23 | Platform / SRE | Initial observability + alerting + incident-response runbook. |
