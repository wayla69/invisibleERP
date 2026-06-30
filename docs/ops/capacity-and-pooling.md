# Ops — Capacity & Connection Pooling (Tier 2)

> **Status:** v1.0 · **Date:** 2026-06-30 · **Owner:** Platform / SRE

Closes the operational-maturity "capacity baseline" gap: a known connection-pool model, PgBouncer in
front of Postgres, a saturation alert, and a runnable load test — so headroom is a number we track, not a
surprise at peak.

## 1. The connection-pool model

Each API process opens `DB_POOL_MAX` (default **20**) Postgres connections. With clustering and replicas the
fan-out is:

```
server connections ≈ replicas × WEB_CONCURRENCY × DB_POOL_MAX
```

A few replicas at default settings can exhaust Postgres `max_connections` (typically 100–200) — and the
prior load test showed throughput **pinned at ~400 rps with the pool saturated**. The fix is a pooler.

## 2. PgBouncer (transaction pooling)

Config: `tools/ops/pgbouncer/pgbouncer.ini` (+ `userlist.txt.example`). PgBouncer multiplexes many short
app transactions onto a small fixed server-connection pool, so the app can run a large `max_client_conn`
while Postgres sees only `default_pool_size` (× replicas) connections.

- Point the API `DATABASE_URL` at PgBouncer (`:6432`), not Postgres directly.
- **`pool_mode = transaction` requires `DB_SIMPLE=1` on the API** — server-side prepared statements are
  bound to a server connection that transaction-pooling reassigns, so postgres-js must run with
  `{ prepare:false, fetch_types:false }` (the `DB_SIMPLE` switch in `database.module.ts`). The app's
  per-request GUCs use `SET LOCAL` / `set_config(..., true)` (transaction-scoped) → pooling-safe.
- Sizing: keep `replicas × default_pool_size` under Postgres `max_connections` with headroom.

## 3. Saturation alerting (in-app, no external system)

`runtime-metrics.ts` logs a single alertable `event:"pool_saturation"` warning when in-flight transactions
cross `POOL_SATURATION_WARN_PCT` (default **80**) of `DB_POOL_MAX` (debounced with hysteresis). The count is
also exposed on `GET /api/jobs/ops-metrics` (`pool.saturation_events`, `pool.saturation_pct`,
`pool.peak_in_flight_tx`). Wire a page on a rising `saturation_events` / `pool.saturation_pct > 80`, plus
PgBouncer `SHOW POOLS` `cl_waiting` / avg-wait for the server-side view.

## 4. Load test (runnable)

`tools/cutover/src/loadtest.ts` (`pnpm --filter @ierp/cutover loadtest`) boots the app and drives bounded
concurrent load at `/healthz` (framework baseline) and `/readyz` (one DB round-trip), reporting
rps + p50/p95/p99. **Report-only** — absolute numbers depend on the backend (PGlite locally vs real
Postgres + PgBouncer in staging) and the runner; it tracks **relative regression** and is the procedure to
run against staging for a real capacity number (`LOAD_N` / `LOAD_C` to tune).

**Capacity baseline (fill in from a staging run):**

| Date | Env | Endpoint | rps | p95 | Notes |
|---|---|---|---|---|---|
| `<<date>>` | `<<staging>>` | `/readyz` | `<<rps>>` | `<<p95>>` | real PG + PgBouncer, N=`<<>>` C=`<<>>` |

## 5. Follow-ups
- Run the load test against staging and record the baseline above; re-run each release.
- Add a Prometheus exporter for PgBouncer (`SHOW POOLS`/`SHOW STATS`) for historical pool-pressure graphs.

## 6. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-06-30 | Platform / SRE | Pool model, PgBouncer config (transaction mode + `DB_SIMPLE`), saturation alert, load-test tool. |
