"""Pydantic mirrors of the TS zod contract (packages/shared/src/scm-engine.ts — the source of truth).

Field-for-field parity is enforced by round-tripping the shared JSON fixtures in BOTH test suites
(tests/test_contract_fixtures.py here; apps/api/test/scm-contract.test.ts on the TS side). Unknown
fields are IGNORED (zod's default strip semantics) so additive contract evolution never breaks an
older engine.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

CONTRACT_VERSION = "1"

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


class SeriesInput(BaseModel):
    series_id: str = Field(min_length=1)
    history: list[DemandPoint] = Field(min_length=1)
    class_hint: Literal["auto", "smooth", "intermittent", "lumpy", "short"] = "auto"


class ForecastRequest(BaseModel):
    contract_version: Literal["1"]
    request_id: str = Field(min_length=1)  # idempotency + deterministic RNG seed
    horizon_days: int = Field(ge=1, le=56)
    scenario_count: int = Field(default=50, ge=10, le=100)
    quantiles: list[float] = Field(default=[0.1, 0.5, 0.9])
    holidays: list[HolidayEvent]
    closures: list[str] = Field(default_factory=list)
    payday_regressor: bool = True
    series: list[SeriesInput] = Field(min_length=1, max_length=200)


class ForecastPoint(BaseModel):
    ds: str
    yhat: float = Field(ge=0)
    q: dict[str, float]


class Accuracy(BaseModel):
    wape: Optional[float]
    cutoffs: int


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


class EngineItemError(BaseModel):
    ref: str
    code: str
    message: str


class ForecastResponse(BaseModel):
    contract_version: Literal["1"]
    request_id: str
    results: list[ForecastSeriesResult]
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
    contract_version: Literal["1"]
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
    contract_version: Literal["1"]
    request_id: str
    plans: list[OptimizeItemPlan]
    errors: list[EngineItemError] = Field(default_factory=list)
