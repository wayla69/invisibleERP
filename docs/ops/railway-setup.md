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

   Recommended (external APM — Sentry errors + OTel tracing): `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`.
   These are **not required to boot** — the API always emits built-in signals (structured logs, `audit_log`,
   `/healthz`+`/readyz`, `ops-metrics`); their absence is a silent default. To **mandate** them as a
   fail-closed boot gate in an audited environment, set `REQUIRE_OBSERVABILITY_BACKENDS=1` (then boot refuses
   to start unless both are set or `ALLOW_NO_OBSERVABILITY=1` is set consciously). Optional:
   `ANTHROPIC_API_KEY` (AI falls back to rule-based if unset). Full matrix: `secrets.md`.

   **PDF rendering (optional, recommended for prod).** HTML→PDF (tax invoices/receipts/statements, tax
   reports, QR labels) is centralised in one renderer. By default it launches a **pooled in-process
   Chromium** (one browser reused across requests). To keep Chromium **out of the API process** entirely,
   run a small PDF microservice (accepts `POST { html, options }` → `application/pdf`) and set
   `PDF_SERVICE_URL` to it — the API then offloads every render and never spawns a browser. Tuning:
   `PDF_MAX_CONCURRENCY` (default 2, bounds in-process pages), `PDF_SERVICE_TIMEOUT_MS` (default 30000).
   If neither a service nor Chromium is available the API returns the document as **HTML** (graceful
   fallback) rather than failing.
3. **Settings → Networking → Generate Domain.** Note the api URL (e.g. `https://api-xxxx.up.railway.app`).
   Migrations + the permission-catalog sync run automatically on each deploy via the railway.json
   `preDeployCommand` (`db:migrate && db:sync-catalog`).
   Health checks hit `/` (also `/healthz` liveness, `/readyz` DB-readiness).
   **First boot only:** the full seed (HQ tenant + initial `admin`) is deliberate and gated (docs/27
   R0-3) — run it once against the new environment with `ALLOW_PROD_SEED=1` and `SEED_ADMIN_PASSWORD`
   set (e.g. a one-off `railway ssh`/run), then remove those variables. It never runs per deploy.

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
3. **Make the session cookie usable across the two origins (required, or login silently bounces).**
   The session lives in cookies the API sets (`ierp_token` httpOnly + `ierp_csrf` readable). By default
   they are **host-only / `SameSite=Lax`**, so a cookie set on the *api* origin is invisible to the *web*
   origin — login succeeds but the web app can't see the session and bounces straight back to `/login`.
   Pick the option that matches your domains:
   - **On the default `*.up.railway.app` URLs (recommended fix here): serve same-origin via the proxy.**
     Those auto-URLs are each their **own** registrable domain (Public Suffix List) — cross-site **and**
     unable to share a parent `Domain`, so cookie auth can't span them. Instead, on the **web** service set
     `NEXT_PUBLIC_API_URL`=the **web's own** URL and `API_PROXY_TARGET`=the **api** URL, then redeploy web.
     The browser now makes same-origin `/api/*` calls that Next forwards to the api ⇒ first-party cookie,
     login sticks. No custom domain, no api change. (Both vars are build-time ⇒ a redeploy/rebuild applies them.)
   - **With a shared custom domain — `app.example.com` + `api.example.com`:** keep the separate-origin
     topology and set the **api** service's **`AUTH_COOKIE_DOMAIN=.example.com`**. They are *same-site*, so
     `SameSite=Lax` still works; the web origin can read `ierp_csrf` and the api receives `ierp_token`.
     For web/api on *different* registrable domains, also set **`AUTH_COOKIE_SAMESITE=None`** (auto-adds
     `Secure`; HTTPS required). Redeploy **api** after setting these.

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
4. **(Optional) Authenticated post-deploy smoke.** The deploy job always runs a liveness+readiness smoke
   against the API (it self-resolves the URL from the invisibleERP `RAILWAY_PUBLIC_DOMAIN`, so nothing is
   required for that floor). To also exercise authenticated endpoints, add on the `production` Environment:
   `secrets.SMOKE_USER` / `secrets.SMOKE_PASS` — a **dedicated low-privilege `pos` account** (never an admin;
   create it once in the running app), and optionally `vars.PROD_API_URL` to pin the API base URL explicitly.
   Absent these, only the authed layer is skipped (warning), not the whole smoke.

## 7. Revision history
| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-06-23 | Platform | Initial Railway first-deploy runbook (monorepo config paths, env matrix, CORS/NEXT_PUBLIC build-order, CI deploy). |
| 1.1 | 2026-06-25 | Platform | §4 step 3 — make the session cookie usable across the two origins (else login bounces back to `/login`). On `*.up.railway.app` auto-URLs (public-suffix ⇒ can't share a cookie): serve **same-origin** via `API_PROXY_TARGET` + `NEXT_PUBLIC_API_URL`=web URL. With a **shared custom domain**: set api `AUTH_COOKIE_DOMAIN` (+ `AUTH_COOKIE_SAMESITE=None` for cross-registrable-domain). |
| 1.2 | 2026-07-03 | Platform | §6 step 4 — optional authenticated post-deploy smoke (`SMOKE_USER`/`SMOKE_PASS` low-priv `pos` account, optional `PROD_API_URL`); the liveness+readiness floor already runs unattended (self-resolves the API domain). |
