"""Request orchestration: per-series/per-item fan-out, determinism, and the idempotency cache.

Concurrency: Prophet (cmdstan) and CBC both run as CHILD PROCESSES, so a thread pool scales past
the GIL — the interpreter is idle while the solver works. Pool size is bounded by ENGINE_WORKERS
(default = cpu_count, capped at 8).

Determinism: each unit's RNG is seeded from sha256(request_id + ref), so the same request replays
byte-identically no matter which thread runs it — this is what makes the API's retry safe and the
harness stable.

Idempotency: responses are cached under the caller's X-Engine-Idempotency key (TTL 15 min), so an
API-side retry after a timeout returns the ORIGINAL result instead of re-solving.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from .contracts import (
    CONTRACT_VERSION,
    DemandPoint,
    EngineItemError,
    ForecastRequest,
    ForecastResponse,
    OptimizeItem,
    OptimizeNetworkRequest,
    OptimizeNetworkResponse,
    OptimizeRequest,
    OptimizeResponse,
    PoolingReport,
    SeriesInput,
)
from .forecasting import forecast_series
from .network import NetworkFailure, run_optimize_network as _run_optimize_network
from .optimization import EngineItemFailure, solve_item, solve_joint, sample_lead_times, _validated_scenarios
from .reconcile import ReconcileError, aggregate_specs, reconcile

CACHE_TTL_S = 900
CACHE_MAX = 64

# docs/59 D3 — shared result cache across N stateless replicas. Mirrors common/rate-limit-store.ts's
# FAIL-OPEN shape: a lazily-built single connection, and any error (no package / bad URL / Redis down)
# degrades to the per-process cache. Unset SCM_ENGINE_REDIS_URL (or REALTIME_REDIS_URL) ⇒ single-node
# behaviour unchanged (CI / PGlite need no Redis). The idempotency key already rides every request, so a
# retry landing on a DIFFERENT replica now returns the original solve instead of recomputing.
_ENGINE_CACHE_TTL_S = float(os.getenv("SCM_ENGINE_CACHE_TTL_S") or CACHE_TTL_S)
_redis_client: object = "unset"  # sentinel until first use (lazy — import never touches the network)


def _engine_redis():
    global _redis_client
    if _redis_client != "unset":
        return _redis_client
    url = (os.getenv("SCM_ENGINE_REDIS_URL") or os.getenv("REALTIME_REDIS_URL") or "").strip()
    if not url:
        _redis_client = None
        return None
    try:
        import redis  # lazy — importing this module must not require the redis package

        _redis_client = redis.Redis.from_url(
            url, socket_connect_timeout=1, socket_timeout=1, retry_on_timeout=False
        )
    except Exception:  # noqa: BLE001 — no package / bad URL ⇒ degrade to the per-process cache
        _redis_client = None
    return _redis_client


def _workers() -> int:
    env = os.getenv("ENGINE_WORKERS")
    if env and env.isdigit() and int(env) > 0:
        return int(env)
    return max(1, min(8, os.cpu_count() or 2))


def seeded_rng(request_id: str, ref: str) -> np.random.Generator:
    digest = hashlib.sha256(f"{request_id}|{ref}".encode()).digest()
    return np.random.default_rng(int.from_bytes(digest[:8], "big"))


class ResultCache:
    """Tiny TTL/LRU cache keyed by (idempotency key, path). Bounded — never a memory leak."""

    def __init__(self, ttl: float = CACHE_TTL_S, maxsize: int = CACHE_MAX):
        self._ttl, self._max = ttl, maxsize
        self._data: dict[str, tuple[float, object]] = {}
        self._lock = threading.Lock()

    def get(self, key: str | None):
        if not key:
            return None
        # D3: shared Redis first (a hit here serves a retry that landed on another replica), fail-open.
        r = _engine_redis()
        if r is not None:
            try:
                raw = r.get(f"scmeng:{key}")
                if raw is not None:
                    return json.loads(raw)
            except Exception:  # noqa: BLE001 — Redis unavailable ⇒ fall through to the per-process cache
                pass
        with self._lock:
            hit = self._data.get(key)
            if not hit:
                return None
            ts, value = hit
            if time.time() - ts > self._ttl:
                self._data.pop(key, None)
                return None
            return value

    def put(self, key: str | None, value: object) -> None:
        if not key:
            return
        # D3: write-through to Redis (best-effort, fail-open) AND the per-process cache.
        r = _engine_redis()
        if r is not None:
            try:
                r.set(f"scmeng:{key}", json.dumps(value), px=int(_ENGINE_CACHE_TTL_S * 1000))
            except Exception:  # noqa: BLE001 — Redis unavailable ⇒ still cache in-process below
                pass
        with self._lock:
            if len(self._data) >= self._max:
                oldest = min(self._data.items(), key=lambda kv: kv[1][0])[0]
                self._data.pop(oldest, None)
            self._data[key] = (time.time(), value)


cache = ResultCache(ttl=_ENGINE_CACHE_TTL_S)


def _forecast_aggregates(req: ForecastRequest, by_series: dict) -> dict:
    """docs/58 C3 — forecast each aggregate hierarchy node's summed leaf history INDEPENDENTLY, so MinT
    has a genuine aggregate signal to blend (without it MinT ≡ bottom-up). The aggregate history is the
    per-day sum of its descendant leaves' history; it is forecast with the same base pipeline (no
    per-series promo/price regressors — those are leaf-level), seeded from the node_id for determinism.
    A leaf whose series failed to forecast (absent from `by_series`) is skipped for that aggregate.
    Returns {node_id: ForecastSeriesResult}; a failed aggregate is omitted (reconcile then falls back to
    the coherent leaf sum for it)."""
    series_by_id = {s.series_id: s for s in req.series}
    out: dict = {}
    for node_id, leaf_sids in aggregate_specs(req.reconciliation):
        by_ds: dict[str, float] = {}
        for sid in leaf_sids:
            src = series_by_id.get(sid)
            if src is None or sid not in by_series:
                continue  # a leaf that never forecast contributes nothing to this aggregate's history
            for pt in src.history:
                by_ds[pt.ds] = by_ds.get(pt.ds, 0.0) + pt.y
        if not by_ds:
            continue
        agg = SeriesInput(
            series_id=f"__agg__{node_id}",
            history=[DemandPoint(ds=ds, y=y) for ds, y in sorted(by_ds.items())],
            class_hint="auto",
        )
        try:
            res = forecast_series(
                series=agg,
                holidays=req.holidays,
                closures=set(req.closures),
                horizon=req.horizon_days,
                k=req.scenario_count,
                quantiles=req.quantiles,
                payday_regressor=req.payday_regressor,
                promo_regressor=False,  # aggregate history carries no per-series promo/price regressor
                price_regressor=False,
                rng=seeded_rng(req.request_id, f"__agg__{node_id}"),
                donors=None,
            )
            out[node_id] = res
        except Exception:  # noqa: BLE001 — a failed aggregate forecast ⇒ reconcile uses the coherent leaf sum
            continue
    return out


def run_forecast(req: ForecastRequest) -> ForecastResponse:
    closures = set(req.closures)
    results, errors = [], []

    def one(s, donors=None):
        return forecast_series(
            series=s,
            holidays=req.holidays,
            closures=closures,
            horizon=req.horizon_days,
            k=req.scenario_count,
            quantiles=req.quantiles,
            payday_regressor=req.payday_regressor,
            promo_regressor=req.promo_regressor,
            price_regressor=req.price_regressor,
            rng=seeded_rng(req.request_id, s.series_id),
            donors=donors,
        )

    # docs/56 A4 — two-phase fan-out so an analog (zero-history) series can borrow its donors' shape:
    # forecast the NON-analog series first (they are the donor pool), then the analog series with a
    # {series_id: result} map. Pure pre-pass — base-series results and the per-series seed are unchanged,
    # so a request with no `analog_of` behaves byte-identically to before.
    base_series = [s for s in req.series if not s.analog_of]
    analog_series = [s for s in req.series if s.analog_of]
    donors: dict = {}

    def _run(batch, donors_map):
        with ThreadPoolExecutor(max_workers=_workers()) as pool:
            for s, fut in [(s, pool.submit(one, s, donors_map)) for s in batch]:
                try:
                    r = fut.result()
                    results.append(r)
                    donors[r.series_id] = r
                except Exception as exc:  # noqa: BLE001 — one bad series never fails the batch
                    code = getattr(exc, "code", "MODEL_ERROR")
                    errors.append(EngineItemError(ref=s.series_id, code=code, message=str(exc) or code))

    _run(base_series, None)
    if analog_series:
        _run(analog_series, donors)
    order = {s.series_id: i for i, s in enumerate(req.series)}
    results.sort(key=lambda r: order.get(r.series_id, 0))

    # docs/58 C2/C3/C4 — coherent hierarchical reconciliation (post-processing over the base results).
    reconciled = []
    if req.reconciliation is not None and req.reconciliation.method != "none":
        by_series = {r.series_id: r for r in results}
        try:
            # C3: MinT only differs from bottom-up when the aggregate nodes carry INDEPENDENT base
            # forecasts. Forecast each aggregate node's summed leaf history independently here (same
            # base pipeline, deterministic per-node seed) and hand them to reconcile as agg_base_by_node.
            agg_base = (
                _forecast_aggregates(req, by_series)
                if req.reconciliation.method == "mint"
                else None
            )
            reconciled = reconcile(
                req.reconciliation, by_series, req.quantiles, agg_base_by_node=agg_base
            )
        except ReconcileError as exc:
            errors.append(EngineItemError(ref="reconciliation", code=exc.code, message=str(exc)))
        except Exception as exc:  # noqa: BLE001 — reconciliation must never fail the base forecast
            errors.append(EngineItemError(ref="reconciliation", code="RECONCILE_ERROR", message=str(exc)))

    return ForecastResponse(
        contract_version=CONTRACT_VERSION,
        request_id=req.request_id,
        results=results,
        reconciled=reconciled,
        errors=errors,
    )


def _joint_inputs(req: OptimizeRequest, items: list[OptimizeItem]):
    demands, leads = [], []
    for item in items:
        d = _validated_scenarios(item, req.horizon_days)
        demands.append(d)
        leads.append(
            sample_lead_times(
                item.lead_time.mean_days,
                item.lead_time.std_days,
                d.shape[0],
                seeded_rng(req.request_id, item.item_code),
            )
        )
    return demands, leads


def run_optimize(req: OptimizeRequest) -> OptimizeResponse:
    start = dt.date.fromisoformat(req.start_ds)
    budget_s = max(1.0, req.time_budget_ms / 1000.0)
    plans, errors = [], []

    if req.joint and (req.joint.budget is not None or req.joint.storage_capacity is not None):
        # Joint constraints couple items — one model, one solve, one shared time budget.
        try:
            demands, leads = _joint_inputs(req, req.items)
            plans = solve_joint(
                req.items,
                demands,
                leads,
                start,
                req.horizon_days,
                req.joint,
                budget_s,
                seeded_rng(req.request_id, "joint"),
            )
        except EngineItemFailure as exc:
            errors.append(EngineItemError(ref="joint", code=exc.code, message=exc.message))
        except Exception as exc:  # noqa: BLE001
            errors.append(EngineItemError(ref="joint", code="SOLVER_ERROR", message=str(exc)))
        return OptimizeResponse(
            contract_version=CONTRACT_VERSION, request_id=req.request_id, plans=plans, errors=errors
        )

    per_item_budget = max(1.0, budget_s / max(1, len(req.items)) * _workers())

    def one(item: OptimizeItem):
        return solve_item(
            item, start, req.horizon_days, per_item_budget, seeded_rng(req.request_id, item.item_code)
        )

    with ThreadPoolExecutor(max_workers=_workers()) as pool:
        for item, fut in [(i, pool.submit(one, i)) for i in req.items]:
            try:
                plans.append(fut.result())
            except EngineItemFailure as exc:
                errors.append(EngineItemError(ref=item.item_code, code=exc.code, message=exc.message))
            except Exception as exc:  # noqa: BLE001
                errors.append(
                    EngineItemError(ref=item.item_code, code="SOLVER_ERROR", message=str(exc))
                )
    order = {i.item_code: n for n, i in enumerate(req.items)}
    plans.sort(key=lambda p: order.get(p.item_code, 0))
    return OptimizeResponse(
        contract_version=CONTRACT_VERSION, request_id=req.request_id, plans=plans, errors=errors
    )


def run_optimize_network(req: OptimizeNetworkRequest) -> OptimizeNetworkResponse:
    """docs/57 Track B (B2) — two-echelon MEIO. A topology-level failure returns a response with an
    error item + an empty pooling report, mirroring how a bad item never fails the /v1/optimize batch."""
    try:
        return _run_optimize_network(req)
    except NetworkFailure as exc:
        return OptimizeNetworkResponse(
            contract_version=CONTRACT_VERSION, request_id=req.request_id, node_plans=[], allocations=[],
            pooling=PoolingReport(independent_safety_units=0.0, pooled_safety_units=0.0, pooling_benefit_pct=0.0),
            errors=[EngineItemError(ref=req.item_code, code=exc.code, message=exc.message)],
        )
    except Exception as exc:  # noqa: BLE001 — never 500 the caller; surface as an error item
        return OptimizeNetworkResponse(
            contract_version=CONTRACT_VERSION, request_id=req.request_id, node_plans=[], allocations=[],
            pooling=PoolingReport(independent_safety_units=0.0, pooled_safety_units=0.0, pooling_benefit_pct=0.0),
            errors=[EngineItemError(ref=req.item_code, code="NETWORK_ERROR", message=str(exc))],
        )
