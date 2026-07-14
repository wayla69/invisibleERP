# Deploying the Marketing Intelligence Platform on Railway

This runbook stands up the three services + two add-ons. Config-as-code lives in the three
`railway.<service>.json` files; you point each Railway service at one of them.

> **What I (the assistant) can't do for you:** the actual Railway provisioning and minting the *real* ERP
> API key require your Railway account and an ERP admin login. This runbook + the committed configs make
> that a click-through. Everything up to it (code, Dockerfiles, config, runbook) is done.

## 0. Prerequisites
- A Railway account with this GitHub repo connected (or the Railway GitHub App installed).
- ERP admin access (a user holding the `users` permission) to mint the API key.
- The ERP's public base URL (e.g. `https://<your-erp>.up.railway.app`).

## 1. Create the project + add-ons
1. **New Project** → *Deploy from GitHub repo* → pick this repo.
2. Add **PostgreSQL**: *New → Database → PostgreSQL*. (This is the platform's own warehouse — separate from
   the ERP database.) It exposes `DATABASE_URL`.
3. Add **Redis**: *New → Database → Redis*. It exposes `REDIS_URL`.

## 2. Create the three services
For **each** service create a Railway service from this repo and set:
- **Root Directory:** `marketing-intelligence-platform` (so the Docker build context includes `shared/`).
- **Config-as-code path:** the matching file below.

| Railway service | Config path | Type | Public? |
|---|---|---|---|
| `ingestion-worker` | `railway.ingestion-worker.json` | Celery worker + beat | no |
| `analytics-engine` | `railway.analytics-engine.json` | Cron (daily `python run.py`) | no |
| `dashboard-ui` | `railway.dashboard-ui.json` | Web (Streamlit) | **yes** — enable a public domain |

The configs pin the Dockerfile, start command, restart policy, the analytics **cron schedule**
(`0 3 * * *` UTC — adjust for your timezone; it runs after the daily ERP sync), and the Streamlit
**health check** (`/_stcore/health`).

## 3. Mint the ERP API key (scope `analytics:read`)
The platform reads ERP data with a tenant-bound key. Two ways:

- **ERP Developer portal (recommended):** sign in to the ERP as an admin → **Developer** (`/developer`) →
  create a key named `marketing-intelligence` with scope **`analytics:read`**. Copy the `ierp_…` value
  (shown once).
- **API:** with an admin session token,
  ```bash
  curl -X POST "$ERP/api/platform/api-keys" \
    -H "Authorization: Bearer <admin-JWT>" -H "Content-Type: application/json" \
    -d '{"name":"marketing-intelligence","scopes":["analytics:read"]}'
  # → { "key": "ierp_…" }   (returned once)
  ```
The key is bound to that admin's tenant; the platform only ever sees that tenant's data (RLS-enforced).

## 4. Environment variables
Set these on each service (use Railway **reference variables** for the add-ons so they auto-wire):

**All three services**
| Var | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |

**`ingestion-worker`** (also)
| Var | Value |
|---|---|
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `ERP_API_URL` | `https://<your-erp-host>` |
| `ERP_API_KEY` | `ierp_…` (from step 3) |
| `SOCIAL_API_BASE_URL` | *(leave empty to use the built-in mock; set to a real vendor to go live)* |
| `SOCIAL_API_KEY` | *(vendor key, if any)* |
| `FETCH_INTERVAL_MIN` | `30` |
| `SYNC_WINDOW_DAYS` | `90` |
| `TZ` | `Asia/Bangkok` |

**`dashboard-ui`** — `PORT` is injected by Railway automatically; the start command already binds to it.
**`analytics-engine`** — needs only `DATABASE_URL` (set `MMM_OPTIMIZE=1` if you want the scipy adstock tuning).

See `.env.example` for the full list + defaults.

## 5. Deploy order & first run
1. Deploy **`ingestion-worker`** first. On boot it runs `ensure_schema()` (creates `staging`/`core`/
   `analytics`), then the beat schedule kicks: `fetch_social` (every 30 min) and `sync_erp` (daily 02:00).
2. Deploy **`analytics-engine`** — it runs on the cron; trigger a manual run once from Railway to populate
   `analytics.*` immediately.
3. Deploy **`dashboard-ui`** and open its public domain.

## 6. Smoke test
- `GET https://<dashboard-domain>/_stcore/health` → `ok`.
- In Railway, run `ingestion-worker` → *shell* → `python -c "from tasks.sync_erp import sync_erp_data; print(sync_erp_data.run())"` — should return non-zero `sales_daily` / `customer_facts` counts (proves the ERP key + `analytics:read` scope work).
- Run `analytics-engine` once, then load the dashboard — MMM channel ROI, RFM segments, TOWS should render.
- If `sync_erp` raises an auth/scope error, the key is missing `analytics:read` (re-mint per step 3).

## 7. Going live (later)
- Replace the mock social feed: set `SOCIAL_API_BASE_URL`/`SOCIAL_API_KEY` and adapt `SocialListeningClient.fetch()` response mapping to your vendor.
- Tune the analytics cron (`railway.analytics-engine.json` → `deploy.cronSchedule`) and the worker cadence (`FETCH_INTERVAL_MIN`).
