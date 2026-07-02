# Ops — Observability, Alerting & Incident Response (ITGC-OP-03 / OP-04)

> **Status:** v1.1 · **Date:** 2026-06-30 · **Owner:** Platform / SRE
> Phase A deliverable of `docs/11-next-upgrade-realworld-roadmap.md`. v1.1 — observability is now
> fail-closed in prod; ops-alert sink + slow-request logging + ops-metrics endpoint + dead-letter/reaper.

## 1. What the system emits
- **Traces** — OpenTelemetry (`apps/api/src/observability/instrumentation.ts`), HTTP + Postgres
  instrumented, OTLP/HTTP export. Enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Errors** — Sentry (`@sentry/node`) when `SENTRY_DSN` is set; release/environment tagged.
- **Logs** — structured JSON via **pino**; every mutation carries `requestId` + tenant; audit trail in
  the append-only `audit_log` table (ITGC-AC-10).
- **Ops alerts** — `captureOpsAlert(event, detail, err?)` (`observability/instrumentation.ts`) emits a
  single structured **error** log (`alert:"ops"`, `event:…`) and a Sentry capture. Used for operator-facing
  conditions not tied to one tenant (dead-lettered/zombie jobs). Alert on `alert:"ops"` in your log pipeline.
- **Slow paths** — every request's DB transaction is timed; one held longer than `SLOW_TX_MS` (default
  1000) logs `event:"slow_request"` with route + duration (`common/tenant-tx.interceptor.ts`).
- **Ops metrics** — `GET /api/jobs/ops-metrics` (admin / `users`): DB-pool saturation (`in_flight_tx` vs
  `DB_POOL_MAX`, peak), slow-request counts, and the job backlog (`queued/running/failed/stuck`).
- **Health** — `/healthz` (liveness) and `/readyz` (readiness, DB ping) — see `deployment.md`.

In **production**, observability is **fail-closed**: the boot env gate (`env.validation.ts`) **refuses to
start** when `SENTRY_DSN`/`OTEL_EXPORTER_OTLP_ENDPOINT` are unset — set both, or opt out consciously with
`ALLOW_NO_OBSERVABILITY=1` (downgrades to a loud warning). "Silently blind in prod" is no longer possible.

## 2. Required alerts (configure in your APM/uptime tool)

| Signal | Condition | Severity |
|---|---|---|
| Availability | `/readyz` failing > 2 min, or healthcheck restarts | **SEV-1** |
| Error rate | 5xx rate > 2% over 5 min (Sentry/OTel) | SEV-2 |
| Latency | p95 API latency > 1s over 10 min | SEV-3 |
| Saturation | `ops-metrics` `pool.saturation_pct` > 80, or `requests.slow_tx_count` rising / CPU > 85% | SEV-3 |
| **Batch jobs** | `ops-metrics` `jobs.failed` (dead-letter) or `jobs.stuck` > 0; or an `alert:"ops"` log event | SEV-2 |
| Backups | `tools/ops/pg-backup.sh` non-zero exit / no new dump in 26h | SEV-2 |
| Security | gitleaks/CodeQL finding on `main`; spike in 401/403 | SEV-2 |

> **Batch-job monitoring (OP-04) — IMPLEMENTED.** The in-process `background_jobs` worker (NOT pg-boss)
> now: (a) raises an ops alert (`event:"job_dead_letter"`) when a job exhausts its retries instead of
> silently landing in `failed`; (b) runs a **reaper** that detects jobs stuck in `running` past
> `JOBS_STUCK_MS` (a crashed worker's zombie) and requeues them, else dead-letters + alerts
> (`event:"job_stuck_dead_letter"` / `"jobs_reaped"`); and (c) exposes `queued/running/failed/stuck` on
> `GET /api/jobs/ops-metrics`. Wire a page on `jobs.stuck > 0` or `jobs.failed` increasing. Evidence:
> `cutover/async-jobs.ts`.

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
- Stand up dashboards (latency/error/saturation/job-runs) and wire the alert rules above to the
  `ops-metrics` endpoint + the `alert:"ops"` / `slow_request` log events.
- Add `pgbouncer` + a Prometheus exporter for deeper pool wait-queue depth (the in-process gauge is a
  first-order signal, not a replacement).
- Formalize the on-call rotation + incident register location.

## 5. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-06-23 | Platform / SRE | Initial observability + alerting + incident-response runbook. |
| 1.1 | 2026-06-30 | Platform / SRE | Observability **fail-closed** in prod (`ALLOW_NO_OBSERVABILITY` opt-out); ops-alert sink (`captureOpsAlert`); slow-request logging (`SLOW_TX_MS`); `GET /api/jobs/ops-metrics`; background-job dead-letter alert + stuck-job reaper (OP-04 now Implemented). |
| 1.2 | 2026-07-02 | Platform / SRE | New ops alert **`login_lockout_store_unavailable`** (docs/24 R2-1 / AUD-SEC-01): the per-account login lockout store fails OPEN on infra error by design — this alert (throttled to 1/min) is the pager signal that per-account brute-force protection is degraded to the per-IP edge limiter only. Respond: restore `login_attempts` DB connectivity; watch `login_lockout` alerts for stuffing attempts during the window. |
