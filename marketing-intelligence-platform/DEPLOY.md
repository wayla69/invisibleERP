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
For **each** service create a Railway service from this repo and set both fields below **in this order**:

1. > ⚠️ **Root Directory FIRST — this is the #1 cause of failed deploys.** Set it to
   > `marketing-intelligence-platform` (Service → **Settings → Source → Root Directory**). Every service's
   > Dockerfile does `COPY shared /app/shared`, so the Docker **build context must be this folder** — without
   > the Root Directory, the build context is the repo root, `shared/` isn't in it, and the build dies at
   > `COPY shared` (see §8). It ALSO anchors where Railway looks for the config file (next step).
2. **Config-as-code path:** the matching file below — a **bare filename** (Service → **Settings →
   Config-as-code**). Because the path resolves **relative to the Root Directory**, do **NOT** prefix it with
   `marketing-intelligence-platform/`. (If you set the config path before the Root Directory, Railway looks
   for it at the repo root and reports `service config ... not found` — see §8.)

| Railway service | Config path (bare filename) | Type | Public? |
|---|---|---|---|
| `ingestion-worker` | `railway.ingestion-worker.json` | Celery worker + beat | no |
| `analytics-engine` | `railway.analytics-engine.json` | Cron (daily `python run.py`) | no |
| `dashboard-ui` | `railway.dashboard-ui.json` | Web (Streamlit) | **yes** — enable a public domain |

The configs pin the Dockerfile, start command, restart policy, the analytics **cron schedule**
(`0 3 * * *` UTC — adjust for your timezone; it runs after the daily ERP sync), and the Streamlit
**health check** (`/_stcore/health`).

**Verify the Root Directory took:** in the build log you should see `COPY shared /app/shared` succeed. If you
see `"/shared": not found` (or the deploy never reaches the build step and says the config isn't found), the
Root Directory isn't set on that service — fix it and redeploy.

## 3. Mint the ERP API key (scope `analytics:read`)
The platform reads ERP data with a **tenant-bound** key. Minting is via the **API** — the `/developer`
web page only *lists/manages* existing keys (and shows the scope catalog); it has no "create key" button.
You need an ERP admin (a user holding the `users` permission — a tenant Admin does).

```bash
ERP="https://<your-erp-host>"

# 1) Log in as admin → get a JWT
TOKEN=$(curl -s -X POST "$ERP/api/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"<admin-username>","password":"<admin-password>"}' | jq -r .token)

# 2) Mint the key (scope analytics:read). Add "ttl_days": 365 to auto-expire.
curl -s -X POST "$ERP/api/platform/api-keys" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"marketing-intelligence","scopes":["analytics:read"]}'
# → {"id":..,"name":"marketing-intelligence","prefix":"ierp_xxxxxxx","scopes":["analytics:read"],
#    "expires_at":null,"key":"ierp_<32 hex>"}   ← the `key` is shown ONCE. Copy it now.
```

**Verify the key + scope before touching Railway:**
```bash
KEY="ierp_..."
curl -s "$ERP/api/v1/me" -H "Authorization: Bearer $KEY"
# → {"principal":"apikey:ierp_xxxxxxx","tenant_id":<n>,"scopes":["analytics:read"],"version":"v1"}
curl -s "$ERP/api/v1/sales/daily?from=2026-01-01&to=2026-01-31" -H "Authorization: Bearer $KEY"
# → 200 {"window":{...},"group_by":"day","data":[...]}
# 403 INSUFFICIENT_SCOPE → key lacks analytics:read;  401 → bad/typo'd key.
```
The key is bound to the minting admin's tenant; the platform only ever sees that tenant's data (RLS).
Optional: confirm the scope catalog + your new key row at **`/developer`** (needs the `users` permission).

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

## 8. Troubleshooting

**Almost every first-deploy failure is a missing/incorrect Root Directory (§2).** The symptom differs by how
the config path was entered, but the fix is the same on all three services: set **Root Directory =
`marketing-intelligence-platform`**, keep the config path a **bare filename**, redeploy.

| Deploy error | Cause | Fix |
|---|---|---|
| `service config at 'railway.<svc>.json' not found` (fails at *Initialization → Snapshot code*) | Root Directory not set, so Railway looks for the config at the **repo root** instead of inside `marketing-intelligence-platform/` | Set Root Directory = `marketing-intelligence-platform`; keep config path the bare `railway.<svc>.json` (no folder prefix); redeploy |
| Build fails at *Build → Build image*, log shows `COPY shared` / `"/shared": not found` | Root Directory not set, so the Docker **build context is the repo root** and `shared/` isn't in it | Same fix — set the Root Directory; the build context becomes `marketing-intelligence-platform/`, which contains `shared/` |
| Config still `not found` **after** setting Root Directory | Rare Railway path-resolution quirk | Either set the config path to the full `marketing-intelligence-platform/railway.<svc>.json`, **or** clear the config path and set it in the UI instead: Builder = **Dockerfile**, Dockerfile Path = `services/<svc>/Dockerfile`, Custom Start Command from the config's `deploy.startCommand` (for `analytics-engine` also set the **Cron Schedule** `0 3 * * *`; for `dashboard-ui` also set Healthcheck Path `/_stcore/health`) |
| `dashboard-ui` deploys but the domain 502s / health check fails | Streamlit not bound to `$PORT` | The config's start command already binds `--server.port $PORT --server.address 0.0.0.0`; make sure you didn't override the start command with a hardcoded port |
| `sync_erp` raises an auth/scope error (§6) | ERP key missing the `analytics:read` scope, or `ERP_API_URL`/`ERP_API_KEY` unset on `ingestion-worker` | Re-mint the key per §3 (verify with `GET /api/v1/me`), re-set the two env vars |

**Confirmation the Root Directory is correct:** the build log reaches the build step and shows
`COPY shared /app/shared` succeeding.
