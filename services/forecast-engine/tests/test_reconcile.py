"""Reconciliation soundness (docs/58 Track C · C2), asserted as tests not prose."""

from __future__ import annotations

import numpy as np
import pytest

from app.contracts import (
    Accuracy,
    ForecastPoint,
    ForecastSeriesResult,
    HierarchyNode,
    Reconciliation,
)
from app.reconcile import ReconcileError, reconcile

Q = [0.1, 0.5, 0.9]


def _series(sid: str, paths: list[list[float]]) -> ForecastSeriesResult:
    arr = np.asarray(paths, dtype=float)
    pts = [
        ForecastPoint(ds=f"2026-07-{h + 1:02d}", yhat=float(arr[:, h].mean()), q={str(q): float(np.quantile(arr[:, h], q)) for q in Q})
        for h in range(arr.shape[1])
    ]
    return ForecastSeriesResult(
        series_id=sid, model="prophet", points=pts, sample_paths=paths, accuracy=Accuracy(wape=0.1, cutoffs=1)
    )


def _two_level():
    # TOTAL over two branch leaves, 3 scenarios × 2 horizon days.
    a = [[10.0, 12.0], [11.0, 13.0], [9.0, 14.0]]
    b = [[5.0, 6.0], [4.0, 7.0], [6.0, 5.0]]
    base = {"s-a": _series("s-a", a), "s-b": _series("s-b", b)}
    nodes = [
        HierarchyNode(node_id="TOTAL", parent_id=None),
        HierarchyNode(node_id="A", parent_id="TOTAL", series_id="s-a"),
        HierarchyNode(node_id="B", parent_id="TOTAL", series_id="s-b"),
    ]
    return base, nodes


def _by_node(res):
    return {r.node_id: np.asarray(r.sample_paths, dtype=float) for r in res}


def test_bottom_up_is_coherent_and_leaves_unchanged():
    base, nodes = _two_level()
    res = reconcile(Reconciliation(method="bottom_up", nodes=nodes), base, Q)
    p = _by_node(res)
    # aggregate = exact sum of children, scenario-by-scenario
    assert np.allclose(p["TOTAL"], p["A"] + p["B"])
    # leaves unchanged vs the base forecast (bottom-up touches only aggregates)
    assert np.allclose(p["A"], np.asarray(base["s-a"].sample_paths))
    assert np.allclose(p["B"], np.asarray(base["s-b"].sample_paths))
    # levels: leaves 0, root 1
    lvl = {r.node_id: r.level for r in res}
    assert lvl == {"TOTAL": 1, "A": 0, "B": 0}


def test_top_down_keeps_the_total_and_is_coherent():
    base, nodes = _two_level()
    res = reconcile(Reconciliation(method="top_down_hist", nodes=nodes), base, Q)
    p = _by_node(res)
    total_base = np.asarray(base["s-a"].sample_paths) + np.asarray(base["s-b"].sample_paths)
    # the reconciled leaves still sum to the (base) total, and the aggregate is coherent
    assert np.allclose(p["A"] + p["B"], total_base)
    assert np.allclose(p["TOTAL"], p["A"] + p["B"])
    assert (p["A"] >= 0).all() and (p["B"] >= 0).all()


def test_mint_falls_back_to_bottom_up_and_reports_bottom_up():
    base, nodes = _two_level()
    res = reconcile(Reconciliation(method="mint", nodes=nodes), base, Q)
    p = _by_node(res)
    assert np.allclose(p["TOTAL"], p["A"] + p["B"])
    assert all(r.method == "bottom_up" for r in res)  # C3 not yet — reported honestly


def test_determinism():
    base, nodes = _two_level()
    a = _by_node(reconcile(Reconciliation(method="bottom_up", nodes=nodes), base, Q))
    b = _by_node(reconcile(Reconciliation(method="bottom_up", nodes=nodes), base, Q))
    assert np.allclose(a["TOTAL"], b["TOTAL"])


def test_malformed_hierarchy_is_rejected():
    base, _ = _two_level()
    # a leaf pointing at a series that was not forecast
    nodes = [
        HierarchyNode(node_id="TOTAL", parent_id=None),
        HierarchyNode(node_id="A", parent_id="TOTAL", series_id="s-a"),
        HierarchyNode(node_id="X", parent_id="TOTAL", series_id="s-missing"),
    ]
    with pytest.raises(ReconcileError):
        reconcile(Reconciliation(method="bottom_up", nodes=nodes), base, Q)


def test_none_method_returns_empty():
    base, nodes = _two_level()
    assert reconcile(Reconciliation(method="none", nodes=nodes), base, Q) == []
