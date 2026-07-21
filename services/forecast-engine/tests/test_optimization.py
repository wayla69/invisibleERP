"""Optimizer soundness (docs/54 §1.4–§1.5).

These are the tests that make the engine trustworthy rather than merely runnable:
  · newsvendor hits the analytic critical-ratio quantile
  · the MILP converges to that same quantile in the single-period unconstrained limit
  · the FEFO simulator agrees with the MILP's own recourse valuation on the SAME order schedule
  · shelf life actually suppresses over-ordering; MOQ/pack integrality is respected
"""

from __future__ import annotations

import datetime as dt

import numpy as np
import pytest

from app.contracts import InTransitArrival, InventoryLayer, JointConstraints, LeadTime, OptimizeItem
from app.optimization import (
    milp_plan,
    newsvendor_plan,
    sample_lead_times,
    simulate,
    solve_item,
    solve_joint,
)

START = dt.date(2026, 7, 1)


def make_item(**over) -> OptimizeItem:
    base = dict(
        item_code="ING-TEST",
        demand_scenarios=[[10.0]],
        current_inventory=[],
        in_transit=[],
        lead_time=LeadTime(mean_days=0, std_days=0),
        shelf_life_days=30,
        review_period_days=1,
        unit_cost=10.0,
        unit_price=25.0,
        salvage_value=0.0,
        disposal_cost=0.0,
        goodwill_cost=0.0,
        holding_cost_per_day=0.0,
        moq=0.0,
        pack_size=1.0,
        fixed_order_cost=0.0,
    )
    base.update(over)
    return OptimizeItem(**base)


def lognormal_demand(k: int = 400, h: int = 1, seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return np.round(rng.lognormal(mean=3.0, sigma=0.5, size=(k, h)), 3)


# ── §1.4 newsvendor ───────────────────────────────────────────────────────────


def test_newsvendor_orders_the_critical_ratio_quantile():
    demand = lognormal_demand()
    item = make_item(demand_scenarios=demand.tolist(), unit_cost=10.0, unit_price=25.0)
    # Cu = 25-10 = 15, Co = 10 → CR = 0.6
    expected_q = float(np.quantile(demand[:, 0], 0.6))
    plan = newsvendor_plan(item, demand, np.zeros(demand.shape[0], dtype=int), START, 1)
    assert plan.orders[0].qty == pytest.approx(np.ceil(expected_q), abs=1.0)
    assert plan.order_up_to[0] == pytest.approx(expected_q, rel=1e-6)


def test_high_margin_raises_the_service_level():
    demand = lognormal_demand()
    lead = np.zeros(demand.shape[0], dtype=int)
    cheap = newsvendor_plan(make_item(demand_scenarios=demand.tolist(), unit_price=12.0), demand, lead, START, 1)
    rich = newsvendor_plan(make_item(demand_scenarios=demand.tolist(), unit_price=90.0), demand, lead, START, 1)
    assert rich.order_up_to[0] > cheap.order_up_to[0]


def test_disposal_cost_lowers_the_order():
    demand = lognormal_demand()
    lead = np.zeros(demand.shape[0], dtype=int)
    plain = newsvendor_plan(make_item(demand_scenarios=demand.tolist()), demand, lead, START, 1)
    costly = newsvendor_plan(
        make_item(demand_scenarios=demand.tolist(), disposal_cost=20.0), demand, lead, START, 1
    )
    assert costly.order_up_to[0] < plain.order_up_to[0]


def test_on_hand_and_in_transit_net_off_the_order():
    demand = lognormal_demand()
    lead = np.zeros(demand.shape[0], dtype=int)
    bare = newsvendor_plan(make_item(demand_scenarios=demand.tolist()), demand, lead, START, 1)
    stocked = newsvendor_plan(
        make_item(
            demand_scenarios=demand.tolist(),
            current_inventory=[InventoryLayer(remaining_days=5, qty=8.0)],
            in_transit=[InTransitArrival(arrival_ds=START.isoformat(), qty=4.0)],
        ),
        demand,
        lead,
        START,
        1,
    )
    ordered_bare = bare.orders[0].qty if bare.orders else 0.0
    ordered_stocked = stocked.orders[0].qty if stocked.orders else 0.0
    assert ordered_stocked == pytest.approx(max(ordered_bare - 12.0, 0.0), abs=1.0)


# ── §1.5 MILP ⇄ §1.4 newsvendor equivalence ───────────────────────────────────


def test_milp_matches_newsvendor_in_the_single_period_limit():
    """H=1, no MOQ/pack/fixed cost, shelf life non-binding ⇒ both tiers solve the same problem."""
    demand = lognormal_demand(k=60, h=1, seed=11)
    lead = np.zeros(demand.shape[0], dtype=int)
    item = make_item(demand_scenarios=demand.tolist(), shelf_life_days=1)
    nv = newsvendor_plan(item, demand, lead, START, 1)
    milp = milp_plan(item, demand, lead, START, 1, time_budget_s=30, max_scenarios=None)
    nv_qty = nv.orders[0].qty if nv.orders else 0.0
    milp_qty = milp.orders[0].qty if milp.orders else 0.0
    # Same optimum within one discrete unit (newsvendor rounds up to a whole unit).
    assert milp_qty == pytest.approx(nv_qty, abs=1.5)


def test_milp_respects_pack_size_and_moq():
    demand = np.full((20, 3), 7.0)
    lead = np.zeros(20, dtype=int)
    item = make_item(demand_scenarios=demand.tolist(), shelf_life_days=2, pack_size=6.0, moq=12.0)
    plan = milp_plan(item, demand, lead, START, 3, time_budget_s=30, max_scenarios=None)
    for order in plan.orders:
        assert order.qty % 6.0 == pytest.approx(0.0, abs=1e-6)
        assert order.qty >= 12.0


def test_shelf_life_caps_bulk_buying():
    """A 2-day-life item cannot profitably pre-buy the whole horizon; a 60-day one can."""
    demand = np.full((12, 10), 10.0)
    lead = np.zeros(12, dtype=int)
    fresh = solve_item(
        make_item(demand_scenarios=demand.tolist(), shelf_life_days=2, fixed_order_cost=5.0),
        START,
        10,
        30,
        np.random.default_rng(3),
    )
    keeps = solve_item(
        make_item(demand_scenarios=demand.tolist(), shelf_life_days=60, fixed_order_cost=5.0),
        START,
        10,
        30,
        np.random.default_rng(3),
    )
    biggest_fresh = max((o.qty for o in fresh.orders), default=0.0)
    biggest_keeps = max((o.qty for o in keeps.orders), default=0.0)
    assert biggest_fresh <= 30.0  # a couple of days of cover at most
    assert biggest_keeps > biggest_fresh
    assert fresh.expected.waste_units <= 1e-6


def test_tiering_picks_newsvendor_only_when_nothing_binds():
    demand = np.full((10, 5), 4.0)
    plain = solve_item(
        make_item(demand_scenarios=demand.tolist(), shelf_life_days=90), START, 5, 20, np.random.default_rng(1)
    )
    perishable = solve_item(
        make_item(demand_scenarios=demand.tolist(), shelf_life_days=3), START, 5, 20, np.random.default_rng(1)
    )
    packed = solve_item(
        make_item(demand_scenarios=demand.tolist(), shelf_life_days=90, pack_size=5.0),
        START,
        5,
        20,
        np.random.default_rng(1),
    )
    assert plain.method == "newsvendor"
    assert perishable.method == "milp"
    assert packed.method == "milp"


# ── FEFO property (the simulator is the MILP's independent oracle) ─────────────


def test_simulator_reports_waste_for_unsellable_perishable_stock():
    item = make_item(
        shelf_life_days=2,
        current_inventory=[InventoryLayer(remaining_days=1, qty=10.0)],
        disposal_cost=1.0,
    )
    demand = np.zeros((1, 3))
    got = simulate(item, demand, np.zeros(1, dtype=int), [], START, 3)
    assert got.waste_units == pytest.approx(10.0)
    assert got.waste_cost == pytest.approx(10.0 * (item.unit_cost + 1.0))


def test_simulator_consumes_oldest_stock_first():
    """Two layers, demand for exactly one: the SHORTER-life layer must be the one consumed."""
    item = make_item(
        shelf_life_days=10,
        current_inventory=[InventoryLayer(remaining_days=1, qty=5.0), InventoryLayer(remaining_days=9, qty=5.0)],
    )
    demand = np.array([[5.0, 0.0]])
    got = simulate(item, demand, np.zeros(1, dtype=int), [], START, 2)
    assert got.lost_sales_units == pytest.approx(0.0)
    assert got.waste_units == pytest.approx(0.0)  # FEFO ⇒ the near-expiry layer sold, nothing died


def test_lifo_consumption_would_have_wasted_stock():
    """Same fixture, demand only on day 2: the r=1 layer expires overnight — waste is unavoidable."""
    item = make_item(
        shelf_life_days=10,
        current_inventory=[InventoryLayer(remaining_days=1, qty=5.0), InventoryLayer(remaining_days=9, qty=5.0)],
    )
    demand = np.array([[0.0, 5.0]])
    got = simulate(item, demand, np.zeros(1, dtype=int), [], START, 2)
    assert got.waste_units == pytest.approx(5.0)


def test_simulator_agrees_with_milp_objective_on_the_same_schedule():
    """MILP recourse value ≡ greedy-FEFO replay for a FIXED order schedule (docs/54 §1.5 property b).

    Solve the MILP, then replay its own orders through the simulator: the profit the simulator
    reports must match the MILP objective (same scenarios, same alignment conventions).
    """
    rng = np.random.default_rng(5)
    demand = np.round(rng.gamma(shape=9.0, scale=1.2, size=(8, 6)), 3)
    lead = np.zeros(8, dtype=int)
    item = make_item(
        demand_scenarios=demand.tolist(),
        shelf_life_days=3,
        holding_cost_per_day=0.2,
        disposal_cost=2.0,
        goodwill_cost=1.5,
        fixed_order_cost=4.0,
    )
    plan = milp_plan(item, demand, lead, START, 6, time_budget_s=60, max_scenarios=None)
    assert plan.solver.status == "Optimal"
    orders = [((dt.date.fromisoformat(o.order_ds) - START).days, o.qty) for o in plan.orders]
    replay = simulate(item, demand, lead, orders, START, 6)
    assert replay.profit == pytest.approx(plan.expected.profit, rel=1e-9)
    # And the MILP is at least as good as the closed form on the perishable case it was chosen for.
    nv = newsvendor_plan(item, demand, lead, START, 6)
    assert plan.expected.profit >= nv.expected.profit - 1e-6


def test_stochastic_lead_time_sampling_is_positive_and_skewed():
    rng = np.random.default_rng(2)
    draws = sample_lead_times(3.0, 1.5, 5000, rng)
    assert draws.min() >= 0
    assert 2.6 <= draws.mean() <= 3.4
    assert draws.max() > draws.mean()  # right tail exists — the reason SS is quantile-based


def test_zero_variance_lead_time_is_deterministic():
    draws = sample_lead_times(4.0, 0.0, 50, np.random.default_rng(0))
    assert set(draws.tolist()) == {4}


# ── Joint constraints ─────────────────────────────────────────────────────────


def test_joint_budget_caps_total_spend():
    demand = np.full((6, 4), 8.0)
    items = [
        make_item(item_code="A", demand_scenarios=demand.tolist(), shelf_life_days=3, unit_cost=10.0),
        make_item(item_code="B", demand_scenarios=demand.tolist(), shelf_life_days=3, unit_cost=10.0),
    ]
    demands = [demand, demand]
    leads = [np.zeros(6, dtype=int), np.zeros(6, dtype=int)]
    plans = solve_joint(
        items, demands, leads, START, 4, JointConstraints(budget=300.0), 60, np.random.default_rng(0)
    )
    spend = sum(o.qty * 10.0 for p in plans for o in p.orders)
    assert spend <= 300.0 + 1e-6
    assert {p.item_code for p in plans} == {"A", "B"}
