"""HMAC boundary: the engine must be unusable without a valid, fresh signature."""

from __future__ import annotations

import json
import time

from conftest import SECRET, load_fixture, post_signed, signed_headers


def test_healthz_is_open(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["contract_version"] == "1"


def test_unsigned_request_rejected(client):
    r = client.post("/v1/forecast", json=load_fixture("forecast_request.json"))
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "BAD_SIGNATURE"


def test_wrong_secret_rejected(client):
    r = post_signed(client, "/v1/forecast", load_fixture("forecast_request.json"), secret="nope")
    assert r.status_code == 401


def test_stale_timestamp_rejected(client):
    old = int(time.time()) - 3600
    r = post_signed(client, "/v1/forecast", load_fixture("forecast_request.json"), ts=old)
    assert r.status_code == 401


def test_body_tamper_rejected(client):
    payload = load_fixture("forecast_request.json")
    body = json.dumps(payload).encode()
    headers = signed_headers(body)
    tampered = json.dumps({**payload, "horizon_days": 21}).encode()
    r = client.post("/v1/forecast", content=tampered, headers=headers)
    assert r.status_code == 401


def test_sha256_prefixed_signature_accepted(client):
    payload = load_fixture("forecast_request.json")
    body = json.dumps(payload).encode()
    headers = signed_headers(body)
    headers["x-engine-signature"] = "sha256=" + headers["x-engine-signature"]
    r = client.post("/v1/forecast", content=body, headers=headers)
    assert r.status_code == 200


def test_missing_secret_fails_closed(client, monkeypatch):
    monkeypatch.delenv("SCM_ENGINE_SECRET", raising=False)
    r = post_signed(client, "/v1/forecast", load_fixture("forecast_request.json"))
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "ENGINE_NOT_CONFIGURED"


def test_contract_version_mismatch(client):
    payload = {**load_fixture("forecast_request.json"), "contract_version": "2"}
    r = post_signed(client, "/v1/forecast", payload)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "CONTRACT_VERSION_MISMATCH"


def test_idempotency_returns_cached_result(client):
    payload = load_fixture("optimize_request.json")
    body = json.dumps(payload).encode()
    headers = {**signed_headers(body), "x-engine-idempotency": "idem-key-1"}
    first = client.post("/v1/optimize", content=body, headers=headers)
    assert first.status_code == 200
    again = client.post("/v1/optimize", content=body, headers=signed_headers(body) | {"x-engine-idempotency": "idem-key-1"})
    assert again.json() == first.json()
