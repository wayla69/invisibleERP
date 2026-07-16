# Marketing Intelligence Platform

A standalone data-science platform that turns ERP transactions + social-listening data into three decision
models — **Marketing Mix Modeling (MMM)**, **Sentiment-Weighted RFM**, and a **TOWS** strategy matrix — and
surfaces them to the marketing team in a Streamlit dashboard.

It is **separate from the ERP** and integrates with it **only over the ERP's public HTTP API** (never a
shared database), consistent with the ERP's loose-coupling architecture.

```
Social APIs ──▶ ingestion-worker ──▶  ┌──────── Postgres DW ────────┐ ──▶ analytics-engine ──▶ dashboard-ui
ERP /api/v1 ──▶ (Celery + Redis)      │ staging → core → analytics  │      (MMM · RFM · TOWS)     (Streamlit)
                                      └─────────────────────────────┘
```

## Services (Railway)

| Service | Type | Public | Start command |
|---|---|---|---|
| PostgreSQL | add-on | no | — (data warehouse) |
| Redis | add-on | no | — (Celery broker) |
| `ingestion-worker` | worker | no | `celery -A main worker --beat --loglevel=info --concurrency=2` |
| `analytics-engine` | cron/job | no | `python run.py` (schedule daily, after the sync) |
| `dashboard-ui` | web | **yes** | `streamlit run app.py --server.port $PORT --server.address 0.0.0.0` |

Each service has its own `Dockerfile` (build context = repo root, so `shared/` is included).

**Deploying?** See **[`DEPLOY.md`](./DEPLOY.md)** — a step-by-step Railway runbook (add-ons, per-service
config-as-code `railway.*.json`, env vars, minting the `analytics:read` ERP key, and a smoke test).

## ERP integration (the only coupling)

1. In the ERP, a tenant admin mints an API key with the `analytics:read` scope:
   `POST /api/platform/api-keys  { "name": "marketing-intelligence", "scopes": ["analytics:read"] }`.
2. Set `ERP_API_URL` + `ERP_API_KEY` (`ierp_…`). The key is **tenant-bound** — the platform only ever sees
   that tenant's data (RLS-enforced), and requests are per-key rate-limited.
3. The worker's `sync_erp` task pulls:
   - `GET /api/v1/sales/daily` → `staging.erp_sales_daily` (MMM revenue target)
   - `GET /api/v1/customers/transactions` → `staging.erp_customer_facts` (RFM base)

Read-only today; results stay in this platform's warehouse. (A future `analytics:write` push-back to the ERP
is designed for but out of scope.)

## The models (`services/analytics-engine`)

- **`mmm_model.py`** — Geometric Adstock (carry-over) → Hill/Log Saturation (diminishing returns) → **Ridge
  Regression** (handles multicollinearity among social variables) → per-channel Contribution % and ROI.
  Optional `scipy` adstock optimization (`MMM_OPTIMIZE=1`). `simulate()` powers the budget experiment page.
- **`rfm_model.py`** — Recency/Frequency/Monetary via `pandas.qcut`, a **sentiment multiplier
  `1 + 0.5·sentiment`**, and actionable segments (Loyal Promoters / At Risk VIPs / Churn Risk / …).
- **`tows_analyzer.py`** — maps internal (MMM/RFM) × external (sentiment) into SO/ST/WO/WT recommendations.
- **`run.py`** — orchestrates all three and writes the `analytics` schema.

## Data warehouse (`shared/schema.sql`)

`staging` (raw social + ERP feeds) → `core` (cleaned sentiment, customer sentiment) → `analytics`
(`mmm_runs`/`mmm_results`, `customer_rfm_segments`, `tows_matrix`). Created idempotently by
`shared.db_connection.ensure_schema()` on boot.

## Local development

```bash
cp .env.example .env          # fill ERP_API_URL / ERP_API_KEY (or leave social mock on)
docker compose up --build     # postgres + redis + all 3 services
# dashboard → http://localhost:8501
```

Run pieces directly (with a local Postgres + `DATABASE_URL` set):

```bash
pip install -r services/analytics-engine/requirements.txt
python -c "from shared import ensure_schema; ensure_schema()"
python services/analytics-engine/run.py            # run the models
pytest services/analytics-engine/test_engines.py   # unit-test the MMM + RFM math
```

## Configuration

See `.env.example`. Key vars: `DATABASE_URL`, `REDIS_URL`, `ERP_API_URL`, `ERP_API_KEY`,
`SOCIAL_API_BASE_URL` (unset ⇒ built-in mock), `FETCH_INTERVAL_MIN`, `SYNC_WINDOW_DAYS`, `MMM_OPTIMIZE`.

## Security posture

Secrets only from env; parameterized SQL everywhere; pooled DB connections (`pool_pre_ping`); explicit error
handling + structured logging (no silent excepts); outbound HTTP has retry + 429 back-off; Streamlit renders
dynamic text through its text APIs (no raw-HTML injection). The ERP key is least-privilege (`analytics:read`)
and tenant-scoped.
