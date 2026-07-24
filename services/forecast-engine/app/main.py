"""FastAPI surface for the SCM forecast/optimization engine (docs/54 Part 3).

Security posture: the ONLY caller is the Invisible ERP API over private networking, authenticated
by HMAC-SHA256 over `${unixSeconds}.${rawBody}` (mirrors common/webhook-auth.ts). Fail-closed —
with no SCM_ENGINE_SECRET set the service answers 503 to every business route, so a
misconfigured deploy cannot silently accept unsigned traffic. No DB, no tenant ids, no PII.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from . import ENGINE_VERSION
from .contracts import CONTRACT_VERSION, ForecastRequest, OptimizeNetworkRequest, OptimizeRequest
from .optimization import solver_selftest
from .service import cache, run_forecast, run_optimize, run_optimize_network

TOLERANCE_S = int(os.getenv("SCM_ENGINE_TOLERANCE_SEC", "300"))
HDR_TS = "x-engine-timestamp"
HDR_SIG = "x-engine-signature"
HDR_IDEM = "x-engine-idempotency"
HDR_VERSION = "x-engine-version"

app = FastAPI(title="Invisible ERP forecast-engine", version=ENGINE_VERSION)


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def _secret() -> bytes | None:
    raw = os.getenv("SCM_ENGINE_SECRET")
    return raw.encode() if raw else None


def _verify(secret: bytes, ts: str | None, sig: str | None, body: bytes) -> bool:
    if not ts or not sig or not ts.isdigit():
        return False
    if abs(time.time() - int(ts)) > TOLERANCE_S:  # replay window
        return False
    expected = hmac.new(secret, f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    got = sig[7:] if sig.startswith("sha256=") else sig
    return hmac.compare_digest(expected, got)


@app.middleware("http")
async def hmac_auth(request: Request, call_next):
    if request.url.path in ("/healthz", "/readyz", "/docs", "/openapi.json"):
        return await call_next(request)
    secret = _secret()
    if not secret:
        return _err(503, "ENGINE_NOT_CONFIGURED", "SCM_ENGINE_SECRET is not set")
    body = await request.body()
    if not _verify(secret, request.headers.get(HDR_TS), request.headers.get(HDR_SIG), body):
        return _err(401, "BAD_SIGNATURE", "invalid or stale request signature")
    response = await call_next(request)
    response.headers[HDR_VERSION] = ENGINE_VERSION
    return response


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "version": ENGINE_VERSION, "contract_version": CONTRACT_VERSION}


@app.get("/readyz")
async def readyz():
    """Proves the heavy dependencies actually work in THIS image, not just that the port is open."""
    checks: dict[str, str] = {}
    try:
        solver_selftest()
        checks["solver"] = "ok"
    except Exception as exc:  # noqa: BLE001
        checks["solver"] = f"error: {exc}"
    try:
        import prophet  # noqa: F401

        checks["prophet"] = "ok"
    except Exception as exc:  # noqa: BLE001 — engine still serves: series degrade to the DOW baseline
        checks["prophet"] = f"unavailable: {exc}"
    ready = checks["solver"] == "ok"
    return JSONResponse(
        status_code=200 if ready else 503,
        content={"status": "ready" if ready else "degraded", "checks": checks},
    )


async def _handle(request: Request, model, runner, path: str):
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return _err(400, "BAD_JSON", "request body is not valid JSON")
    if isinstance(payload, dict) and payload.get("contract_version") != CONTRACT_VERSION:
        return _err(
            422,
            "CONTRACT_VERSION_MISMATCH",
            f"engine speaks contract {CONTRACT_VERSION}, got {payload.get('contract_version')!r}",
        )
    try:
        req = model.model_validate(payload)
    except ValidationError as exc:
        return _err(422, "VALIDATION_ERROR", exc.errors(include_url=False)[0]["msg"])

    idem = request.headers.get(HDR_IDEM)
    key = f"{path}:{idem}" if idem else None
    cached = cache.get(key)
    if cached is not None:
        return JSONResponse(content=cached)
    result = runner(req).model_dump()
    cache.put(key, result)
    return JSONResponse(content=result)


@app.post("/v1/forecast")
async def forecast(request: Request):
    return await _handle(request, ForecastRequest, run_forecast, "forecast")


@app.post("/v1/optimize")
async def optimize(request: Request):
    return await _handle(request, OptimizeRequest, run_optimize, "optimize")


@app.post("/v1/optimize-network")
async def optimize_network(request: Request):
    return await _handle(request, OptimizeNetworkRequest, run_optimize_network, "optimize-network")
