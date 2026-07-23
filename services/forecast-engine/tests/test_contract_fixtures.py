"""Contract-parity: the shared fixtures must validate here AND in apps/api/test/scm-contract.test.ts.

Beyond static validation these replay the request fixtures through the real endpoints, so the
fixtures can never drift into shapes the engine cannot actually serve.
"""

from __future__ import annotations

import json

import pytest
from conftest import load_fixture, post_signed

from app.contracts import (
    CONTRACT_VERSION,
    ForecastRequest,
    ForecastResponse,
    OptimizeNetworkRequest,
    OptimizeNetworkResponse,
    OptimizeRequest,
    OptimizeResponse,
)

FIXTURE_MODELS = [
    ("forecast_request.json", ForecastRequest),
    ("forecast_response.json", ForecastResponse),
    ("optimize_request.json", OptimizeRequest),
    ("optimize_response.json", OptimizeResponse),
    ("optimize_network_request.json", OptimizeNetworkRequest),
    ("optimize_network_response.json", OptimizeNetworkResponse),
]


@pytest.mark.parametrize("name,model", FIXTURE_MODELS)
def test_fixture_validates(name, model):
    parsed = model.model_validate(load_fixture(name))
    assert parsed.contract_version == CONTRACT_VERSION


def test_response_fixtures_round_trip_without_loss():
    for name, model in FIXTURE_MODELS:
        raw = load_fixture(name)
        again = model.model_validate(json.loads(model.model_validate(raw).model_dump_json()))
        assert again == model.model_validate(raw)


def test_unknown_fields_are_ignored_for_additive_evolution():
    raw = load_fixture("forecast_request.json")
    raw["some_future_field"] = {"nested": True}
    assert ForecastRequest.model_validate(raw).horizon_days == raw["horizon_days"]


def test_forecast_fixture_runs_end_to_end(client):
    req = load_fixture("forecast_request.json")
    r = post_signed(client, "/v1/forecast", req)
    assert r.status_code == 200
    body = ForecastResponse.model_validate(r.json())
    assert body.request_id == req["request_id"]
    assert [x.series_id for x in body.results] == [s["series_id"] for s in req["series"]]
    for result in body.results:
        assert len(result.sample_paths) == req["scenario_count"]
        assert all(len(p) == req["horizon_days"] for p in result.sample_paths)
        assert set(result.points[0].q) == {str(q) for q in req["quantiles"]}
        closed = next(p for p in result.points if p.ds == "2026-07-06")
        assert closed.yhat == 0.0  # request closure honoured


def test_optimize_fixture_runs_end_to_end(client):
    req = load_fixture("optimize_request.json")
    r = post_signed(client, "/v1/optimize", req)
    assert r.status_code == 200
    body = OptimizeResponse.model_validate(r.json())
    assert [p.item_code for p in body.plans] == [i["item_code"] for i in req["items"]]
    for plan in body.plans:
        assert len(plan.order_up_to) == req["horizon_days"]
        assert len(plan.safety_stock) == req["horizon_days"]
        assert 0.0 <= plan.expected.fill_rate <= 1.0
    spend = sum(
        o.qty * next(i["unit_cost"] for i in req["items"] if i["item_code"] == p.item_code)
        for p in body.plans
        for o in p.orders
    )
    assert spend <= req["joint"]["budget"] + 1e-6  # joint budget respected end-to-end


def test_optimize_network_fixture_runs_end_to_end(client):
    req = load_fixture("optimize_network_request.json")
    r = post_signed(client, "/v1/optimize-network", req)
    assert r.status_code == 200
    body = OptimizeNetworkResponse.model_validate(r.json())
    assert not body.errors
    # a plan for each stocking echelon (DC + branches), none for the supplier
    got = {p.node_id for p in body.node_plans}
    assert got == {"CK", "BR-SILOM", "BR-ASOKE"}
    for p in body.node_plans:
        assert len(p.base_stock) == req["horizon_days"]
        assert 0.0 <= p.expected.fill_rate <= 1.0
    # pooling harvested a benefit, and the pooled buffer never exceeds the independent one
    assert body.pooling.pooled_safety_units <= body.pooling.independent_safety_units + 1e-6
    assert body.pooling.pooling_benefit_pct > 0.0


def test_perishable_item_uses_the_milp_tier(client):
    body = OptimizeResponse.model_validate(
        post_signed(client, "/v1/optimize", load_fixture("optimize_request.json")).json()
    )
    chicken = next(p for p in body.plans if p.item_code == "ING-CHICKEN")
    assert chicken.method == "milp"  # 3-day shelf life + MOQ/pack/fixed cost all bind
    for order in chicken.orders:
        assert order.qty % 5.0 == pytest.approx(0.0, abs=1e-6)
