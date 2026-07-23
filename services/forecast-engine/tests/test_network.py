"""Two-echelon MEIO soundness (docs/57 Track B · B2 §8).

These are the properties that make the network optimizer trustworthy rather than merely runnable:
  1. a valid plan is produced for both stocking echelons (DC + branches) with in-range metrics
  2. fair-share allocation is non-negative, sums to ≤ available, and symmetric under equal inputs
  3. echelon coherence — the DC's echelon base-stock ≥ the aggregate of branch installation base-stock
  4. pooling non-negativity — pooled_safety ≤ independent_safety (benefit ≥ 0), equality only at ρ ≡ 1
  5. non-negative net lead time — safety stock is finite and ≥ 0 at every node (τ ≥ 0 enforced)
  6. degenerate reduction — a single-branch network reproduces the docs/54 single-tier order
"""

from __future__ import annotations

import datetime as dt

import numpy as np
import pytest

from app.contracts import LeadTime, OptimizeItem, OptimizeNetworkRequest
from app.network import allocate, run_optimize_network
from app.optimization import solve_item

START = "2026-07-01"


def _paths(rng: np.random.Generator, base: float, k: int = 40, h: int = 14, noise: float = 0.3) -> list[list[float]]:
    m = np.clip(rng.normal(base, base * noise, size=(k, h)), 0.0, None)
    return m.tolist()


def make_request(branch_demands: dict[str, list[list[float]]], **over) -> OptimizeNetworkRequest:
    nodes = [
        {"node_id": "SUP", "kind": "supplier", "echelon": 0},
        {"node_id": "DC", "kind": "dc", "echelon": 1, "holding_cost_per_day": 0.5},
    ]
    lanes = [{"from_node": "SUP", "to_node": "DC", "lead_time": {"mean_days": 4, "std_days": 1}, "unit_cost": 10}]
    demand_paths = []
    for bid, d in branch_demands.items():
        nodes.append({"node_id": bid, "kind": "branch", "echelon": 2, "service_time_out_days": 0, "holding_cost_per_day": 1.0})
        lanes.append({"from_node": "DC", "to_node": bid, "lead_time": {"mean_days": 2, "std_days": 1}, "unit_cost": 10})
        demand_paths.append({"node_id": bid, "demand_scenarios": d})
    body = {
        "contract_version": "2", "request_id": "t-net", "start_ds": START, "horizon_days": 14,
        "item_code": "ING-1", "shelf_life_days": 30, "review_period_days": 1,
        "unit_price": 20, "unit_cost": 10, "service_level": 0.95,
        "nodes": nodes, "lanes": lanes, "demand_paths": demand_paths,
        "allocation": {"method": "proportional"},
    }
    body.update(over)
    return OptimizeNetworkRequest.model_validate(body)


# ── Property 1 — a valid plan for both stocking echelons ──────────────────────


def test_valid_plan_both_echelons():
    rng = np.random.default_rng(1)
    req = make_request({"B1": _paths(rng, 10), "B2": _paths(rng, 8), "B3": _paths(rng, 12)})
    resp = run_optimize_network(req)
    assert not resp.errors
    kinds = {p.node_id: p.echelon for p in resp.node_plans}
    assert kinds == {"DC": 1, "B1": 2, "B2": 2, "B3": 2}  # supplier gets no plan (no base-stock)
    for p in resp.node_plans:
        assert 0.0 <= p.expected.fill_rate <= 1.0
        assert all(q >= 0 for o in p.orders for q in (o.qty, o.packs))
        assert len(p.base_stock) == req.horizon_days
        assert all(s >= 0 for s in p.safety_stock)


# ── Property 2 — allocation: non-negative, capped, symmetric ──────────────────


@pytest.mark.parametrize("method", ["proportional", "fair_share", "priority"])
def test_allocation_nonneg_capped(method):
    requests = [10.0, 20.0, 5.0, 15.0]
    available = 30.0  # < sum(50) → a genuine shortage
    a = allocate(available, requests, method, weights=[1, 1, 1, 1], means=requests)
    assert all(x >= -1e-9 for x in a)
    assert sum(a) <= available + 1e-6


@pytest.mark.parametrize("method", ["proportional", "fair_share", "priority"])
def test_allocation_symmetry(method):
    a = allocate(12.0, [10.0, 10.0, 10.0], method, weights=[1, 1, 1], means=[10, 10, 10])
    assert a[0] == pytest.approx(a[1]) == pytest.approx(a[2])
    assert sum(a) == pytest.approx(12.0)


def test_allocation_no_shortage_serves_full():
    a = allocate(100.0, [10.0, 20.0], "proportional")
    assert a == [10.0, 20.0]


def test_priority_serves_higher_tier_first():
    # available covers only the high-priority branch's request
    a = allocate(10.0, [10.0, 10.0], "priority", weights=[2.0, 1.0])
    assert a[0] == pytest.approx(10.0)
    assert a[1] == pytest.approx(0.0)


# ── Property 3 — echelon coherence ────────────────────────────────────────────


def test_echelon_coherence():
    rng = np.random.default_rng(2)
    req = make_request({"B1": _paths(rng, 10), "B2": _paths(rng, 9), "B3": _paths(rng, 11)})
    resp = run_optimize_network(req)
    dc = next(p for p in resp.node_plans if p.echelon == 1)
    branch_install = sum(next(p.installation_base_stock[t] for p in resp.node_plans if p.node_id == b)
                         for b in ("B1", "B2", "B3") for t in [0])
    # DC echelon base-stock ≥ aggregate branch installation base-stock, every day.
    for t in range(req.horizon_days):
        agg = sum(p.installation_base_stock[t] for p in resp.node_plans if p.echelon == 2)
        assert dc.base_stock[t] >= agg - 1e-6


# ── Property 4 — pooling non-negativity + equality only at ρ ≡ 1 ──────────────


def test_pooling_benefit_positive_when_uncorrelated():
    rng = np.random.default_rng(3)
    # independently drawn branches → imperfect correlation → strictly positive pooling benefit
    req = make_request({"B1": _paths(rng, 10), "B2": _paths(rng, 10), "B3": _paths(rng, 10)})
    resp = run_optimize_network(req)
    assert resp.pooling.pooled_safety_units <= resp.pooling.independent_safety_units + 1e-6
    assert resp.pooling.pooling_benefit_pct > 0.0


def test_pooling_benefit_zero_when_perfectly_correlated():
    rng = np.random.default_rng(4)
    shared = _paths(rng, 10)  # identical demand at every branch → ρ ≡ 1 → no pooling benefit
    req = make_request({"B1": shared, "B2": shared, "B3": shared})
    resp = run_optimize_network(req)
    assert resp.pooling.pooling_benefit_pct == pytest.approx(0.0, abs=1e-6)
    assert resp.pooling.pooled_safety_units == pytest.approx(resp.pooling.independent_safety_units, rel=1e-6)


# ── Property 5 — non-negative net lead time / safety ──────────────────────────


def test_safety_nonnegative_all_nodes():
    rng = np.random.default_rng(5)
    req = make_request({"B1": _paths(rng, 7), "B2": _paths(rng, 13)})
    resp = run_optimize_network(req)
    for p in resp.node_plans:
        assert all(np.isfinite(s) and s >= -1e-9 for s in p.safety_stock)
        assert all(np.isfinite(b) and b >= -1e-9 for b in p.base_stock)


# ── Property 6 — degenerate reduction to the single-tier order ────────────────


def test_degenerate_single_branch_matches_single_tier():
    rng = np.random.default_rng(6)
    d = _paths(rng, 10, noise=0.25)
    # Deterministic branch lead time (std 0) so leads don't depend on RNG → an exact order match.
    req = make_request({"B1": d})
    # zero the branch lane std for determinism
    for lane in req.lanes:
        if lane.to_node == "B1":
            lane.lead_time = LeadTime(mean_days=2, std_days=0)
    resp = run_optimize_network(req)
    branch = next(p for p in resp.node_plans if p.node_id == "B1")
    net_order = sum(o.qty for o in branch.orders)

    # The docs/54 single-tier plan for the SAME item (branch demand, DC→branch lane, economics).
    item = OptimizeItem(
        item_code="ING-1@B1", demand_scenarios=d, current_inventory=[], in_transit=[],
        lead_time=LeadTime(mean_days=2, std_days=0), shelf_life_days=30, review_period_days=1,
        unit_cost=10, unit_price=20,
    )
    single = solve_item(item, dt.date.fromisoformat(START), 14, 20.0, np.random.default_rng(7))
    single_order = sum(o.qty for o in single.orders)
    assert net_order == pytest.approx(single_order, rel=1e-6)
    # one branch → no pooling
    assert resp.pooling.pooling_benefit_pct == pytest.approx(0.0, abs=1e-6)
