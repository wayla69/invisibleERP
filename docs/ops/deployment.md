# Ops — Deployment & Runtime Topology

> **Status:** v1.0 · **Date:** 2026-06-23 · **Owner:** Platform
> Phase A deliverable of `docs/11-next-upgrade-realworld-roadmap.md` (containerize + reproducible deploy).

## 1. Topology

```
            ┌──────────────┐        ┌──────────────┐        ┌──────────────────┐
  users ──▶ │  web (Next)  │ ─────▶ │  api (Nest)  │ ─────▶ │ PostgreSQL (RLS) │
            │  :3000       │  HTTPS │  :8000       │   TLS  │  managed         │
            └──────────────┘        └──────────────┘        └──────────────────┘
```

- **api** — NestJS/Fastify, stateless, horizontally scalable. RLS enforced in the DB
  (`apps/api/drizzle/0002_rls.sql`); connects as the least-privilege `ierp_app` role
  (`tools/ops/sql/prod-db-roles.sql`).
- **web** — Next.js 15 (`next start`), stateless. Talks to the API via `NEXT_PUBLIC_API_URL`.
- **db** — managed PostgreSQL 16. Provider automated backups + PITR ON; portable dumps via
  `tools/ops/pg-backup.sh` + `restore.sh` + `verify-restore.sh` (see `tools/ops/BACKUP-RUNBOOK.md`).

## 2. Two supported substrates

### A. Railway (primary) — `apps/api/railway.json`, `apps/web/railway.json`
**RAILPACK** build (Railway's current default); `api` runs **migrate + catalog-sync** via
**`preDeployCommand`** (`db:migrate && db:sync-catalog`) so the schema and the **permission catalog**
(permission keys + default role grants — idempotent `onConflictDoNothing`, nothing credential- or
tenant-creating, hence guardless) apply **once per release**, not per replica. The **full seed**
(`db:seed`: catalog + HQ tenant + the `admin` user with a forced first-login password change) is a
**deliberate first-boot step only**: it refuses `NODE_ENV=production` unless `ALLOW_PROD_SEED=1` and
requires `SEED_ADMIN_PASSWORD` when creating the admin (docs/27 R0-3) — run it once, manually, when
standing up a new environment. (History: the pipeline originally ran `db:seed` per deploy; after R0-3
landed its guard, every prod deploy failed at pre-deploy until the 2026-07-03 catalog-sync split.) Health checks: api `/`
(and now `/healthz`/`/readyz`), web `/login`. Node is pinned to **22** via `.node-version` / `.nvmrc` /
`engines.node`. **Do not use the NIXPACKS builder** — it bundles Corepack 0.24.1, which is incompatible
with pnpm 11.8.0 and crashes (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`) before install. Each service must
set its **config-as-code path** to its `railway.json` (monorepo: root directory stays `/` so the
workspace install + lockfile resolve).
First-deploy walkthrough (project + Postgres + the two services, env matrix, CORS/`NEXT_PUBLIC_API_URL`
build-order, CI deploy): **`docs/ops/railway-setup.md`**.
Onboarding **many customers on one shared deployment** — a private link (subdomain) + RLS-isolated data per
customer, vs a dedicated stack — with a per-customer cost model: **`docs/ops/multi-tenant-subdomain-runbook.md`**.

### B. Containers (portable / local prod-like) — Dockerfiles + `docker-compose.yml`
- `apps/api/Dockerfile`, `apps/web/Dockerfile` — multi-stage, non-root `node` user, `HEALTHCHECK`
  hitting `/healthz` (api) and `/login` (web). Mirror the Railway build commands.
- `docker-compose.yml` — Postgres + api + web for a local prod-like run (`docker compose up --build`).
  The api entrypoint applies migrations when `RUN_MIGRATIONS=1` (compose default; **do not** set this
  on multi-replica deploys — run migrations as a single release step instead).

```bash
docker compose up --build           # local full stack on :3000 / :8000 / :5432
```

### C. GitHub Codespaces (cloud, browser-accessible) — `.devcontainer/` + `docker-compose.codespaces.yml`
For a hands-on run with no local install: open the repo in a Codespace. `.devcontainer/devcontainer.json`
provisions docker-in-docker, brings the stack up on create, and forwards port **3000** to a
`https://*.github.dev` URL. Because the browser is **not** on `localhost` there, the Codespaces overlay
`docker-compose.codespaces.yml` builds web with `NEXT_PUBLIC_API_URL=""` and sets `API_PROXY_TARGET=http://api:8000`
so the web app makes **same-origin** `/api/*` calls that Next forwards to the api container — making :3000
self-contained (single port). The same overlay works for any single-port preview/tunnel.

```bash
# what the devcontainer runs (also usable for any cloud single-port preview):
docker compose -f docker-compose.yml -f docker-compose.codespaces.yml up --build
```
The opt-in proxy is gated behind `API_PROXY_TARGET` in `apps/web/next.config.mjs` — unset ⇒ no-op. It is
**also the recommended prod fix when the two origins can't share a cookie** (e.g. the auto-generated
`*.up.railway.app` URLs are each their own registrable domain on the Public Suffix List, so cookie auth
can't span them). In that case set the **web** service's `NEXT_PUBLIC_API_URL` to the **web's own** public
URL and `API_PROXY_TARGET` to the **api** URL, and redeploy web: the browser then makes same-origin
`/api/*` calls that Next forwards to the api, so the session cookie is first-party and login sticks — no
custom domain needed. (Only when web and API sit under a **shared custom domain** is the separate-origin
topology — `NEXT_PUBLIC_API_URL`=api URL + `AUTH_COOKIE_DOMAIN`=shared parent — preferable; see
`railway-setup.md` §4.)

## 3. Migrations on deploy
Hand-written SQL in `apps/api/drizzle/` applied by `drizzle-kit migrate` (`pnpm --filter @ierp/api db:migrate`).
Run exactly once per release (Railway `preDeployCommand`, or a dedicated release job in CI/CD). Never
apply schema by hand in prod (ITGC-CM-02). Prod **role/privilege** setup is separate and run once by a
DBA: `tools/ops/sql/prod-db-roles.sql` (NOT part of the migration chain — see that file's header).

## 4. Required env (prod)
The API **refuses to boot in production** without `DATABASE_URL`, `JWT_SECRET`, `APP_ENC_KEY`, and a PSP
webhook secret (`apps/api/src/common/env.validation.ts`, ITGC-AC-12). Full matrix + sourcing:
`docs/ops/secrets.md`. Observability env is recommended (warned if missing): `observability-incident.md`.

> **Separate-origin deploys (web ≠ api host) must also set `AUTH_COOKIE_DOMAIN`** (a shared parent domain
> like `.example.com`) so the session cookie is readable on the web origin — otherwise login succeeds but
> bounces straight back to `/login`. For web/api on *different registrable domains*, also set
> `AUTH_COOKIE_SAMESITE=None`. Same-origin deploys (§2C proxy) need neither. See `railway-setup.md` §4.

> **Multi-replica deploys (2+ API instances) must set `REALTIME_REDIS_URL`** (docs/27 R1-3 / AUD-ARC-03—
> Railway: add the Redis add-on and reference its URL). The SSE buses (live KDS `pos-scale`, live BI) are
> in-memory per process by default — fine for one node, but on 2+ replicas an event published on node A
> silently never reaches an SSE client on node B. With the URL set, `common/realtime-bus.ts` routes every
> publish through Redis pub/sub (single delivery path, no double-delivery on the publisher). Caveats: the
> `recent()` ring buffer stays per-process (a fresh node starts empty until events flow), and a Redis
> publish failure degrades to local-only delivery with a throttled `realtime_redis_publish_failed` ops
> alert (see `observability-incident.md`).

> **Multi-replica deploys should also set `CACHE_REDIS_URL`** (docs/27 R1-6 — same Redis add-on works).
> The BI/finance read caches (`common/ttl-cache.ts`, 30s TTL) are per-process by default — fine on one
> node, but on 2+ replicas each node recomputes every board and a tenant cache-bust only reaches the node
> that handled the request. With the URL set, `common/cache-remote.ts` upgrades the cache to a shared
> Redis read/write-through (busts propagate to every node). Unset = per-process, byte-identical to before
> the adapter existed. A Redis failure degrades to local compute with a throttled `cache_redis_degraded`
> ops alert — never a failed read.

> **Multi-replica deploys should also set `RATE_LIMIT_REDIS_URL`** (security review L-8 — the same Redis
> add-on works; falls back to `REALTIME_REDIS_URL`). The edge per-IP limiter (`common/edge.ts`,
> `@fastify/rate-limit`) and the public-API per-key limiter (`public-api.guard.ts`, `common/rate-limit-store.ts`)
> keep per-process counters by default, so on N replicas a client effectively gets N× its budget and a flood
> can spread across nodes. With the URL set, both share a Redis counter so limits hold fleet-wide (a Redis
> error degrades to per-process, never fails a request open). Also set **`TRUSTED_PROXY_HOPS`** to the number
> of reverse proxies in front of the API: without it Fastify's `req.ip` is the proxy's address, so the edge
> limiter buckets *every* client together — the same knob fixes the spoofable audit IP (L-12).

## 5. CI/CD
- `ci.yml` — build/typecheck/unit, integration harnesses, security (audit + gitleaks), CodeQL, web-e2e.
  Two queue-pressure guards against the ~20-concurrent-job account limit (both root-caused from the
  2026-07-10 freeze — 26 runs / ~2,000 jobs stuck `Queued`, 0 in progress):
  - **Per-ref `concurrency` group**: a new push to a PR **cancels** that PR's superseded run; on main
    the in-flight run finishes and GitHub keeps only the newest pending run (intermediate main pushes
    are auto-superseded by the tip run).
  - **Sharded harness matrix**: the ~89 PGlite harnesses run as **11 domain shards** (~5–11 harnesses
    per job, balanced by measured runtime to ~4–9 min each) instead of one job apiece, so a full CI
    run is ~18 jobs — it fits a single concurrency wave and stops re-paying ~40s of checkout/pnpm/dist
    setup ~90 times per run. Per-harness visibility is kept: each harness gets its own collapsible log
    group, a failure doesn't stop the rest of the shard, and every failed harness is listed at the end.
    Add a new harness to its domain shard in `ci.yml`; split a shard if it outgrows ~9 minutes.
    NB: branch-protection **required checks** now name the shards (`harnesses (pos)`, …) — update the
    protected-check list when shard names change.
- `deploy.yml` — approval-gated production deploy to Railway, pinned to the GitHub `production`
  Environment (required reviewers ⇒ deployer ≠ author, ITGC-CM-03). See `change-management.md`.
  - **Post-deploy smoke (ITGC-OP-04).** After both services deploy, the job hits the API's `/healthz`
    (liveness) **and** `/readyz` (readiness — proves the DB is reachable; a 503 is the exact
    migration/schema-broken signal the 2026-07-03 outage produced) and **fails the deploy** on either. This
    floor runs on **every** deploy: `PROD_API_URL` is resolved from the invisibleERP service's own
    `RAILWAY_PUBLIC_DOMAIN` (via `RAILWAY_TOKEN`) when `vars.PROD_API_URL` is unset, so there is no silent
    skip. Setting `secrets.SMOKE_USER` / `secrets.SMOKE_PASS` (a low-privilege `pos` account) on the
    `production` Environment adds authenticated-endpoint coverage on top; absent, only that authed layer is
    skipped (warning, non-blocking).
- **Railway healthcheck window** is `healthcheckTimeout: 300`s on both `apps/api/railway.json` and
  `apps/web/railway.json` — generous headroom for a cold start / DB-pool warm-up so a slow (not broken)
  boot is not marked failed. Bumped from 60s on 2026-07-03.
- **Scheduled workflows (external cron — the API has no in-process scheduler).** These run on GitHub's
  cron and authenticate as a service account, so configure their `vars.PROD_API_URL` + `secrets.SWEEP_USER`
  / `SWEEP_PASS` at the **repository** level (not the gated `production` Environment, or they'd wait on
  required reviewers and never run). Each no-ops with a warning until configured.
  - `loyalty-maintenance.yml` — daily points expiry + liability re-accrual (all tenants).
  - `bi-scheduler.yml` — daily `POST /api/bi/subscriptions/run-all-async`, firing every **due** report/action
    subscription (`ar_collections_dunning`, `gl_recurring_journals`, `gl_prepaid_amortize`,
    `lease_periodic_run`, `eam_pm_generate`, `ap_automatch_rerun`, …). Create a `daily` subscription of a
    type to opt that tenant in; nothing fires otherwise.
  - `ops-create-ap-rematch-sub.yml` (manual dispatch) — one-shot helper that creates the `ap_automatch_rerun`
    daily subscription via the API from a runner (idempotent), for when the in-app **Scheduled Reports** UI
    isn't convenient. Uses the same `SWEEP_USER`/`SWEEP_PASS` service account.

## 6. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.8 | 2026-07-10 | Platform | §5: `ci.yml` per-ref `concurrency` group (cancel superseded PR runs; main keeps in-flight + newest pending) — fixes the 2026-07-10 Actions queue freeze (26 runs / ~2,000 jobs backlogged, 0 in progress). |
| 1.9 | 2026-07-10 | Platform | §5: harness matrix sharded ~89 jobs → 11 domain shards (balanced by measured runtime; per-harness log groups + full-shard run-through on failure preserved) — a full CI run is now ~18 jobs and fits one ~20-job concurrency wave; branch-protection required checks must reference the shard names. |
| 1.0 | 2026-06-23 | Platform | Initial topology + Docker/compose + Railway + migration/deploy notes. |
| 1.1 | 2026-06-23 | Platform | Add Codespaces substrate (`.devcontainer/`, `docker-compose.codespaces.yml`) — single-port same-origin proxy for browser-accessible cloud runs. |
| 1.2 | 2026-06-23 | Platform | Link the Railway first-deploy runbook (`railway-setup.md`). |
| 1.3 | 2026-07-02 | Platform | §4: `REALTIME_REDIS_URL` requirement for multi-replica deploys — shared `realtime-bus.ts` (Redis pub/sub) behind both SSE buses (docs/27 R1-3). |
| 1.4 | 2026-07-03 | Platform | §2A: `preDeployCommand` split — `db:sync-catalog` (guardless idempotent permission-catalog sync, new `src/database/sync-catalog.ts`) replaces `db:seed` per release; full `db:seed` is now a gated **first-boot-only** manual step (R0-3 `ALLOW_PROD_SEED=1` + `SEED_ADMIN_PASSWORD`). Root cause of the post-R0-3 prod-deploy failures (seed guard fired inside the pipeline). |
| 1.7 | 2026-07-08 | Platform | §5: nightly cron now hits `run-all-async` (the PLATFORM-WIDE due sweep — `run-async` only ever swept the service account's own tenant, so other tenants' subscriptions never fired); optional in-process trigger `SCHEDULER_TICK_MS` (default off — external cron remains the default); scheduler heartbeat + stale alert (`scheduler_heartbeat_stale`, surfaced on `GET /api/jobs/ops-metrics`) closes docs/27 R1-5's silent-cron-death gap. |
| 1.6 | 2026-07-08 | Platform | §4: `CACHE_REDIS_URL` recommendation for multi-replica deploys — shared read-cache adapter (`cache-remote.ts`) behind the BI/finance `TtlCache` (docs/27 R1-6); default unset = per-process, unchanged. |
| 1.7 | 2026-07-08 | Security | §4: `RATE_LIMIT_REDIS_URL` + `TRUSTED_PROXY_HOPS` for multi-replica deploys (security review L-8) — shared rate-limit store (`rate-limit-store.ts`) behind the edge per-IP and public-API per-key limiters (default unset = per-process, unchanged); `trustProxy` so the edge limiter keys on the real client IP behind a proxy. |
| 1.5 | 2026-07-03 | Platform | §5: post-deploy smoke now runs a self-resolving liveness (`/healthz`) + **readiness (`/readyz`, DB-reachable)** floor on every deploy (no silent skip — `PROD_API_URL` falls back to the invisibleERP `RAILWAY_PUBLIC_DOMAIN`), authed coverage optional via `SMOKE_USER`/`SMOKE_PASS`; Railway `healthcheckTimeout` bumped 60s → 300s on both services. New scheduled workflow `bi-scheduler.yml` — the daily external trigger for the report/action subscription scheduler (`ap_automatch_rerun` et al.); the API has no in-process scheduler. |
| 1.3 | 2026-07-01 | Platform | Link the multi-tenant "link-per-customer" onboarding runbook (`multi-tenant-subdomain-runbook.md`) — shared-deployment subdomain model (RLS-isolated) vs dedicated, tenant provisioning, wildcard DNS/TLS + cookie/CORS, and per-customer cost model. |
