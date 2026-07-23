"""Pydantic mirrors of the TS zod contract (packages/shared/src/scm-engine.ts — the source of truth).

Field-for-field parity is enforced by round-tripping the shared JSON fixtures in BOTH test suites
(tests/test_contract_fixtures.py here; apps/api/test/scm-contract.test.ts on the TS side). Unknown
fields are IGNORED (zod's default strip semantics) so additive contract evolution never breaks an
older engine.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

CONTRACT_VERSION = "2"  # v2 (docs/56 A1): per-series promo/price regressors + attribution output

DS_PATTERN = r"^\d{4}-\d{2}-\d{2}$"  # Asia/Bangkok business day (bizYmd)


# ── /v1/forecast ──────────────────────────────────────────────────────────────


class DemandPoint(BaseModel):
    ds: str = Field(pattern=DS_PATTERN)
    y: float = Field(ge=0)
    # True = that day's sales were supply-capped (right-censored demand) — excluded from the fit.
    stockout: Optional[bool] = None


class HolidayEvent(BaseModel):
    name: str = Field(min_length=1)
    ds: str = Field(pattern=DS_PATTERN)
    lower_window: int = Field(default=0, ge=-7, le=0)
    upper_window: int = Field(default=0, ge=0, le=7)
    prior_scale: Optional[float] = Field(default=None, gt=0)


class SeriesRegressor(BaseModel):
    """docs/56 A1 — a governed promo/price signal for one (series, business day). Dense over
    history∪horizon; the API derives these from approved promotions/price_rules/price_books, never
    from client input. On future days they are the operator's planned calendar/price."""

    ds: str = Field(pattern=DS_PATTERN)
    promo_flag: bool = False  # a governed promo is active on this (series, day)
    discount_pct: Optional[float] = Field(default=None, ge=0, le=1)
    price: Optional[float] = Field(default=None, ge=0)  # effective/planned unit price that day


class SeriesInput(BaseModel):
    series_id: str = Field(min_length=1)
    history: list[DemandPoint] = Field(min_length=1)
    class_hint: Literal["auto", "smooth", "intermittent", "lumpy", "short"] = "auto"
    regressors: Optional[list[SeriesRegressor]] = None  # A1: dense over history∪horizon
    analog_of: Optional[list[str]] = None  # A4 (reserved): donor series_ids for a zero-history sku


class HierarchyNode(BaseModel):
    node_id: str = Field(min_length=1)
    parent_id: Optional[str] = None  # null = a root (the total)
    series_id: Optional[str] = None  # set ⇔ a LEAF; must match a series[].series_id


class Reconciliation(BaseModel):
    method: Literal["none", "bottom_up", "top_down_hist", "mint"] = "none"
    covariance: Literal["ols", "wls_struct", "wls_var", "shrink"] = "wls_struct"  # MinT only (C3)
    nodes: list[HierarchyNode] = Field(min_length=1)
    reconcile_paths: bool = True


class ForecastRequest(BaseModel):
    contract_version: Literal["2"]
    request_id: str = Field(min_length=1)  # idempotency + deterministic RNG seed
    horizon_days: int = Field(ge=1, le=56)
    scenario_count: int = Field(default=50, ge=10, le=100)
    quantiles: list[float] = Field(default=[0.1, 0.5, 0.9])
    holidays: list[HolidayEvent]
    closures: list[str] = Field(default_factory=list)
    payday_regressor: bool = True
    promo_regressor: bool = True  # A1: fit/apply the promo regressor where series carry it
    price_regressor: bool = True  # A1: fit the (log) price regressor where series carry it
    scenario: bool = False  # A1: advisory what-if — never feeds an auto-convert plan (SCM-04)
    reconciliation: Optional[Reconciliation] = None  # C2: coherent hierarchical reconciliation
    series: list[SeriesInput] = Field(min_length=1, max_length=200)


class ForecastPoint(BaseModel):
    ds: str
    yhat: float = Field(ge=0)
    q: dict[str, float]


class Accuracy(BaseModel):
    wape: Optional[float]
    cutoffs: int


class Attribution(BaseModel):
    """docs/56 A1 — what shaped this forecast, so the plan can surface promo attribution and a
    reviewer can tie a moved quantity back to a governed input (SCM-04)."""

    promo_uplift_pct: Optional[float] = None  # fitted/applied lift on promo days vs baseline
    price_elasticity: Optional[float] = None  # ε used this run (A2; null/0 in A1)
    elasticity_r2: Optional[float] = None
    elasticity_n_obs: Optional[int] = None
    regressors_used: list[str] = Field(default_factory=list)  # subset of promo|price|payday|analog|cross


class ForecastSeriesResult(BaseModel):
    # `model` is contract vocabulary, not a pydantic-reserved word — silence the namespace warning.
    model_config = ConfigDict(protected_namespaces=())

    series_id: str
    model: Literal["prophet", "croston_sba", "bootstrap", "baseline_dow"]
    points: list[ForecastPoint]
    # K × H sample paths — the load-bearing output; BoM explosion sums PATHS per scenario
    # (quantiles are not additive) and the sums feed /v1/optimize as demand_scenarios.
    sample_paths: list[list[float]]
    accuracy: Accuracy
    attribution: Optional[Attribution] = None  # A1


class EngineItemError(BaseModel):
    ref: str
    code: str
    message: str


class ReconciledNodeResult(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    node_id: str
    level: int = Field(ge=0)  # 0 = leaf, increasing toward the root
    method: Literal["bottom_up", "top_down_hist", "mint"]
    points: list[ForecastPoint]
    sample_paths: list[list[float]]
    accuracy: Accuracy
    attribution: Optional[Attribution] = None


class ForecastResponse(BaseModel):
    contract_version: Literal["2"]
    request_id: str
    results: list[ForecastSeriesResult]
    reconciled: list[ReconciledNodeResult] = Field(default_factory=list)  # C2
    errors: list[EngineItemError] = Field(default_factory=list)


# ── /v1/optimize ──────────────────────────────────────────────────────────────


class InventoryLayer(BaseModel):
    # Days of sellable life remaining; 0 = expires today (not sellable — treated as dead stock).
    remaining_days: int = Field(ge=0)
    qty: float = Field(ge=0)


class InTransitArrival(BaseModel):
    arrival_ds: str = Field(pattern=DS_PATTERN)
    qty: float = Field(ge=0)


class LeadTime(BaseModel):
    # 0 is legitimate — a morning market run that arrives the same day.
    mean_days: float = Field(ge=0)
    std_days: float = Field(ge=0)


class OptimizeItem(BaseModel):
    item_code: str = Field(min_length=1)
    demand_scenarios: list[list[float]]  # K × H ingredient-unit paths (post-BoM-explosion)
    current_inventory: list[InventoryLayer]
    in_transit: list[InTransitArrival]
    lead_time: LeadTime
    shelf_life_days: int = Field(ge=1, le=365)
    review_period_days: int = Field(default=1, ge=1)
    unit_cost: float = Field(ge=0)
    unit_price: float = Field(ge=0)  # stockout-value proxy for ingredients
    salvage_value: float = Field(default=0, ge=0)
    disposal_cost: float = Field(default=0, ge=0)
    goodwill_cost: float = Field(default=0, ge=0)
    holding_cost_per_day: float = Field(default=0, ge=0)
    moq: float = Field(default=0, ge=0)
    pack_size: float = Field(default=1, gt=0)
    fixed_order_cost: float = Field(default=0, ge=0)
    waste_rate_prior: Optional[float] = Field(default=None, ge=0, le=1)


class JointConstraints(BaseModel):
    budget: Optional[float] = Field(default=None, gt=0)
    storage_capacity: Optional[float] = Field(default=None, gt=0)


class OptimizeRequest(BaseModel):
    contract_version: Literal["2"]
    request_id: str = Field(min_length=1)
    start_ds: str = Field(pattern=DS_PATTERN)  # plan day 0 — anchors in_transit dates ↔ day offsets
    horizon_days: int = Field(ge=1, le=56)
    items: list[OptimizeItem] = Field(min_length=1, max_length=300)
    joint: Optional[JointConstraints] = None
    time_budget_ms: int = 20_000


class PlannedOrder(BaseModel):
    order_ds: str
    arrival_ds: str
    qty: float = Field(ge=0)
    packs: float = Field(ge=0)


class Expected(BaseModel):
    # All five come from ONE greedy-FEFO simulator over the full scenario set (§ optimization.simulate)
    # so newsvendor and MILP plans are comparable and the MILP has an independent oracle.
    fill_rate: float = Field(ge=0, le=1)
    lost_sales_units: float = Field(ge=0)
    waste_units: float = Field(ge=0)
    waste_cost: float
    profit: float


class SolverInfo(BaseModel):
    status: str
    gap: Optional[float]
    ms: int


class OptimizeItemPlan(BaseModel):
    item_code: str
    method: Literal["newsvendor", "milp"]
    orders: list[PlannedOrder]
    order_up_to: list[float]  # per horizon day — dynamic order-up-to level S*
    safety_stock: list[float]  # per horizon day — S* − E[demand over protection period]
    expected: Expected
    solver: SolverInfo


class OptimizeResponse(BaseModel):
    contract_version: Literal["2"]
    request_id: str
    plans: list[OptimizeItemPlan]
    errors: list[EngineItemError] = Field(default_factory=list)


# ── /v1/optimize-network (docs/57 Track B · B2) ─────────────────────────────────
# Two-echelon (supplier → DC → branch) guaranteed-service MEIO base-stock with risk pooling. Additive
# to v2 — a new route; /v1/forecast and /v1/optimize are unchanged.


class NetworkNode(BaseModel):
    node_id: str = Field(min_length=1)
    kind: Literal["supplier", "central_kitchen", "dc", "branch"]
    echelon: int = Field(ge=0, le=2)  # 0 supplier · 1 DC · 2 branch (leaf)
    service_time_out_days: Optional[float] = Field(default=None, ge=0)  # branch = 0; DC = decision
    holding_cost_per_day: float = Field(default=0, ge=0)
    current_inventory: list[InventoryLayer] = Field(default_factory=list)
    in_transit: list[InTransitArrival] = Field(default_factory=list)


class NetworkLane(BaseModel):
    from_node: str = Field(min_length=1)
    to_node: str = Field(min_length=1)
    lead_time: LeadTime
    unit_cost: float = Field(default=0, ge=0)
    moq: float = Field(default=0, ge=0)
    pack_size: float = Field(default=1, gt=0)
    fixed_order_cost: float = Field(default=0, ge=0)


class DemandPath(BaseModel):
    node_id: str = Field(min_length=1)  # a leaf/branch node
    demand_scenarios: list[list[float]]  # K × H post-BoM-explosion paths


class NetworkAllocationPolicy(BaseModel):
    method: Literal["proportional", "fair_share", "priority"] = "proportional"
    priorities: Optional[dict[str, float]] = None  # node_id → priority (higher served first)


class OptimizeNetworkRequest(BaseModel):
    contract_version: Literal["2"]
    request_id: str = Field(min_length=1)
    start_ds: str = Field(pattern=DS_PATTERN)
    horizon_days: int = Field(ge=1, le=56)
    item_code: str = Field(min_length=1)
    shelf_life_days: int = Field(ge=1, le=365)
    review_period_days: int = Field(default=1, ge=1)
    unit_price: float = Field(ge=0)
    unit_cost: float = Field(default=0, ge=0)
    salvage_value: float = Field(default=0, ge=0)
    disposal_cost: float = Field(default=0, ge=0)
    goodwill_cost: float = Field(default=0, ge=0)
    service_level: float = Field(default=0.95, ge=0.5, le=0.999)
    nodes: list[NetworkNode] = Field(min_length=1)
    lanes: list[NetworkLane] = Field(min_length=1)
    demand_paths: list[DemandPath] = Field(min_length=1)
    allocation: NetworkAllocationPolicy = Field(default_factory=NetworkAllocationPolicy)
    time_budget_ms: int = 20_000


class NetworkOrder(BaseModel):
    order_ds: str
    arrival_ds: str
    from_node: str
    qty: float = Field(ge=0)
    packs: float = Field(ge=0)


class NetworkNodePlan(BaseModel):
    node_id: str
    echelon: int
    service_time_out_days: float  # the GSM decision at this node
    base_stock: list[float]  # per horizon day — ECHELON base-stock (own + all downstream)
    installation_base_stock: list[float]  # per horizon day — installation (own) base-stock
    safety_stock: list[float]  # per horizon day
    orders: list[NetworkOrder]
    expected: Expected


class NetworkAllocationLine(BaseModel):
    ds: str
    from_node: str
    to_node: str
    requested: float = Field(ge=0)
    allocated: float = Field(ge=0)
    shortfall: float = Field(ge=0)


class PoolingReport(BaseModel):
    independent_safety_units: float = Field(ge=0)  # Σ_i z·σ_i·√P
    pooled_safety_units: float = Field(ge=0)  # z·σ_DC·√P
    pooling_benefit_pct: float  # (independent − pooled)/independent · 100; ≥ 0, 0 only at ρ≡1


class OptimizeNetworkResponse(BaseModel):
    contract_version: Literal["2"]
    request_id: str
    node_plans: list[NetworkNodePlan]
    allocations: list[NetworkAllocationLine] = Field(default_factory=list)
    pooling: PoolingReport
    errors: list[EngineItemError] = Field(default_factory=list)
