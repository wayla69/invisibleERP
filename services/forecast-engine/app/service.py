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
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from .contracts import (
    CONTRACT_VERSION,
    EngineItemError,
    ForecastRequest,
    ForecastResponse,
    OptimizeItem,
    OptimizeNetworkRequest,
    OptimizeNetworkResponse,
    OptimizeRequest,
    OptimizeResponse,
    PoolingReport,
)
from .forecasting import forecast_series
from .network import NetworkFailure, run_optimize_network as _run_optimize_network
from .optimization import EngineItemFailure, solve_item, solve_joint, sample_lead_times, _validated_scenarios
from .reconcile import ReconcileError, reconcile

CACHE_TTL_S = 900
CACHE_MAX = 64


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
        with self._lock:
            if len(self._data) >= self._max:
                oldest = min(self._data.items(), key=lambda kv: kv[1][0])[0]
                self._data.pop(oldest, None)
            self._data[key] = (time.time(), value)


cache = ResultCache()


def run_forecast(req: ForecastRequest) -> ForecastResponse:
    closures = set(req.closures)
    results, errors = [], []

    def one(s):
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
        )

    with ThreadPoolExecutor(max_workers=_workers()) as pool:
        for s, fut in [(s, pool.submit(one, s)) for s in req.series]:
            try:
                results.append(fut.result())
            except Exception as exc:  # noqa: BLE001 — one bad series never fails the batch
                code = getattr(exc, "code", "MODEL_ERROR")
                errors.append(EngineItemError(ref=s.series_id, code=code, message=str(exc) or code))
    order = {s.series_id: i for i, s in enumerate(req.series)}
    results.sort(key=lambda r: order.get(r.series_id, 0))

    # docs/58 C2 — coherent hierarchical reconciliation (post-processing over the base results).
    reconciled = []
    if req.reconciliation is not None and req.reconciliation.method != "none":
        try:
            reconciled = reconcile(
                req.reconciliation, {r.series_id: r for r in results}, req.quantiles
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
