"""Hierarchical forecast reconciliation (docs/58 Track C · C2–C4).

Makes the per-leaf base forecasts sum coherently up an aggregation forest. This is a POST-processing
step over the base models' output (Prophet / Croston / bootstrap) — it does not re-forecast the leaves.
Coherence is enforced on the SAMPLE PATHS (§1.4 of docs/58: quantiles are not additive), so the
reconciled leaf paths that flow into BoM explosion + optimization stay internally consistent, scenario
by scenario.

C2 ships `bottom_up` and `top_down_hist`. **C3 adds `mint`** — minimum-trace optimal reconciliation
`ỹ = S·G·ŷ`, `G = (Sᵀ W⁻¹ S)⁻¹ Sᵀ W⁻¹` (§1.3). MinT only differs from bottom-up when the aggregate
nodes carry INDEPENDENT base forecasts (an aggregate forecast that is not just the sum of the leaves);
`service.run_forecast` forecasts each aggregate node's summed history independently and passes those in
as `agg_base_by_node`. The covariance `W` of the base-forecast dispersion is estimated per the request
enum: `ols` (W=I), `wls_struct` (W=diag(S·1), no history — the cold-start default), `wls_var`
(W=diag(per-node predictive variance)), `shrink` (Schäfer–Strimmer toward the diagonal — invertible
even when n_obs < m). **C4** applies the oblique projector `P=S·G` per scenario/day to the base sample
paths, so the reconciled leaf paths are coherent by construction; a projected path may dip below zero,
so we clip at 0 and renormalize the leaves to the reconciled aggregate (§1.4). Points/quantiles in each
reconciled node are re-derived from its reconciled paths, never reconciled directly.
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


def aggregate_specs(recon: Reconciliation) -> list[tuple[str, list[str]]]:
    """Public helper for the engine's MinT pre-pass (service.run_forecast): the non-leaf nodes and, for
    each, the `series_id`s of its descendant leaves — so the engine can forecast every aggregate node's
    summed history INDEPENDENTLY (that independent aggregate forecast is what makes MinT ≠ bottom-up).
    Returns [] for a flat forest (leaves only). Raises on a malformed forest (same validation as
    reconcile)."""
    nodes, children, leaves_list, _ = _forest(recon)
    leaves = set(leaves_list)
    specs: list[tuple[str, list[str]]] = []
    for nid, node in nodes.items():
        if nid in leaves:
            continue
        sids = [nodes[lid].series_id for lid in _descendant_leaves(nid, children, leaves)]
        if any(s is None for s in sids):
            raise ReconcileError(f"aggregate {nid} has a descendant leaf with no series_id")
        specs.append((nid, [s for s in sids if s is not None]))
    return specs


# ── MinT linear algebra (§1.3) ──────────────────────────────────────────────────


def _summing_matrix(
    node_order: list[str],
    children: dict[str, list[str]],
    leaves_list: list[str],
) -> tuple[np.ndarray, dict[str, int]]:
    """S ∈ {0,1}^(m×n): row per node (in node_order), column per leaf; S[i,j]=1 iff leaf j sums into
    node i. Bottom rows form the identity block, so S has full column rank (SᵀW⁻¹S is invertible)."""
    leaves = set(leaves_list)
    leaf_col = {lid: j for j, lid in enumerate(leaves_list)}
    S = np.zeros((len(node_order), len(leaves_list)), dtype=float)
    for i, nid in enumerate(node_order):
        for lid in _descendant_leaves(nid, children, leaves):
            S[i, leaf_col[lid]] = 1.0
    return S, leaf_col


def _mint_G(S: np.ndarray, W: np.ndarray) -> np.ndarray:
    """G = (Sᵀ W⁻¹ S)⁻¹ Sᵀ W⁻¹ (n×m). Solve instead of explicit inverse for conditioning; fall back to
    the pseudo-inverse if the core system is singular (a degenerate hierarchy should never crash)."""
    p = W.shape[0]
    try:
        Wi = np.linalg.inv(W + 1e-12 * np.eye(p))
    except np.linalg.LinAlgError:
        Wi = np.linalg.pinv(W)
    StWi = S.T @ Wi  # n×m
    core = StWi @ S  # n×n
    try:
        return np.linalg.solve(core, StWi)
    except np.linalg.LinAlgError:
        return np.linalg.pinv(core) @ StWi


def _shrink_cov(X: np.ndarray, floor: float) -> np.ndarray:
    """Schäfer–Strimmer shrinkage of the sample covariance toward its diagonal (off-diagonals → 0),
    with the closed-form λ*. Well-conditioned and invertible even when n_obs < p (the sparse-history
    case §1.3): the diagonal target is always full-rank, so the convex blend is too."""
    n, p = X.shape
    Xc = X - X.mean(axis=0, keepdims=True)
    S = (Xc.T @ Xc) / max(1, n - 1)  # p×p sample covariance
    target = np.diag(np.diag(S))
    if n < 3:
        lam = 1.0  # too few obs to estimate off-diagonal variance — take the diagonal target
    else:
        # w_kij = Xc[k,i]·Xc[k,j]; s_ij = mean_k w_kij · n/(n-1); Var(s_ij) ≈ n/(n-1)³ · Σ_k (w_kij - w̄_ij)²
        wk = np.einsum("ki,kj->kij", Xc, Xc)  # n×p×p
        wbar = wk.mean(axis=0)  # p×p
        var_s = ((wk - wbar) ** 2).sum(axis=0) * (n / (n - 1) ** 3)
        off = ~np.eye(p, dtype=bool)
        den = float((S[off] ** 2).sum())
        lam = 1.0 if den <= 0 else float(np.clip(var_s[off].sum() / den, 0.0, 1.0))
    W = lam * target + (1.0 - lam) * S
    np.fill_diagonal(W, np.maximum(np.diag(W), floor))
    return W + 1e-12 * np.eye(p)


def _estimate_W(covariance: str, S: np.ndarray, base_stack: np.ndarray) -> np.ndarray:
    """W (m×m) — the base-forecast error covariance MinT weights by, estimated from the base forecasts'
    predictive dispersion (the same sample paths §1.4 reconciles — no separate residual backtest / new
    query path, per docs/58 §3). `wls_struct` needs no dispersion at all (structural, cold-start safe)."""
    m = S.shape[0]
    if covariance == "ols":
        return np.eye(m)
    if covariance == "wls_struct":
        return np.diag(np.maximum(S.sum(axis=1), 1.0))  # #leaves under each node (≥1)
    # per-node predictive variance across scenarios, averaged over the horizon
    k = base_stack.shape[1]
    var_kh = base_stack.var(axis=1, ddof=1) if k > 1 else np.zeros(base_stack.shape[::2])
    node_var = var_kh.mean(axis=1)  # (m,)
    floor = max(1e-8, 1e-6 * float(np.mean(np.abs(base_stack))))
    if covariance == "wls_var":
        return np.diag(np.maximum(node_var, floor))
    if covariance == "shrink":
        obs = base_stack.mean(axis=2).T  # (K, m) — one obs per scenario (mean over horizon)
        return _shrink_cov(obs, floor)
    raise ReconcileError(f"unsupported covariance {covariance!r}")


def _mint_bottom(
    recon: Reconciliation,
    nodes: dict,
    children: dict[str, list[str]],
    leaves_list: list[str],
    leaf_paths: dict[str, np.ndarray],
    agg_base_by_node: dict[str, ForecastSeriesResult] | None,
) -> dict[str, np.ndarray]:
    """MinT reconciled bottom-level paths b̃ (dict leaf_id → K×H), coherent, clipped, renormalized."""
    leaves = set(leaves_list)
    node_order = list(nodes.keys())
    S, leaf_col = _summing_matrix(node_order, children, leaves_list)
    shape = next(iter(leaf_paths.values())).shape  # (K, H)

    # base vector ŷ over ALL nodes: leaves use their own base forecast; each aggregate uses its
    # INDEPENDENT base forecast when supplied (that is what makes MinT ≠ BU), else the coherent sum
    # of its leaves (a request with no independent aggregate forecast degenerates to BU — honest).
    base_by_node: dict[str, np.ndarray] = {}
    for nid in node_order:
        if nid in leaves:
            base_by_node[nid] = leaf_paths[nid]
            continue
        supplied = agg_base_by_node.get(nid) if agg_base_by_node else None
        if supplied is not None:
            arr = np.asarray(supplied.sample_paths, dtype=float)
            if arr.shape != shape:
                raise ReconcileError(f"aggregate {nid} base forecast has mismatched (scenarios, horizon)")
            base_by_node[nid] = arr
        else:
            desc = _descendant_leaves(nid, children, leaves)
            base_by_node[nid] = sum(leaf_paths[d] for d in desc)
    base_stack = np.stack([base_by_node[nid] for nid in node_order], axis=0)  # (m, K, H)

    W = _estimate_W(recon.covariance, S, base_stack)
    G = _mint_G(S, W)  # n×m
    b_tilde = np.tensordot(G, base_stack, axes=([1], [0]))  # (n, K, H)
    b = {lid: b_tilde[j] for lid, j in leaf_col.items()}

    # §1.4 clip-at-0 + renormalize each root subtree's leaves back to the MinT-reconciled root total.
    b_clip = {lid: np.clip(v, 0.0, None) for lid, v in b.items()}
    for root in (nid for nid in node_order if nodes[nid].parent_id is None):
        rleaves = _descendant_leaves(root, children, leaves)
        target = np.clip(sum(b[lid] for lid in rleaves), 0.0, None)
        csum = sum(b_clip[lid] for lid in rleaves)
        scale = np.divide(target, csum, out=np.ones_like(target), where=csum > 0)
        for lid in rleaves:
            b_clip[lid] = b_clip[lid] * scale
    return b_clip


def reconcile(
    recon: Reconciliation,
    base_by_series: dict[str, ForecastSeriesResult],
    quantiles: list[float],
    agg_base_by_node: dict[str, ForecastSeriesResult] | None = None,
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
    if method == "bottom_up":
        b = dict(leaf_paths)
    elif method == "top_down_hist":
        total = sum(leaf_paths.values())  # K×H
        means = {nid: float(np.mean(p)) for nid, p in leaf_paths.items()}
        denom = sum(means.values())
        shares = {nid: (means[nid] / denom if denom > 0 else 1.0 / len(leaves_list)) for nid in leaves_list}
        b = {nid: np.clip(total * shares[nid], 0.0, None) for nid in leaves_list}
        # renormalize the clipped leaves back to the total (coherence to the top)
        bsum = sum(b.values())
        scale = np.divide(total, bsum, out=np.ones_like(total), where=bsum > 0)
        b = {nid: b[nid] * scale for nid in leaves_list}
    elif method == "mint":
        b = _mint_bottom(recon, nodes, children, leaves_list, leaf_paths, agg_base_by_node)
    else:
        raise ReconcileError(f"unsupported reconciliation method {method!r}")

    horizon = next(iter(b.values())).shape[1]
    # first future ds is taken from any base result's points (they all share the horizon calendar)
    any_pts = next(iter(base_by_series.values())).points
    ds_list = [p.ds for p in any_pts][:horizon]

    out: list[ReconciledNodeResult] = []
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
                method=method,  # type: ignore[arg-type]
                points=points,
                sample_paths=[[float(v) for v in row] for row in paths],
                accuracy=acc,
            )
        )
    return out
