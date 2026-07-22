"""Perishable order optimization (docs/54 §1.4–§1.5).

Tiering (solve_item): the closed-form distribution-free newsvendor handles items where shelf life
cannot bind within the planning window (S > H + max sampled lead time) AND no integrality
constraint exists (pack=1, moq=0, fixed cost=0); everything else gets the remaining-life-indexed
SAA MILP. Joint constraints (budget / shared storage) put ALL items of the request into one MILP —
scenario index ω is consistent across items because the API derives every ingredient's path ω from
the same menu-level path ω (correlation preserved).

Both tiers report `expected` metrics from ONE greedy-FEFO simulator (`simulate`) over the FULL
scenario set, so numbers are comparable and the MILP has an independent oracle: selling weakly
dominates holding (price ≥ 0; holding/waste cost ≥ 0), so for a FIXED order schedule the LP
recourse value equals the greedy-FEFO replay — tests/test_fefo_property.py asserts that equality.

Alignment conventions shared by simulator and MILP (do not change one side alone):
  · remaining-life index r ∈ 1..S; r=0 is dead stock (excluded); arrivals enter at r=S
  · expiry: end-of-day leftover at r=1 dies overnight → waste w[t] = I[t,1]
  · holding is charged on the stock that SURVIVES the night: h · Σ_{r≥2} I[t,r]
  · objective = Σ_t [ p·sales − g·lost − (dc−v)·waste − h·holding ] − Σ_t [ c·x_t + F·y_t ]
"""

from __future__ import annotations

import datetime as dt
import math
import time
from dataclasses import dataclass, field

import numpy as np
import pulp

from .contracts import (
    Expected,
    JointConstraints,
    OptimizeItem,
    OptimizeItemPlan,
    PlannedOrder,
    SolverInfo,
)

AGE_CAP = 45  # remaining-life buckets only up to this; beyond it expiry can't bind a ≤56-day window
MILP_MAX_SCENARIOS = 40  # MILP solves a subsample; reporting always re-simulates the full set


class EngineItemFailure(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ── Shared primitives ─────────────────────────────────────────────────────────


def sample_lead_times(mean_days: float, std_days: float, k: int, rng: np.random.Generator) -> np.ndarray:
    """Integer lead times per scenario; Gamma(μ,σ) when σ>0 (right-skewed, never negative).

    mean_days == 0 (same-day market run) is deterministic — the Gamma parameterization below
    divides by the mean, so it must never reach it.
    """
    if mean_days <= 0 or std_days <= 0:
        return np.full(k, max(0, int(round(mean_days))), dtype=int)
    shape = (mean_days / std_days) ** 2
    scale = (std_days * std_days) / mean_days
    draws = rng.gamma(shape, scale, size=k)
    hi = max(1, int(math.ceil(mean_days + 4 * std_days)))
    return np.clip(np.rint(draws).astype(int), 0, hi)


def _costs(item: OptimizeItem) -> tuple[float, float]:
    cu = max(item.unit_price - item.unit_cost, 0.0) + item.goodwill_cost  # underage
    co = max(item.unit_cost - item.salvage_value, 0.0) + item.disposal_cost  # overage
    return cu, co


def _initial_layers(item: OptimizeItem, shelf: int) -> np.ndarray:
    """qty by remaining sellable days r (index 0..S); r=0 = dead stock, excluded from planning."""
    layers = np.zeros(shelf + 1)
    for layer in item.current_inventory:
        layers[min(layer.remaining_days, shelf)] += layer.qty
    return layers


def _in_transit_by_day(item: OptimizeItem, start: dt.date, horizon: int) -> np.ndarray:
    t_arr = np.zeros(horizon)
    for it in item.in_transit:
        t = (dt.date.fromisoformat(it.arrival_ds) - start).days
        t = max(t, 0)
        if t < horizon:
            t_arr[t] += it.qty
    return t_arr


def _round_to_pack(raw: float, item: OptimizeItem) -> float:
    if raw <= 1e-9:
        return 0.0
    qty = math.ceil(raw / item.pack_size - 1e-9) * item.pack_size
    if item.moq > 0:
        qty = max(qty, item.moq)
    return float(qty)


def _validated_scenarios(item: OptimizeItem, horizon: int) -> np.ndarray:
    d = np.asarray(item.demand_scenarios, dtype=float)
    if d.ndim != 2 or d.shape[0] < 1 or d.shape[1] < horizon:
        raise EngineItemFailure(
            "BAD_SCENARIOS",
            f"demand_scenarios must be K×H with H ≥ horizon_days (got {list(d.shape)})",
        )
    return np.clip(d[:, :horizon], 0.0, None)


# ── Greedy-FEFO simulator (the shared oracle) ─────────────────────────────────


def simulate(
    item: OptimizeItem,
    demand: np.ndarray,  # K × H
    lead: np.ndarray,  # K ints
    orders: list[tuple[int, float]],  # (order day, qty)
    start: dt.date,
    horizon: int,
) -> Expected:
    k_count, shelf = demand.shape[0], item.shelf_life_days
    transit = _in_transit_by_day(item, start, horizon)
    order_qty = float(sum(q for _, q in orders))
    n_orders = sum(1 for _, q in orders if q > 0)

    tot_sold = tot_lost = tot_waste = tot_hold = 0.0
    for w in range(k_count):
        layers = _initial_layers(item, shelf).copy()
        arrivals = np.zeros(horizon)
        for t0, q in orders:
            ta = t0 + int(lead[w])
            if ta < horizon:
                arrivals[ta] += q  # beyond-horizon arrivals: paid for, never usable in-window
        for t in range(horizon):
            layers[shelf] += arrivals[t] + transit[t]
            remaining = float(demand[w, t])
            for r in range(1, shelf + 1):
                if remaining <= 0:
                    break
                take = min(layers[r], remaining)
                layers[r] -= take
                remaining -= take
                tot_sold += take
            tot_lost += remaining
            tot_waste += layers[1]  # last-sellable-day leftovers die overnight
            layers[1:shelf] = layers[2 : shelf + 1]  # overnight aging shift
            layers[shelf] = 0.0
            layers[0] = 0.0
            tot_hold += float(layers[1:].sum())

    kf = float(k_count)
    sold, lost, waste, hold = tot_sold / kf, tot_lost / kf, tot_waste / kf, tot_hold / kf
    profit = (
        item.unit_price * sold
        - item.goodwill_cost * lost
        - (item.disposal_cost - item.salvage_value) * waste
        - item.holding_cost_per_day * hold
        - item.unit_cost * order_qty
        - item.fixed_order_cost * n_orders
    )
    dem = float(demand.sum()) / kf
    fill = 1.0 if dem <= 1e-9 else max(0.0, min(1.0, sold / dem))
    waste_cost = (max(item.unit_cost - item.salvage_value, 0.0) + item.disposal_cost) * waste
    return Expected(
        fill_rate=fill,
        lost_sales_units=lost,
        waste_units=waste,
        waste_cost=waste_cost,
        profit=profit,
    )


# ── Dynamic order-up-to / safety-stock reporting (both tiers) ─────────────────


def _per_day_levels(
    item: OptimizeItem, demand: np.ndarray, lead: np.ndarray
) -> tuple[list[float], list[float], float]:
    cu, co = _costs(item)
    cr = cu / (cu + co) if (cu + co) > 0 else 0.0
    k_count, horizon = demand.shape
    csum = np.hstack([np.zeros((k_count, 1)), np.cumsum(demand, axis=1)])  # K × (H+1)
    protection = lead + item.review_period_days
    order_up_to: list[float] = []
    safety: list[float] = []
    idx = np.arange(k_count)
    for t in range(horizon):
        ends = np.minimum(horizon, t + protection)
        sums = csum[idx, ends] - csum[:, t]
        target = float(np.quantile(sums, cr)) if cr > 0 else 0.0
        order_up_to.append(max(target, 0.0))
        safety.append(max(target, 0.0) - float(sums.mean()) if cr > 0 else 0.0)
    return order_up_to, safety, cr


def _orders_out(
    orders: list[tuple[int, float]], start: dt.date, item: OptimizeItem
) -> list[PlannedOrder]:
    mean_l = int(round(item.lead_time.mean_days))
    out = []
    for t0, q in orders:
        if q <= 0:
            continue
        out.append(
            PlannedOrder(
                order_ds=(start + dt.timedelta(days=t0)).isoformat(),
                arrival_ds=(start + dt.timedelta(days=t0 + mean_l)).isoformat(),
                qty=float(q),
                packs=float(q / item.pack_size),
            )
        )
    return out


# ── Tier 1: distribution-free newsvendor (docs/54 §1.4) ───────────────────────


def newsvendor_plan(
    item: OptimizeItem,
    demand: np.ndarray,
    lead: np.ndarray,
    start: dt.date,
    horizon: int,
) -> OptimizeItemPlan:
    t_start = time.perf_counter()
    order_up_to, safety, cr = _per_day_levels(item, demand, lead)

    # Standard (R, S) periodic review: at each review epoch raise the INVENTORY POSITION (on hand +
    # everything already on order) to that day's order-up-to level. Emitting the whole schedule —
    # not just day 0 — is what makes the newsvendor tier's `expected` metrics comparable to the
    # MILP's: simulating a single order across a multi-day horizon would understate it badly.
    # The projection uses the MEAN demand path because first-stage orders cannot depend on ω.
    orders: list[tuple[int, float]] = []
    if cr > 0:
        shelf = item.shelf_life_days
        on_hand = float(sum(l.qty for l in item.current_inventory if min(l.remaining_days, shelf) >= 1))
        mean_demand = demand.mean(axis=0)
        arrivals = _in_transit_by_day(item, start, horizon)
        mean_lead = int(round(item.lead_time.mean_days))
        proj = on_hand  # projected on-hand at the START of day t (before that day's arrivals)
        for t in range(horizon):
            if t % item.review_period_days == 0:
                position = proj + float(arrivals[t:].sum())  # on hand + on order
                qty = _round_to_pack(order_up_to[t] - position, item)
                if qty > 0:
                    orders.append((t, qty))
                    if t + mean_lead < horizon:
                        arrivals[t + mean_lead] += qty
            proj = max(0.0, proj + float(arrivals[t]) - float(mean_demand[t]))

    expected = simulate(item, demand, lead, orders, start, horizon)
    return OptimizeItemPlan(
        item_code=item.item_code,
        method="newsvendor",
        orders=_orders_out(orders, start, item),
        order_up_to=order_up_to,
        safety_stock=safety,
        expected=expected,
        solver=SolverInfo(
            status="optimal", gap=None, ms=int((time.perf_counter() - t_start) * 1000)
        ),
    )


# ── Tier 2: remaining-life SAA MILP (docs/54 §1.5) ────────────────────────────


@dataclass
class _ItemBlock:
    item: OptimizeItem
    n: dict[int, pulp.LpVariable]
    y: dict[int, pulp.LpVariable]
    order_days: list[int]
    obj_terms: list = field(default_factory=list)
    live: dict[tuple[int, int], object] = field(default_factory=dict)  # (ω,t) → surviving-stock expr
    purchase_cost: object = 0


def _build_item_block(
    prob: pulp.LpProblem,
    item: OptimizeItem,
    demand: np.ndarray,
    lead: np.ndarray,
    start: dt.date,
    horizon: int,
    tag: str,
) -> _ItemBlock:
    k_count = demand.shape[0]
    shelf = item.shelf_life_days
    aged = shelf <= min(AGE_CAP, horizon + int(lead.max()))
    transit = _in_transit_by_day(item, start, horizon)
    pack, moq, fixed = item.pack_size, item.moq, item.fixed_order_cost
    price, cost = item.unit_price, item.unit_cost
    goodwill, hold_c = item.goodwill_cost, item.holding_cost_per_day
    waste_c = item.disposal_cost - item.salvage_value

    max_need = float(demand.sum(axis=1).max()) if demand.size else 0.0
    big_m = max(moq, pack) + 1.5 * max_need + pack
    min_l = int(lead.min())
    order_days = [t for t in range(horizon) if t + min_l <= horizon - 1]

    n = {t: pulp.LpVariable(f"n_{tag}_{t}", lowBound=0, cat="Integer") for t in order_days}
    y = {t: pulp.LpVariable(f"y_{tag}_{t}", cat="Binary") for t in order_days}
    x = {t: pack * n[t] for t in order_days}
    for t in order_days:
        prob += x[t] <= big_m * y[t], f"bigM_{tag}_{t}"
        if moq > 0:
            prob += x[t] >= moq * y[t], f"moq_{tag}_{t}"

    blk = _ItemBlock(item=item, n=n, y=y, order_days=order_days)
    blk.purchase_cost = pulp.lpSum(cost * x[t] for t in order_days)
    first_stage = pulp.lpSum(cost * x[t] + fixed * y[t] for t in order_days)
    blk.obj_terms.append(-first_stage)

    layers0 = _initial_layers(item, shelf)
    weight = 1.0 / k_count

    for w in range(k_count):
        lw = int(lead[w])
        arrivals: dict[int, object] = {}
        for t in range(horizon):
            expr = float(transit[t])
            for t0 in order_days:
                if t0 + lw == t:
                    expr = expr + x[t0]
            arrivals[t] = expr

        if aged:
            inv = {}
            sold = {}
            for t in range(horizon):
                for r in range(1, shelf + 1):
                    inv[(t, r)] = pulp.LpVariable(f"I_{tag}_{w}_{t}_{r}", lowBound=0)
                    sold[(t, r)] = pulp.LpVariable(f"s_{tag}_{w}_{t}_{r}", lowBound=0)
            for t in range(horizon):
                u = pulp.LpVariable(f"u_{tag}_{w}_{t}", lowBound=0)
                for r in range(1, shelf + 1):
                    if t == 0:
                        avail = float(layers0[r]) + (arrivals[0] if r == shelf else 0)
                    else:
                        avail = (inv[(t - 1, r + 1)] if r < shelf else 0) + (
                            arrivals[t] if r == shelf else 0
                        )
                    prob += inv[(t, r)] == avail - sold[(t, r)], f"bal_{tag}_{w}_{t}_{r}"
                prob += (
                    pulp.lpSum(sold[(t, r)] for r in range(1, shelf + 1)) + u
                    == float(demand[w, t])
                ), f"dem_{tag}_{w}_{t}"
                sell_t = pulp.lpSum(sold[(t, r)] for r in range(1, shelf + 1))
                waste_t = inv[(t, 1)]
                surv_t = pulp.lpSum(inv[(t, r)] for r in range(2, shelf + 1))
                blk.live[(w, t)] = surv_t
                blk.obj_terms.append(
                    weight
                    * (price * sell_t - goodwill * u - waste_c * waste_t - hold_c * surv_t)
                )
        else:
            # Bulk model — expiry cannot bind within the window, so no age dimension (waste ≡ 0).
            prev = float(layers0[1:].sum())
            for t in range(horizon):
                inv_t = pulp.LpVariable(f"I_{tag}_{w}_{t}", lowBound=0)
                sell_t = pulp.LpVariable(f"s_{tag}_{w}_{t}", lowBound=0)
                u = pulp.LpVariable(f"u_{tag}_{w}_{t}", lowBound=0)
                prob += inv_t == prev + arrivals[t] - sell_t, f"bal_{tag}_{w}_{t}"
                prob += sell_t + u == float(demand[w, t]), f"dem_{tag}_{w}_{t}"
                blk.live[(w, t)] = inv_t
                blk.obj_terms.append(weight * (price * sell_t - goodwill * u - hold_c * inv_t))
                prev = inv_t
    return blk


def _extract_orders(blk: _ItemBlock) -> list[tuple[int, float]]:
    orders = []
    for t in blk.order_days:
        packs = blk.n[t].varValue or 0.0
        if packs > 0.5:
            orders.append((t, float(round(packs)) * blk.item.pack_size))
    return orders


def milp_plan(
    item: OptimizeItem,
    demand: np.ndarray,
    lead: np.ndarray,
    start: dt.date,
    horizon: int,
    time_budget_s: float,
    rng: np.random.Generator | None = None,
    max_scenarios: int | None = MILP_MAX_SCENARIOS,
) -> OptimizeItemPlan:
    t_start = time.perf_counter()
    d_solve, l_solve = demand, lead
    if max_scenarios and demand.shape[0] > max_scenarios:
        idx = (rng or np.random.default_rng(0)).choice(demand.shape[0], max_scenarios, replace=False)
        d_solve, l_solve = demand[idx], lead[idx]

    prob = pulp.LpProblem("replenish", pulp.LpMaximize)
    blk = _build_item_block(prob, item, d_solve, l_solve, start, horizon, "i0")
    prob += pulp.lpSum(blk.obj_terms)
    prob.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=max(1, int(time_budget_s))))
    status = pulp.LpStatus.get(prob.status, "Unknown")

    if status != "Optimal":
        # Timeout/infeasible: fall back to the closed form; surface what happened in solver.status.
        nv = newsvendor_plan(item, demand, lead, start, horizon)
        nv.solver.status = f"milp_{status.lower()}_fallback_newsvendor"
        return nv

    orders = _extract_orders(blk)
    order_up_to, safety, _cr = _per_day_levels(item, demand, lead)
    expected = simulate(item, demand, lead, orders, start, horizon)
    return OptimizeItemPlan(
        item_code=item.item_code,
        method="milp",
        orders=_orders_out(orders, start, item),
        order_up_to=order_up_to,
        safety_stock=safety,
        expected=expected,
        solver=SolverInfo(
            status="Optimal", gap=None, ms=int((time.perf_counter() - t_start) * 1000)
        ),
    )


def solve_joint(
    items: list[OptimizeItem],
    demands: list[np.ndarray],
    leads: list[np.ndarray],
    start: dt.date,
    horizon: int,
    joint: JointConstraints,
    time_budget_s: float,
    rng: np.random.Generator,
) -> list[OptimizeItemPlan]:
    """One MILP over all items with shared budget/storage rows. ω is consistent across items
    (each ingredient's path ω derives from the same menu path ω), so per-(ω,t) coupling is sound."""
    t_start = time.perf_counter()
    k_all = {d.shape[0] for d in demands}
    if len(k_all) != 1:
        raise EngineItemFailure("BAD_SCENARIOS", "joint optimization requires equal K across items")
    k_count = k_all.pop()
    idx = None
    if k_count > MILP_MAX_SCENARIOS:
        idx = rng.choice(k_count, MILP_MAX_SCENARIOS, replace=False)

    prob = pulp.LpProblem("replenish_joint", pulp.LpMaximize)
    blocks: list[_ItemBlock] = []
    for i, (item, d, l) in enumerate(zip(items, demands, leads)):
        ds, ls = (d[idx], l[idx]) if idx is not None else (d, l)
        blocks.append(_build_item_block(prob, item, ds, ls, start, horizon, f"i{i}"))
    prob += pulp.lpSum(t for b in blocks for t in b.obj_terms)

    if joint.budget is not None:
        prob += pulp.lpSum(b.purchase_cost for b in blocks) <= joint.budget, "joint_budget"
    if joint.storage_capacity is not None:
        k_eff = MILP_MAX_SCENARIOS if idx is not None else k_count
        for w in range(k_eff):
            for t in range(horizon):
                prob += (
                    pulp.lpSum(b.live[(w, t)] for b in blocks) <= joint.storage_capacity
                ), f"joint_storage_{w}_{t}"

    prob.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=max(1, int(time_budget_s))))
    status = pulp.LpStatus.get(prob.status, "Unknown")
    ms = int((time.perf_counter() - t_start) * 1000)

    plans: list[OptimizeItemPlan] = []
    for b, d, l in zip(blocks, demands, leads):
        if status != "Optimal":
            nv = newsvendor_plan(b.item, d, l, start, horizon)
            nv.solver.status = f"joint_{status.lower()}_fallback_newsvendor"
            plans.append(nv)
            continue
        orders = _extract_orders(b)
        order_up_to, safety, _cr = _per_day_levels(b.item, d, l)
        plans.append(
            OptimizeItemPlan(
                item_code=b.item.item_code,
                method="milp",
                orders=_orders_out(orders, start, b.item),
                order_up_to=order_up_to,
                safety_stock=safety,
                expected=simulate(b.item, d, l, orders, start, horizon),
                solver=SolverInfo(status="Optimal", gap=None, ms=ms),
            )
        )
    return plans


# ── Tiering entry point ───────────────────────────────────────────────────────


def solve_item(
    item: OptimizeItem,
    start: dt.date,
    horizon: int,
    time_budget_s: float,
    rng: np.random.Generator,
) -> OptimizeItemPlan:
    demand = _validated_scenarios(item, horizon)
    lead = sample_lead_times(item.lead_time.mean_days, item.lead_time.std_days, demand.shape[0], rng)
    shelf_binds = item.shelf_life_days <= horizon + int(lead.max())
    integral = item.pack_size > 1 or item.moq > 0 or item.fixed_order_cost > 0
    if not shelf_binds and not integral:
        return newsvendor_plan(item, demand, lead, start, horizon)
    return milp_plan(item, demand, lead, start, horizon, time_budget_s, rng=rng)


def solver_selftest() -> None:
    """Two-variable LP through CBC — raises if the bundled solver binary is unusable."""
    prob = pulp.LpProblem("selftest", pulp.LpMaximize)
    a = pulp.LpVariable("a", lowBound=0, upBound=1)
    b = pulp.LpVariable("b", lowBound=0, upBound=1)
    prob += a + 2 * b
    prob += a + b <= 1.5
    prob.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=5))
    if pulp.LpStatus.get(prob.status) != "Optimal":
        raise RuntimeError(f"CBC selftest failed: {pulp.LpStatus.get(prob.status)}")
