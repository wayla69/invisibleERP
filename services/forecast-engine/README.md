# forecast-engine — SCM planning compute service (docs/54)

Stateless FastAPI service that turns POS demand history into **probabilistic forecasts** (Prophet /
Croston–SBA / bootstrap) and those forecasts into **perishable-aware order plans** (distribution-free
newsvendor / remaining-life SAA MILP via PuLP+CBC).

It holds **no database, no tenant identifiers, and no PII**. The NestJS API (`apps/api`,
`modules/scm-planning`) extracts everything under tenant RLS, calls this engine, validates the
response against the shared contract, and persists the result. The maths lives in
[`docs/54-dynamic-scm-forecasting-plan.md`](../../docs/54-dynamic-scm-forecasting-plan.md) §1.

## Contract

`packages/shared/src/scm-engine.ts` (zod) is the **source of truth**; `app/contracts.py` (pydantic)
mirrors it. The JSON fixtures in `tests/fixtures/` are parsed by BOTH `pytest` and
`apps/api/test/scm-contract.test.ts`, so drift fails one side's CI.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /healthz` | liveness + engine/contract version |
| `GET /readyz` | proves CBC solves and reports Prophet availability (503 if the solver is broken) |
| `POST /v1/forecast` | series → K×H demand **sample paths** + quantiles + backtest WAPE |
| `POST /v1/optimize` | ingredient demand paths + FEFO stock → order plan, order-up-to, safety stock |

Auth on business routes: HMAC-SHA256 over `` `${unixSeconds}.${rawBody}` `` in
`x-engine-signature` (bare hex or `sha256=` prefixed) with `x-engine-timestamp`; 300 s window
(`SCM_ENGINE_TOLERANCE_SEC`). Fail-closed: **no `SCM_ENGINE_SECRET` ⇒ 503 on every business route.**
`x-engine-idempotency` makes an API retry return the original result instead of re-solving.

## Env

| Var | Default | Meaning |
|---|---|---|
| `SCM_ENGINE_SECRET` | — | **required**; shared secret with the API |
| `SCM_ENGINE_TOLERANCE_SEC` | `300` | signature freshness window |
| `ENGINE_WORKERS` | `min(8, cpu)` | thread-pool width for per-series/per-item fan-out |
| `PORT` / `UVICORN_WORKERS` | `8000` / `2` | served port and process count |

## Local development

```bash
cd services/forecast-engine
pip install -e ".[dev]"
pytest                                    # prophet-dependent cases skip when the wheel is absent
SCM_ENGINE_SECRET=dev uvicorn app.main:app --reload --port 8000
```

Then point the API at it: `SCM_ENGINE_URL=http://127.0.0.1:8000`, `SCM_ENGINE_SECRET=dev`.
With either unset the API runs its in-process fallback planner and never calls out.

This directory is intentionally **outside the pnpm workspace** (`apps/* packages/* tools/*`), so
`pnpm -r` never tries to build it.
