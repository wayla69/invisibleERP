"""Hierarchical forecast reconciliation (docs/58 Track C · C2).

Makes the per-leaf base forecasts sum coherently up an aggregation forest. This is a POST-processing
step over the base models' output (Prophet / Croston / bootstrap) — it does not re-forecast. Coherence
is enforced on the SAMPLE PATHS (§1.4 of docs/58: quantiles are not additive), so the reconciled leaf
paths that flow into BoM explosion + optimization stay internally consistent, scenario by scenario.

C2 ships bottom_up and top_down_hist. MinT (C3) falls back to bottom_up here (still coherent, not yet
optimal). Points/quantiles in each reconciled node are re-derived from its reconciled paths.
"""

from __future__ import annotations

import numpy as np

from .contracts import (
    Accuracy,
    ForecastPoint,
    ForecastSeriesResult,
    Reconciliation,
    ReconciledNodeResult,
)


class ReconcileError(Exception):
    code = "RECONCILE_ERROR"


def _forest(recon: Reconciliation):
    """Validate the forest and return (nodes_by_id, children, leaves, level_by_id)."""
    nodes = {n.node_id: n for n in recon.nodes}
    if len(nodes) != len(recon.nodes):
        raise ReconcileError("duplicate node_id in hierarchy")
    children: dict[str, list[str]] = {nid: [] for nid in nodes}
    for n in recon.nodes:
        if n.parent_id is not None:
            if n.parent_id not in nodes:
                raise ReconcileError(f"node {n.node_id} references unknown parent {n.parent_id}")
            children[n.parent_id].append(n.node_id)
    leaves = [nid for nid, kids in children.items() if not kids]
    # level = height above the deepest leaf (leaves = 0); also detects cycles.
    level_by_id: dict[str, int] = {}

    def height(nid: str, seen: frozenset[str]) -> int:
        if nid in seen:
            raise ReconcileError(f"cycle detected at node {nid}")
        if nid in level_by_id:
            return level_by_id[nid]
        kids = children[nid]
        h = 0 if not kids else 1 + max(height(k, seen | {nid}) for k in kids)
        level_by_id[nid] = h
        return h

    for nid in nodes:
        height(nid, frozenset())
    return nodes, children, leaves, level_by_id


def _descendant_leaves(nid: str, children: dict[str, list[str]], leaves: set[str]) -> list[str]:
    if nid in leaves:
        return [nid]
    out: list[str] = []
    for k in children[nid]:
        out.extend(_descendant_leaves(k, children, leaves))
    return out


def reconcile(
    recon: Reconciliation,
    base_by_series: dict[str, ForecastSeriesResult],
    quantiles: list[float],
) -> list[ReconciledNodeResult]:
    method = recon.method
    if method in ("none",):
        return []
    nodes, children, leaves_list, level_by_id = _forest(recon)
    leaves = set(leaves_list)

    # Each leaf node must carry a series_id that was actually forecast.
    leaf_paths: dict[str, np.ndarray] = {}
    for nid in leaves_list:
        sid = nodes[nid].series_id
        if not sid or sid not in base_by_series:
            raise ReconcileError(f"leaf {nid} has no forecast for series_id {sid!r}")
        leaf_paths[nid] = np.asarray(base_by_series[sid].sample_paths, dtype=float)

    # All leaves must share (K, H) so paths add scenario-by-scenario.
    shapes = {p.shape for p in leaf_paths.values()}
    if len(shapes) != 1:
        raise ReconcileError("leaf forecasts have mismatched (scenarios, horizon)")

    # ── bottom-level reconciled paths b_j ──
    eff_method = "bottom_up" if method == "mint" else method  # MinT → BU until C3
    if eff_method == "bottom_up":
        b = dict(leaf_paths)
    elif eff_method == "top_down_hist":
        total = sum(leaf_paths.values())  # K×H
        means = {nid: float(np.mean(p)) for nid, p in leaf_paths.items()}
        denom = sum(means.values())
        shares = {nid: (means[nid] / denom if denom > 0 else 1.0 / len(leaves_list)) for nid in leaves_list}
        b = {nid: np.clip(total * shares[nid], 0.0, None) for nid in leaves_list}
        # renormalize the clipped leaves back to the total (coherence to the top)
        bsum = sum(b.values())
        scale = np.divide(total, bsum, out=np.ones_like(total), where=bsum > 0)
        b = {nid: b[nid] * scale for nid in leaves_list}
    else:
        raise ReconcileError(f"unsupported reconciliation method {method!r}")

    horizon = next(iter(b.values())).shape[1]
    # first future ds is taken from any base result's points (they all share the horizon calendar)
    any_pts = next(iter(base_by_series.values())).points
    ds_list = [p.ds for p in any_pts][:horizon]

    out: list[ReconciledNodeResult] = []
    reported_method = "bottom_up" if method == "mint" else method
    for nid, node in nodes.items():
        desc = _descendant_leaves(nid, children, leaves)
        paths = np.clip(sum(b[d] for d in desc), 0.0, None)  # node = Σ descendant reconciled leaves
        points = [
            ForecastPoint(
                ds=ds_list[h] if h < len(ds_list) else ds_list[-1],
                yhat=float(max(paths[:, h].mean(), 0.0)),
                q={str(q): float(np.quantile(paths[:, h], q)) for q in quantiles},
            )
            for h in range(horizon)
        ]
        acc = (
            base_by_series[node.series_id].accuracy
            if (nid in leaves and node.series_id in base_by_series)
            else Accuracy(wape=None, cutoffs=0)
        )
        out.append(
            ReconciledNodeResult(
                node_id=nid,
                level=level_by_id[nid],
                method=reported_method,  # type: ignore[arg-type]
                points=points,
                sample_paths=[[float(v) for v in row] for row in paths],
                accuracy=acc,
            )
        )
    return out
