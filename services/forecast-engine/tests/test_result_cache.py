"""docs/59 D3 — shared, fail-open result cache.

The engine ResultCache is an idempotency optimization; making it shared across replicas via Redis must
NEVER change correctness and must degrade cleanly when Redis is absent or down. These tests use an
in-memory fake (no real Redis / no redis package needed — CI stays single-node)."""

from __future__ import annotations

from app import service
from app.service import ResultCache


class FakeRedis:
    def __init__(self, fail: bool = False):
        self.store: dict[str, str] = {}
        self.fail = fail

    def get(self, k):
        if self.fail:
            raise RuntimeError("redis down")
        return self.store.get(k)

    def set(self, k, v, px=None):
        if self.fail:
            raise RuntimeError("redis down")
        self.store[k] = v


def test_cache_fail_open_without_redis(monkeypatch):
    # Unconfigured (the default single-node / CI path): the per-process TTL/LRU cache is authoritative.
    monkeypatch.setattr(service, "_engine_redis", lambda: None)
    c = ResultCache(ttl=100)
    assert c.get("k1") is None
    c.put("k1", {"a": 1})
    assert c.get("k1") == {"a": 1}


def test_cache_shared_via_redis_across_replicas(monkeypatch):
    # A put write-throughs to Redis, so a DIFFERENT replica (a fresh cache with an empty in-process map)
    # still serves the cached result — the cross-replica idempotency the horizontal-scale story needs.
    fake = FakeRedis()
    monkeypatch.setattr(service, "_engine_redis", lambda: fake)
    writer = ResultCache(ttl=100)
    writer.put("kx", {"n": 7})
    assert "scmeng:kx" in fake.store  # written through to the shared backend
    reader = ResultCache(ttl=100)  # a second replica — its _data is empty
    assert reader.get("kx") == {"n": 7}


def test_cache_fail_open_when_redis_errors(monkeypatch):
    # Redis down mid-flight (get AND set raise) ⇒ the request still succeeds via the per-process cache;
    # a Redis outage degrades to today's single-node behaviour, never an error.
    fake = FakeRedis(fail=True)
    monkeypatch.setattr(service, "_engine_redis", lambda: fake)
    c = ResultCache(ttl=100)
    c.put("ke", {"v": 1})
    assert c.get("ke") == {"v": 1}


def test_null_key_is_a_noop(monkeypatch):
    monkeypatch.setattr(service, "_engine_redis", lambda: None)
    c = ResultCache(ttl=100)
    c.put(None, {"x": 1})
    assert c.get(None) is None
