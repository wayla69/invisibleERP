"""Syntetos–Boylan routing (docs/54 §1.1)."""

from __future__ import annotations

from app.classify import classify, route


def test_smooth_daily_seller():
    assert classify([10.0 + (i % 3) for i in range(120)]) == "smooth"


def test_erratic_high_variance_daily_seller():
    vals = [(50.0 if i % 7 == 0 else 3.0) for i in range(120)]
    assert classify(vals) == "erratic"


def test_intermittent_regular_size_sparse_demand():
    vals = [(5.0 if i % 5 == 0 else 0.0) for i in range(120)]
    assert classify(vals) == "intermittent"


def test_lumpy_sparse_and_variable():
    vals = [((60.0 if i % 15 == 0 else 2.0) if i % 5 == 0 else 0.0) for i in range(150)]
    assert classify(vals) == "lumpy"


def test_short_history_routes_to_baseline():
    assert classify([4.0] * 20) == "short"
    assert route("short") == "baseline_dow"


def test_almost_no_demand_days_is_short():
    vals = [0.0] * 118 + [3.0, 4.0]
    assert classify(vals) == "short"


def test_routing_table():
    assert route("smooth") == "prophet"
    assert route("erratic") == "prophet"
    assert route("intermittent") == "croston_sba"
    assert route("lumpy") == "bootstrap"
