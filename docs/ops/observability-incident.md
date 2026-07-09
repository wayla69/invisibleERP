# Ops — Observability, Alerting & Incident Response (ITGC-OP-03 / OP-04)

> **Status:** v1.6 · **Date:** 2026-07-09 · **Owner:** Platform / SRE
> Phase A deliverable of `docs/11-next-upgrade-realworld-roadmap.md`. v1.1 — observability is now
> fail-closed in prod; ops-alert sink + slow-request logging + ops-metrics endpoint + dead-letter/reaper.

## 1. What the system emits
- **Traces** — OpenTelemetry (`apps/api/src/observability/instrumentation.ts`), HTTP + Postgres
  instrumented, OTLP/HTTP export. Enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Errors** — Sentry (`@sentry/node`) when `SENTRY_DSN` is set; release/environment tagged. **Every
  unhandled 5xx** that reaches a client is forwarded by the global exception filter
  (`common/all-exceptions.filter.ts` → `captureRequestException`) with `route` + `http_status` tags
  (query string stripped — it can carry tokens/PII); 4xx business outcomes are not forwarded. So once
  `SENTRY_DSN` is set, error-rate alerting covers the whole API surface, not only the explicit
  `captureOpsAlert` call sites.
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

In **production**, the API is **never silently blind**: the built-in signals above (structured logs +
`audit_log` + `/healthz`/`/readyz` + slow-tx logging + `ops-metrics`) are **always on** and require no
external service. The external backends — **Sentry** (`SENTRY_DSN`) for error-aggregation and **OTel**
(`OTEL_EXPORTER_OTLP_ENDPOINT`) for distributed tracing — are **recommended enhancements, not a boot
requirement**: a lean deployment can run on the built-in signals alone. An operator who needs to **mandate**
the external backends (e.g. an audited environment) sets **`REQUIRE_OBSERVABILITY_BACKENDS=1`**, which
restores a **fail-closed** boot gate (`env.validation.ts`) — boot then **refuses to start** when either is
unset, still overridable with a conscious `ALLOW_NO_OBSERVABILITY=1` (loud, auditable warning). Without that
flag, running without external APM is a **silent, documented default** (no boot warning).

### 1bis. Enablement checklist (the "button" — everything downstream activates from env alone)

1. **Sentry** — create the project, set **`SENTRY_DSN`** on the API service. Optional:
   `SENTRY_TRACES_SAMPLE_RATE` (default 0), `APP_VERSION` (release tag). Unhandled 5xx + all
   `captureOpsAlert` events start flowing immediately; wire the §2 error-rate/batch-job rules to it.
2. **OTel tracing** — set **`OTEL_EXPORTER_OTLP_ENDPOINT`** to your collector's OTLP/HTTP endpoint
   (e.g. `http://otel-collector:4318`). HTTP + Postgres spans export automatically.
3. **Enforce (audited env)** — set **`REQUIRE_OBSERVABILITY_BACKENDS=1`** so a deploy that loses either
   backend **refuses to boot** (override: `ALLOW_NO_OBSERVABILITY=1`, loud + auditable).
4. **Alert rules** — configure the §2 table in the APM/uptime tool: `/readyz` uptime probe, Sentry
   error-rate, and a log-pipeline rule on `alert:"ops"` / `event:"slow_request"` routed to on-call.

No code change or redeploy beyond setting the env vars is required — the SDKs are installed and
initialized first thing in `main.ts` (`startTelemetry(); initSentry();`), and both are no-ops when unset.

**One-click apply:** the **`Ops — set observability backends`** workflow
(`.github/workflows/ops-set-observability.yml`, manual dispatch) reads `SENTRY_DSN` /
`OTEL_EXPORTER_OTLP_ENDPOINT` from the `production` GitHub-Environment **secrets** (never from
inputs, so the DSN stays out of run logs), applies them to the `invisibleERP` API service via the
Railway CLI, and redeploys — same token binding as `deploy.yml`/`ops-set-cors.yml`. Steps: create the
Sentry project → add the two Environment secrets → Run workflow (tick `enforce` to also set
`REQUIRE_OBSERVABILITY_BACKENDS=1`).

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
| 1.2 | 2026-07-02 | Platform / SRE | New ops alert **`login_lockout_store_unavailable`** (docs/27 R2-1 / AUD-SEC-01): the per-account login lockout store fails OPEN on infra error by design — this alert (throttled to 1/min) is the pager signal that per-account brute-force protection is degraded to the per-IP edge limiter only. Respond: restore `login_attempts` DB connectivity; watch `login_lockout` alerts for stuffing attempts during the window. |
| 1.3 | 2026-07-02 | Platform / SRE | New ops alert **`realtime_redis_publish_failed`** (docs/27 R1-3): Redis pub/sub behind the SSE buses failed a publish — the event was delivered to same-node clients only; other replicas missed it. Respond: check `REALTIME_REDIS_URL` connectivity / the Redis add-on; alert is throttled to 1/min. |
| 1.6 | 2026-07-09 | Platform / SRE | **§1bis one-click apply:** new manual-dispatch workflow `ops-set-observability.yml` sets `SENTRY_DSN`/`OTEL_EXPORTER_OTLP_ENDPOINT` (+ optional `SENTRY_TRACES_SAMPLE_RATE`, `REQUIRE_OBSERVABILITY_BACKENDS=1`) on the `invisibleERP` Railway service from `production`-Environment secrets and redeploys — dev sandboxes can't reach Railway's API, so the button lives in CI like `ops-set-cors.yml`. |
| 1.5 | 2026-07-09 | Platform / SRE | **Unhandled-5xx → Sentry forwarding + enablement checklist.** The global exception filter (`common/all-exceptions.filter.ts`) now forwards every unhandled 5xx to Sentry via `captureRequestException` (`observability/instrumentation.ts`) with `route`/`http_status` tags, query string stripped; 4xx stay out. Closes the gap where only explicit `captureOpsAlert` call sites reached Sentry. Added §1bis enablement checklist (SENTRY_DSN / OTEL_EXPORTER_OTLP_ENDPOINT / REQUIRE_OBSERVABILITY_BACKENDS). ToE: `apps/api/test/ops-observability.test.ts` (4 new cases). |
| 1.4 | 2026-07-03 | Platform / SRE | **Observability posture refined (ITGC-OP-03).** External backends (Sentry `SENTRY_DSN` / OTel `OTEL_EXPORTER_OTLP_ENDPOINT`) are now **recommended, not required** to boot — the always-on built-in signals (structured logs / `audit_log` / `/healthz`+`/readyz` / slow-tx / `ops-metrics`) mean prod is never "silently blind" without an external SaaS. The fail-closed boot gate is now **opt-in** via **`REQUIRE_OBSERVABILITY_BACKENDS=1`** (still overridable with `ALLOW_NO_OBSERVABILITY=1`); without it, the absence of external APM is a silent, documented default (removes the alarming boot WARN on lean deployments). Reverses the v1.1 default-fail-closed stance while preserving its enforce path. Code `env.validation.ts`; ToE `apps/api/test/ops-observability.test.ts`. |
