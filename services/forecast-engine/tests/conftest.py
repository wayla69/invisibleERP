from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import time
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"
SECRET = "test-engine-secret"


@pytest.fixture(scope="session")
def fixture_dir() -> Path:
    return FIXTURES


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.fixture
def client(monkeypatch):
    """TestClient with the HMAC secret configured (imported lazily: fastapi is a dev-time dep)."""
    from fastapi.testclient import TestClient

    monkeypatch.setenv("SCM_ENGINE_SECRET", SECRET)
    from app.main import app

    return TestClient(app)


def signed_headers(body: bytes, secret: str = SECRET, ts: int | None = None) -> dict[str, str]:
    stamp = str(ts if ts is not None else int(time.time()))
    sig = hmac.new(secret.encode(), f"{stamp}.".encode() + body, hashlib.sha256).hexdigest()
    return {
        "content-type": "application/json",
        "x-engine-timestamp": stamp,
        "x-engine-signature": sig,
    }


def post_signed(client, path: str, payload: dict, secret: str = SECRET, ts: int | None = None):
    body = json.dumps(payload).encode()
    return client.post(path, content=body, headers=signed_headers(body, secret, ts))


def daily_history(days: int, base: float, *, weekend_lift: float = 1.0, end: dt.date | None = None):
    """Deterministic weekday-patterned history ending yesterday-ish (no RNG → stable assertions)."""
    end = end or dt.date(2026, 6, 30)
    out = []
    for i in range(days):
        d = end - dt.timedelta(days=days - 1 - i)
        mult = weekend_lift if d.weekday() >= 5 else 1.0
        wobble = 1.0 + 0.08 * ((i % 5) - 2) / 2.0
        out.append({"ds": d.isoformat(), "y": round(base * mult * wobble, 3)})
    return out
