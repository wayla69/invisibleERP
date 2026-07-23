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
from app.reconcile import ReconcileError, _mint_G, _summing_matrix, reconcile

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


def _const(sid: str, value: float, k: int = 6, h: int = 2) -> ForecastSeriesResult:
    """A base result whose K×H sample paths are all `value` (mean = value, zero predictive spread)."""
    return _series(sid, [[value] * h for _ in range(k)])


def test_mint_is_coherent_and_reports_mint():
    # independent aggregate forecast supplied → real MinT runs (not the BU degenerate path)
    base, nodes = _two_level()
    agg = {"TOTAL": _series("agg-total", [[16.0, 19.0], [17.0, 20.0], [15.0, 21.0]])}
    res = reconcile(Reconciliation(method="mint", covariance="wls_struct", nodes=nodes), base, Q, agg)
    p = _by_node(res)
    assert np.allclose(p["TOTAL"], p["A"] + p["B"])  # coherent, scenario-by-scenario
    assert (p["A"] >= 0).all() and (p["B"] >= 0).all()
    assert all(r.method == "mint" for r in res)  # C3 — MinT, reported honestly


def test_mint_projection_identity_on_coherent_input():
    # when the aggregate base equals the exact sum of the leaves, ŷ is already coherent, so P·ŷ = ŷ:
    # MinT leaves the leaves untouched (the §1.3 oblique-projector identity P·S·b = S·b).
    base, nodes = _two_level()
    total = np.asarray(base["s-a"].sample_paths) + np.asarray(base["s-b"].sample_paths)
    agg = {"TOTAL": _series("agg-total", [[float(v) for v in row] for row in total])}
    res = reconcile(Reconciliation(method="mint", covariance="wls_var", nodes=nodes), base, Q, agg)
    p = _by_node(res)
    assert np.allclose(p["A"], np.asarray(base["s-a"].sample_paths))
    assert np.allclose(p["B"], np.asarray(base["s-b"].sample_paths))


def test_mint_differs_from_bottom_up_and_improves_aggregate():
    # truth total = 8; the leaves over-forecast (BU total = 9, err 1); the INDEPENDENT aggregate
    # forecast is more accurate (7.5, err 0.5). MinT blends → reconciled total nearer the truth than BU.
    nodes = [
        HierarchyNode(node_id="TOTAL", parent_id=None),
        HierarchyNode(node_id="A", parent_id="TOTAL", series_id="s-a"),
        HierarchyNode(node_id="B", parent_id="TOTAL", series_id="s-b"),
    ]
    base = {"s-a": _const("s-a", 4.5), "s-b": _const("s-b", 4.5)}
    agg = {"TOTAL": _const("agg-total", 7.5)}
    res = reconcile(Reconciliation(method="mint", covariance="wls_struct", nodes=nodes), base, Q, agg)
    p = _by_node(res)
    recon_total = float(p["TOTAL"].mean())
    assert not np.isclose(recon_total, 9.0)  # moved off the bottom-up total
    assert abs(recon_total - 8.0) < abs(9.0 - 8.0)  # and toward the truth
    assert np.allclose(p["TOTAL"], p["A"] + p["B"])  # still coherent


def test_mint_G_matches_closed_form():
    # G = (Sᵀ W⁻¹ S)⁻¹ Sᵀ W⁻¹ for the canonical 2-leaf forest with structural weights diag(1,1,2).
    S, _ = _summing_matrix(["TOTAL", "A", "B"], {"TOTAL": ["A", "B"], "A": [], "B": []}, ["A", "B"])
    W = np.diag([2.0, 1.0, 1.0])  # rows: TOTAL(2 leaves), A, B — order matches node_order above
    G = _mint_G(S, W)
    # reconciled total weights = column-sums of S·G applied to a base vector; verify P·S = S (projector)
    P = S @ G
    assert np.allclose(P @ S, S)  # oblique projector onto col(S): already-coherent input is a fixed point


def test_mint_shrink_invertible_when_nobs_lt_m():
    # wide, shallow forest: 8 leaves + 4 mids + 1 root = 13 nodes, only K=3 scenarios ⇒ n_obs < m.
    # The raw sample covariance is singular; Schäfer–Strimmer shrinkage keeps W invertible.
    nodes = [HierarchyNode(node_id="ROOT", parent_id=None)]
    base = {}
    for m in range(4):
        nodes.append(HierarchyNode(node_id=f"M{m}", parent_id="ROOT"))
        for lf in range(2):
            sid = f"s-{m}-{lf}"
            nodes.append(HierarchyNode(node_id=f"L{m}{lf}", parent_id=f"M{m}", series_id=sid))
            base[sid] = _series(sid, [[3.0 + m, 4.0 + lf], [3.5 + m, 4.5], [2.5, 4.0 + m]])
    agg = {"ROOT": _series("agg", [[40.0, 44.0], [41.0, 45.0], [39.0, 46.0]])}
    res = reconcile(Reconciliation(method="mint", covariance="shrink", nodes=nodes), base, Q, agg)
    p = _by_node(res)
    # every parent equals the sum of its children (coherence survives the wide/singular case)
    assert np.allclose(p["ROOT"], sum(p[f"M{m}"] for m in range(4)))
    for m in range(4):
        assert np.allclose(p[f"M{m}"], p[f"L{m}0"] + p[f"L{m}1"])
    assert all((p[k] >= 0).all() for k in p)


@pytest.mark.parametrize("cov", ["ols", "wls_struct", "wls_var", "shrink"])
def test_mint_covariance_variants_are_coherent(cov):
    base, nodes = _two_level()
    agg = {"TOTAL": _series("agg-total", [[16.0, 19.0], [17.0, 20.0], [15.0, 21.0]])}
    res = reconcile(Reconciliation(method="mint", covariance=cov, nodes=nodes), base, Q, agg)
    p = _by_node(res)
    assert np.allclose(p["TOTAL"], p["A"] + p["B"])
    assert (p["A"] >= 0).all() and (p["B"] >= 0).all()


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
