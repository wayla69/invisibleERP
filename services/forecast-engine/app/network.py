"""Two-echelon multi-echelon inventory optimization (docs/57 Track B · B2).

Order across TIERS (supplier → DC / central kitchen → branch) with RISK POOLING at the DC, rather
than buffering each branch in isolation. We use the guaranteed-service model (GSM; Graves–Willems /
Simchi-Levi) — the tractable, auditable MEIO approximation. Each node commits an outbound service
time; its net replenishment lead time is

    τ(v) = S_in(v) + L(inbound lane, v) − S_out(v)          (τ ≥ 0 enforced)

and its installation base-stock covers demand over τ at the node's service level:

    B(v) = μ(v)·τ(v) + z_α·σ(v)·√τ(v)          (σ(v) = σ_DC at the DC, σ_i at a branch).

For a single-DC distribution tree the service-time decision collapses to a 1-D search over the DC's
outbound service time S_out(DC) ∈ [0, L_supplier] — deterministic, fast, certifiable (docs/57 §1.4).
Risk pooling at the DC (docs/57 §1.3):

    σ_DC = √( Σ_i σ_i² + 2·Σ_{i<j} ρ_ij·σ_i·σ_j )   ≤   Σ_i σ_i    (equality only at ρ ≡ 1)

The per-node ORDER schedule + `expected` FEFO metrics reuse the docs/54 single-tier optimizer
(`solve_item`/`simulate`) unchanged, so a degenerate single-branch network reproduces the single-tier
plan for that item (soundness property 6) and the numbers stay comparable across tracks.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import math
import statistics
import time

import numpy as np

from .contracts import (
    Expected,
    InventoryLayer,
    LeadTime,
    NetworkAllocationLine,
    NetworkNode,
    NetworkOrder,
    NetworkNodePlan,
    OptimizeItem,
    OptimizeNetworkRequest,
    OptimizeNetworkResponse,
    PoolingReport,
)
from .optimization import EngineItemFailure, solve_item


class NetworkFailure(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _z(service_level: float) -> float:
    """Safety factor z_α for a service level, via the stdlib inverse normal CDF (no scipy dep)."""
    sl = min(max(service_level, 0.5), 0.999)
    return float(statistics.NormalDist(0.0, 1.0).inv_cdf(sl))


def _rng(seed_text: str) -> np.random.Generator:
    digest = hashlib.sha256(seed_text.encode()).digest()
    return np.random.default_rng(int.from_bytes(digest[:8], "big"))


# ── Fair-share allocation on DC shortage (docs/57 §1.5; the tested primitive for SCM-06/B3) ────────


def allocate(
    available: float,
    requests: list[float],
    method: str = "proportional",
    weights: list[float] | None = None,
    means: list[float] | None = None,
) -> list[float]:
    """Ration a scarce `available` DC quantity across branch `requests`.

    Guarantees (asserted in tests): every `a_i ≥ 0`, `Σ a_i ≤ available`, and the split is SYMMETRIC
    under equal `(request, weight, mean)`. Three methods:
      · proportional — `a_i = A · r_i / Σ r_j` (default).
      · fair_share   — equal-runout: equalize projected days-of-cover `(a_i)/mean_i` across branches.
      · priority     — proportional WITHIN a priority tier before the next (lower) tier is served.
    """
    n = len(requests)
    if n == 0:
        return []
    req = [max(0.0, float(r)) for r in requests]
    total_req = sum(req)
    avail = max(0.0, float(available))
    if total_req <= 1e-12:
        return [0.0] * n
    if avail >= total_req:  # no shortage — everyone gets their full request
        return req[:]

    if method == "priority":
        w = weights if weights and len(weights) == n else [1.0] * n
        alloc = [0.0] * n
        remaining = avail
        # Serve highest-priority tiers first; within a tier, split proportionally to request.
        for tier in sorted({round(float(x), 6) for x in w}, reverse=True):
            idx = [i for i in range(n) if round(float(w[i]), 6) == tier]
            tier_req = sum(req[i] for i in idx)
            if tier_req <= 1e-12:
                continue
            give = min(remaining, tier_req)
            for i in idx:
                alloc[i] = give * req[i] / tier_req
            remaining -= give
            if remaining <= 1e-12:
                break
        return alloc

    if method == "fair_share":
        # Equal-runout: allocate so each branch reaches the same projected days-of-cover a_i/mean_i.
        # With no shortage handled above, distribute `avail` in proportion to mean demand (the runout
        # denominator), which equalizes a_i/mean_i exactly. Falls back to request weights if no means.
        base = means if means and len(means) == n and sum(m for m in means if m > 0) > 0 else req
        base = [max(0.0, float(b)) for b in base]
        denom = sum(base)
        if denom <= 1e-12:
            return [0.0] * n
        return [avail * b / denom for b in base]

    # proportional (default)
    return [avail * r / total_req for r in req]


# ── Topology parse + per-branch demand statistics ──────────────────────────────


def _demand_array(scenarios: list[list[float]], horizon: int) -> np.ndarray:
    d = np.asarray(scenarios, dtype=float)
    if d.ndim != 2 or d.shape[0] < 1 or d.shape[1] < horizon:
        raise NetworkFailure(
            "BAD_SCENARIOS", f"demand_scenarios must be K×H with H ≥ horizon (got {list(d.shape)})"
        )
    return np.clip(d[:, :horizon], 0.0, None)


def _daily_sigma(demand: np.ndarray) -> float:
    """Per-day demand volatility: the cross-scenario std of each day's demand, averaged over days."""
    if demand.shape[0] < 2:
        return 0.0
    return float(np.std(demand, axis=0, ddof=1).mean())


def _correlation(a: np.ndarray, b: np.ndarray) -> float:
    """Pearson correlation of two branches' (scenario×day) demand, clamped to [-1, 1]."""
    x, y = a.reshape(-1), b.reshape(-1)
    if x.size < 2 or np.std(x) < 1e-12 or np.std(y) < 1e-12:
        return 0.0
    return float(np.clip(np.corrcoef(x, y)[0, 1], -1.0, 1.0))


def _pooled_sigma(sigmas: list[float], demands: list[np.ndarray]) -> float:
    """σ_DC = √(Σσ_i² + 2·Σ_{i<j} ρ_ij σ_i σ_j); ≤ Σσ_i, equality only at ρ ≡ 1 (docs/57 §1.3)."""
    n = len(sigmas)
    var = sum(s * s for s in sigmas)
    for i in range(n):
        for j in range(i + 1, n):
            rho = _correlation(demands[i], demands[j])
            var += 2.0 * rho * sigmas[i] * sigmas[j]
    return math.sqrt(max(0.0, var))


def _lane_map(req: OptimizeNetworkRequest) -> dict[str, object]:
    """to_node → its single inbound lane. Single-sourcing is a B1 validation; here we take the first."""
    m: dict[str, object] = {}
    for lane in req.lanes:
        m.setdefault(lane.to_node, lane)
    return m


def _node_item(
    req: OptimizeNetworkRequest, node: NetworkNode, lane, demand: np.ndarray
) -> OptimizeItem:
    """Build a docs/54 OptimizeItem for one node so the proven single-tier optimizer plans its orders
    + `expected` FEFO metrics. Lead time / ordering constraints come from the node's INBOUND lane."""
    return OptimizeItem(
        item_code=f"{req.item_code}@{node.node_id}",
        demand_scenarios=demand.tolist(),
        current_inventory=[InventoryLayer(remaining_days=l.remaining_days, qty=l.qty) for l in node.current_inventory],
        in_transit=node.in_transit,
        lead_time=lane.lead_time if lane else LeadTime(mean_days=0, std_days=0),
        shelf_life_days=req.shelf_life_days,
        review_period_days=req.review_period_days,
        unit_cost=lane.unit_cost if lane else req.unit_cost,
        unit_price=req.unit_price,
        salvage_value=req.salvage_value,
        disposal_cost=req.disposal_cost,
        goodwill_cost=req.goodwill_cost,
        holding_cost_per_day=node.holding_cost_per_day,
        moq=lane.moq if lane else 0.0,
        pack_size=lane.pack_size if lane else 1.0,
        fixed_order_cost=lane.fixed_order_cost if lane else 0.0,
    )


def _node_orders(plan_orders, from_node: str) -> list[NetworkOrder]:
    return [
        NetworkOrder(order_ds=o.order_ds, arrival_ds=o.arrival_ds, from_node=from_node, qty=o.qty, packs=o.packs)
        for o in plan_orders
    ]


# ── Entry point ────────────────────────────────────────────────────────────────


def run_optimize_network(req: OptimizeNetworkRequest) -> OptimizeNetworkResponse:
    horizon = req.horizon_days
    errors = []

    branches = [n for n in req.nodes if n.echelon == 2]
    dcs = [n for n in req.nodes if n.echelon == 1]
    suppliers = [n for n in req.nodes if n.echelon == 0]
    if not branches:
        raise NetworkFailure("UNREACHABLE_BRANCH", "network has no branch (echelon-2) node")
    if not dcs:
        raise NetworkFailure("LANE_ENDPOINTS_INVALID", "network has no DC (echelon-1) node")
    dc = dcs[0]  # single-DC base case (docs/57 §1.4 / §9); multi-DC is deferred
    lanes = _lane_map(req)

    demand_by_node = {p.node_id: _demand_array(p.demand_scenarios, horizon) for p in req.demand_paths}
    for b in branches:
        if b.node_id not in demand_by_node:
            raise NetworkFailure("UNREACHABLE_BRANCH", f"branch {b.node_id} has no demand path")

    z = _z(req.service_level)
    review = req.review_period_days

    # Per-branch demand statistics + inbound (DC→branch) lead times.
    b_demand = [demand_by_node[b.node_id] for b in branches]
    sigmas = [_daily_sigma(d) for d in b_demand]
    mus = [float(d.mean(axis=0).mean()) for d in b_demand]  # per-day mean demand
    l_branch = [int(round(lanes[b.node_id].lead_time.mean_days)) if b.node_id in lanes else 0 for b in branches]

    # DC inbound (supplier→DC) lead time + pooled statistics.
    l_sup = int(round(lanes[dc.node_id].lead_time.mean_days)) if dc.node_id in lanes else 0
    sigma_dc = _pooled_sigma(sigmas, b_demand)
    mu_dc = sum(mus)

    # GSM service-time decision: 1-D search over S_out(DC) ∈ [0, L_supplier] minimizing safety-stock
    # holding cost across both echelons. τ(DC)=L_sup−S ≥ 0; τ(branch_i)=S+L_branch_i (both ≥ 0 → §5).
    def safety_cost(s: int) -> float:
        tau_dc = max(0, l_sup - s) + review
        cost = dc.holding_cost_per_day * z * sigma_dc * math.sqrt(tau_dc)
        for i, b in enumerate(branches):
            tau_i = s + l_branch[i] + review
            cost += b.holding_cost_per_day * z * sigmas[i] * math.sqrt(tau_i)
        return cost

    s_star = min(range(0, max(1, l_sup) + 1), key=safety_cost) if l_sup > 0 else 0

    # Per-node base-stock (installation) from the chosen service times.
    tau_dc = max(0, l_sup - s_star) + review
    dc_install = mu_dc * tau_dc + z * sigma_dc * math.sqrt(tau_dc)
    dc_safety = z * sigma_dc * math.sqrt(tau_dc)

    branch_install = []
    branch_safety = []
    for i in range(len(branches)):
        tau_i = s_star + l_branch[i] + review
        branch_install.append(mus[i] * tau_i + z * sigmas[i] * math.sqrt(tau_i))
        branch_safety.append(z * sigmas[i] * math.sqrt(tau_i))

    def const_vec(v: float) -> list[float]:
        return [float(v)] * horizon

    node_plans: list[NetworkNodePlan] = []

    # Branch plans — orders + expected via the proven single-tier optimizer (degenerate reduction §6).
    dc_from = None
    for lane in req.lanes:
        if lane.to_node == dc.node_id:
            dc_from = lane.from_node
    supplier_node = suppliers[0].node_id if suppliers else (dc_from or "supplier")

    for i, b in enumerate(branches):
        try:
            item = _node_item(req, b, lanes.get(b.node_id), b_demand[i])
            plan = solve_item(item, dt.date.fromisoformat(req.start_ds), horizon,
                              max(1.0, req.time_budget_ms / 1000.0), _rng(f"{req.request_id}|{b.node_id}"))
            node_plans.append(NetworkNodePlan(
                node_id=b.node_id, echelon=2, service_time_out_days=0.0,
                base_stock=const_vec(branch_install[i]),  # leaf: echelon == installation
                installation_base_stock=const_vec(branch_install[i]),
                safety_stock=const_vec(branch_safety[i]),
                orders=_node_orders(plan.orders, dc.node_id),
                expected=plan.expected,
            ))
        except EngineItemFailure as exc:
            errors.append(_err(b.node_id, exc.code, exc.message))

    # DC plan — replenishes against the POOLED (aggregate) branch demand over the supplier lane.
    kmin = min(d.shape[0] for d in b_demand)
    dc_demand = np.sum([d[:kmin] for d in b_demand], axis=0)
    dc_echelon = dc_install + sum(branch_install)  # echelon ≥ Σ branch installation (§ coherence)
    try:
        dc_item = _node_item(req, dc, lanes.get(dc.node_id), dc_demand)
        dc_plan = solve_item(dc_item, dt.date.fromisoformat(req.start_ds), horizon,
                             max(1.0, req.time_budget_ms / 1000.0), _rng(f"{req.request_id}|{dc.node_id}"))
        node_plans.append(NetworkNodePlan(
            node_id=dc.node_id, echelon=1, service_time_out_days=float(s_star),
            base_stock=const_vec(dc_echelon),
            installation_base_stock=const_vec(dc_install),
            safety_stock=const_vec(dc_safety),
            orders=_node_orders(dc_plan.orders, supplier_node),
            expected=dc_plan.expected,
        ))
    except EngineItemFailure as exc:
        errors.append(_err(dc.node_id, exc.code, exc.message))

    # Projected DC shortage → fair-share allocation lines (docs/57 §1.5). A shortage exists on a day
    # when the aggregate branch requirement exceeds the DC's installation base-stock (its on-hand
    # target). Uses the approved allocation policy; empty when the DC can cover every day.
    allocations: list[NetworkAllocationLine] = []
    start = dt.date.fromisoformat(req.start_ds)
    prio = req.allocation.priorities or {}
    weights = [float(prio.get(b.node_id, 1.0)) for b in branches]
    for t in range(horizon):
        requests = [float(b_demand[i][:, t].mean()) for i in range(len(branches))]
        total_req = sum(requests)
        if total_req <= dc_install + 1e-9 or total_req <= 1e-9:
            continue  # DC covers the day — no rationing
        alloc = allocate(dc_install, requests, req.allocation.method, weights, mus)
        ds = (start + dt.timedelta(days=t)).isoformat()
        for i, b in enumerate(branches):
            allocations.append(NetworkAllocationLine(
                ds=ds, from_node=dc.node_id, to_node=b.node_id,
                requested=requests[i], allocated=alloc[i], shortfall=max(0.0, requests[i] - alloc[i]),
            ))

    # Pooling report over a COMMON protection window P so the comparison is apples-to-apples: the
    # buffer held independently at each branch vs pooled once at the DC (docs/57 §1.3).
    p_window = review + (sum(l_branch) / len(l_branch) if l_branch else 0)
    root_p = math.sqrt(max(0.0, p_window))
    independent = z * root_p * sum(sigmas)
    pooled = z * root_p * sigma_dc
    benefit = 0.0 if independent <= 1e-12 else (independent - pooled) / independent * 100.0

    return OptimizeNetworkResponse(
        contract_version=req.contract_version,
        request_id=req.request_id,
        node_plans=node_plans,
        allocations=allocations,
        pooling=PoolingReport(
            independent_safety_units=independent,
            pooled_safety_units=pooled,
            pooling_benefit_pct=benefit,
        ),
        errors=errors,
    )


def _err(ref: str, code: str, message: str):
    from .contracts import EngineItemError

    return EngineItemError(ref=ref, code=code, message=message or code)
