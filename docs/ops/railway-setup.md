# Ops — Railway setup runbook (first deploy)

> **Status:** v1.0 · **Date:** 2026-06-23 · **Owner:** Platform
> Companion to `deployment.md` §2.A. Click-by-click guide to stand up the project on Railway. Config-as-code
> already lives in the repo: `apps/api/railway.json`, `apps/web/railway.json` (NIXPACKS builds; the api
> applies migrations via `preDeployCommand`). This is a **monorepo**, so each service points at its own
> railway.json while building from the workspace root.

## 0. Topology on Railway
One project, three services: **Postgres** (plugin) → **api** (NestJS) → **web** (Next.js). web and api are
on **separate public origins**; the browser talks to the api via `NEXT_PUBLIC_API_URL`, and the api allows
the web origin via `CORS_ORIGINS`.

```
 browser ──▶ web (Next, public URL)  ──▶  api (Nest, public URL)  ──▶  Postgres (plugin)
            NEXT_PUBLIC_API_URL=api URL     CORS_ORIGINS=web URL        DATABASE_URL=${{Postgres.DATABASE_URL}}
```

## 1. Create the project + database
1. **railway.app → New Project → Deploy from GitHub repo →** `wayla69/invisibleERP` (pick the branch you
   want, e.g. `main` for production).
2. **New → Database → PostgreSQL.** Railway provisions it and exposes `${{Postgres.DATABASE_URL}}`.

## 2. The `api` service
1. Add a service from the repo (if not auto-created). **Settings → Build:**
   - **Config-as-code path:** `apps/api/railway.json`  ← the monorepo key. The build runs
     `pnpm install && pnpm --filter @ierp/shared build && pnpm --filter @ierp/api build` from the repo root.
   - **Root Directory:** leave at repo root (`/`) — the pnpm workspace + lockfile live there.
2. **Settings → Variables** (the four below are **boot-blocking** — the API refuses to start in prod without
   them, ITGC-AC-12):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference, not a literal) |
   | `JWT_SECRET` | a 32-byte hex secret — `openssl rand -hex 32` |
   | `APP_ENC_KEY` | a 32-byte hex secret — `openssl rand -hex 32` (⚠️ rotating later invalidates stored TOTP/webhook secrets) |
   | `PSP_WEBHOOK_SECRET` | `openssl rand -hex 24` |
   | `CORS_ORIGINS` | the **web** public URL (fill in after §4) |
   | `PORT` | `8000` |

   Recommended (warned-if-missing): `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`. Optional:
   `ANTHROPIC_API_KEY` (AI falls back to rule-based if unset). Full matrix: `secrets.md`.
3. **Settings → Networking → Generate Domain.** Note the api URL (e.g. `https://api-xxxx.up.railway.app`).
   Migrations run automatically on each deploy via the railway.json `preDeployCommand` (`db:migrate`).
   Health checks hit `/` (also `/healthz` liveness, `/readyz` DB-readiness).

## 3. The `web` service
1. Add a second service from the **same** repo. **Settings → Build:**
   - **Config-as-code path:** `apps/web/railway.json`
   - **Root Directory:** repo root (`/`).
2. **Settings → Variables:**

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | the **api** public URL from §2.3 |

   > ⚠️ `NEXT_PUBLIC_API_URL` is **baked into the bundle at build time**. Set it *before* the build, and
   > **redeploy web** whenever the api URL changes. Do **not** set `API_PROXY_TARGET` on Railway — the
   > same-origin proxy is for single-port local/preview only and must stay off in prod.
3. **Generate Domain** for web. Note the web URL.

## 4. Wire the two origins together
1. Set the api's `CORS_ORIGINS` to the **web** URL (comma-separated if more than one; never `*`).
2. Redeploy **api** (CORS change) and **web** (so the baked `NEXT_PUBLIC_API_URL` is correct).

## 5. First login
Open the **web** URL → log in with the seeded admin (`admin` / `admin123`) → you're forced to set a new
password (first-login control). Then provision your real tenant via signup or admin.

## 6. (Optional) Automated, approval-gated deploys
`.github/workflows/deploy.yml` deploys both services on push to `main`, gated behind the GitHub
**`production`** Environment (required reviewer ⇒ deployer ≠ author, ITGC-CM-03). To enable:
1. Create a **Railway project token** and add it as secret **`RAILWAY_TOKEN`** on the GitHub `production`
   Environment (Settings → Environments → production → Secrets).
2. Add required reviewers to that Environment.
3. The workflow runs `railway up --service api` then `--service web`. Service names must be exactly
   `api` and `web`.

## 7. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-06-23 | Platform | Initial Railway first-deploy runbook (monorepo config paths, env matrix, CORS/NEXT_PUBLIC build-order, CI deploy). |
