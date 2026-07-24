"""Forecaster behaviour (docs/54 §1.2–§1.3).

Prophet-dependent cases `importorskip` so the suite still runs on a box without the wheel (the
engine degrades the same way at runtime); CI installs prophet, so they execute there.
"""

from __future__ import annotations

import datetime as dt

import numpy as np
import pytest
from conftest import daily_history

from app.contracts import HolidayEvent, SeriesInput, WarmStart
from app.forecasting import (
    build_frame,
    croston_sba_paths,
    dow_bootstrap_paths,
    estimate_elasticity,
    forecast_series,
    is_payday,
)


def series(days=120, base=10.0, weekend_lift=1.0, **over) -> SeriesInput:
    return SeriesInput(
        series_id=over.pop("series_id", "S1"),
        history=daily_history(days, base, weekend_lift=weekend_lift),
        **over,
    )


def run(s: SeriesInput, horizon=7, k=20, closures=frozenset(), holidays=None):
    return forecast_series(
        series=s,
        holidays=list(holidays or []),
        closures=set(closures),
        horizon=horizon,
        k=k,
        quantiles=[0.1, 0.5, 0.9],
        payday_regressor=True,
        rng=np.random.default_rng(4),
    )


def test_paths_shape_and_non_negativity():
    out = run(series(), horizon=7, k=20)
    assert len(out.sample_paths) == 20
    assert all(len(p) == 7 for p in out.sample_paths)
    assert min(min(p) for p in out.sample_paths) >= 0.0
    assert len(out.points) == 7


def test_quantiles_are_ordered_and_bracket_the_mean():
    out = run(series(days=90, base=20.0))
    for p in out.points:
        assert p.q["0.1"] <= p.q["0.5"] <= p.q["0.9"]
        assert p.q["0.1"] <= p.yhat <= p.q["0.9"] + 1e-9


def test_future_closures_force_zero_demand():
    last = dt.date.fromisoformat(series().history[-1].ds)
    closed = (last + dt.timedelta(days=2)).isoformat()
    out = run(series(), horizon=5, closures={closed})
    point = next(p for p in out.points if p.ds == closed)
    assert point.yhat == 0.0
    assert all(p[1] == 0.0 for p in out.sample_paths)  # index 1 = the closed day


def test_determinism_same_seed_same_paths():
    s = series()
    assert run(s).sample_paths == run(s).sample_paths


def test_short_history_uses_the_dow_baseline():
    out = run(series(days=21, base=5.0))
    assert out.model == "baseline_dow"
    assert out.accuracy.wape is None or out.accuracy.wape >= 0


def test_intermittent_series_routes_to_croston():
    hist = [
        {"ds": (dt.date(2026, 3, 1) + dt.timedelta(days=i)).isoformat(), "y": 6.0 if i % 5 == 0 else 0.0}
        for i in range(120)
    ]
    out = run(SeriesInput(series_id="INT", history=hist))
    assert out.model == "croston_sba"
    mean_daily = float(np.mean([v for p in out.sample_paths for v in p]))
    assert 0.6 <= mean_daily <= 1.8  # ≈ 6 units every 5 days = 1.2/day


def test_croston_paths_are_intermittent_not_smeared():
    frame = build_frame(
        SeriesInput(
            series_id="INT",
            history=[
                {"ds": (dt.date(2026, 3, 1) + dt.timedelta(days=i)).isoformat(), "y": 6.0 if i % 5 == 0 else 0.0}
                for i in range(120)
            ],
        ),
        closures=set(),
    )
    paths, _acc = croston_sba_paths(frame, horizon=20, k=40, rng=np.random.default_rng(1))
    zero_share = float((paths == 0).mean())
    assert zero_share > 0.5  # genuinely sparse draws, not a flat rate on every day


def test_dow_bootstrap_reproduces_the_weekly_shape():
    s = series(days=112, base=10.0, weekend_lift=3.0)
    frame = build_frame(s, closures=set())
    paths, _acc = dow_bootstrap_paths(frame, horizon=14, k=60, rng=np.random.default_rng(2))
    last = dt.date.fromisoformat(s.history[-1].ds)
    days = [last + dt.timedelta(days=i + 1) for i in range(14)]
    weekend = [i for i, d in enumerate(days) if d.weekday() >= 5]
    weekday = [i for i, d in enumerate(days) if d.weekday() < 5]
    assert paths[:, weekend].mean() > 2.0 * paths[:, weekday].mean()


def test_stockout_days_are_excluded_from_the_fit():
    hist = daily_history(120, 10.0)
    for point in hist[-10:]:
        point["y"] = 0.0
        point["stockout"] = True
    censored = run(SeriesInput(series_id="SO", history=hist))
    mean_forecast = float(np.mean([v for p in censored.sample_paths for v in p]))
    assert mean_forecast > 5.0  # a naive fit would have learned the phantom zeros


def test_payday_flags_thai_pay_cycle():
    assert is_payday(dt.date(2026, 7, 1)) == 1.0
    assert is_payday(dt.date(2026, 7, 16)) == 1.0
    assert is_payday(dt.date(2026, 7, 31)) == 1.0  # month end
    assert is_payday(dt.date(2026, 7, 9)) == 0.0


def test_backtest_wape_is_reported_for_long_histories():
    out = run(series(days=150, base=12.0))
    assert out.accuracy.cutoffs >= 1
    assert out.accuracy.wape is not None and out.accuracy.wape >= 0


# ── Prophet-specific ──────────────────────────────────────────────────────────


def test_prophet_is_selected_for_smooth_series():
    pytest.importorskip("prophet")
    out = run(series(days=180, base=25.0, weekend_lift=1.4))
    assert out.model == "prophet"


def test_prophet_learns_a_holiday_uplift():
    """A synthetic 3× spike on one recurring date must lift that date's forecast above baseline."""
    pytest.importorskip("prophet")
    start = dt.date(2025, 1, 1)
    spikes = {dt.date(2025, 4, 13), dt.date(2025, 12, 31), dt.date(2026, 4, 13)}
    hist = []
    for i in range(560):
        d = start + dt.timedelta(days=i)
        hist.append({"ds": d.isoformat(), "y": 60.0 if d in spikes else 20.0})
    last = dt.date.fromisoformat(hist[-1]["ds"])
    target = last + dt.timedelta(days=5)
    holidays = [HolidayEvent(name="promo", ds=d.isoformat()) for d in (*spikes, target)]
    out = run(SeriesInput(series_id="H", history=hist), horizon=10, holidays=holidays)
    if out.model != "prophet":
        pytest.skip("series degraded off prophet in this environment")
    lifted = next(p for p in out.points if p.ds == target.isoformat())
    others = [p.yhat for p in out.points if p.ds != target.isoformat()]
    assert lifted.yhat > 1.3 * (sum(others) / len(others))


# ── docs/56 A1 — promo/price regressors ───────────────────────────────────────

from app.contracts import SeriesRegressor  # noqa: E402
from app.forecasting import build_regctx, _uplift_vector  # noqa: E402


def _short_series_with_promo(promo_days, price_days=None):
    """A short-history series (→ baseline_dow, the regressor-less uplift path) with governed
    regressors over history∪horizon. promo_days/price_days index into the 7-day horizon."""
    hist = daily_history(40, 12.0, weekend_lift=1.2)
    last = dt.date.fromisoformat(hist[-1]['ds'])
    fut = [last + dt.timedelta(days=i + 1) for i in range(7)]
    regs = [SeriesRegressor(ds=p['ds'], promo_flag=False, price=60.0) for p in hist]
    for i, fd in enumerate(fut):
        regs.append(SeriesRegressor(
            ds=fd.isoformat(),
            promo_flag=i in promo_days,
            discount_pct=0.25 if i in promo_days else 0.0,
            price=(48.0 if (price_days and i in price_days) else 60.0),
        ))
    return SeriesInput(series_id="P1", class_hint="auto", history=hist, regressors=regs)


def _run(s, promo=True, price=True, seed=7):
    return forecast_series(
        series=s, holidays=[], closures=set(), horizon=7, k=40, quantiles=[0.1, 0.5, 0.9],
        payday_regressor=True, promo_regressor=promo, price_regressor=price,
        rng=np.random.default_rng(seed),
    )


def test_promo_regressor_lifts_the_promo_day():
    s = _short_series_with_promo(promo_days={3})
    on = _run(s, promo=True)
    off = _run(s, promo=False)
    # the promo horizon day (index 3) is strictly higher with the promo regressor on
    assert on.points[3].yhat > off.points[3].yhat
    # a non-promo day (index 0) is unchanged
    assert on.points[0].yhat == pytest.approx(off.points[0].yhat, rel=1e-9)
    assert "promo" in (on.attribution.regressors_used if on.attribution else [])
    assert on.attribution.promo_uplift_pct is not None and on.attribution.promo_uplift_pct > 0


def test_promo_uplift_is_capped_at_u_max():
    from app.forecasting import U_MAX
    s = _short_series_with_promo(promo_days={0, 1, 2, 3, 4, 5, 6})
    reg = build_regctx(s, promo_regressor=True, price_regressor=True)
    fut = [dt.date.fromisoformat(r.ds) for r in (s.regressors or [])][-7:]
    uplift = _uplift_vector(fut, reg)
    assert float(uplift.max()) <= U_MAX + 1e-9


def test_regressors_determinism_same_seed():
    s = _short_series_with_promo(promo_days={2, 5})
    a = _run(s, seed=11)
    b = _run(s, seed=11)
    assert a.sample_paths == b.sample_paths


def test_no_regressors_is_byte_identical_to_baseline():
    # A series without regressors forecasts exactly as if promo/price were off (v1 behaviour).
    hist = daily_history(40, 12.0, weekend_lift=1.2)
    s = SeriesInput(series_id="N1", class_hint="auto", history=hist)
    with_flags = _run(s, promo=True, price=True, seed=3)
    without = _run(s, promo=False, price=False, seed=3)
    assert with_flags.sample_paths == without.sample_paths
    assert (with_flags.attribution.regressors_used if with_flags.attribution else []) == ["payday"]


# ── docs/56 A2: own-price elasticity estimation ──────────────────────────────

def _elastic_series(eps_true, n=48, prices=(50.0, 60.0, 72.0), base=200.0, jitter=0.0, series_id="E1"):
    """History where log demand follows a known log-price slope: y = base·(price/60)^eps_true.
    Cycling through `prices` guarantees real price variation; `jitter` perturbs demand to weaken r²."""
    hist = daily_history(n, base)
    regs = []
    for i, p in enumerate(hist):
        price = prices[i % len(prices)]
        y = base * (price / 60.0) ** eps_true
        if jitter:
            y *= 1.0 + jitter * (((i * 7919) % 11) - 5) / 5.0  # deterministic ±jitter
        p["y"] = round(max(y, 0.1), 4)
        regs.append(SeriesRegressor(ds=p["ds"], promo_flag=False, price=price))
    return SeriesInput(series_id=series_id, class_hint="auto", history=hist, regressors=regs)


def test_elasticity_recovers_known_slope():
    s = _elastic_series(eps_true=-1.5)
    reg = build_regctx(s, promo_regressor=True, price_regressor=True)
    eps, r2, n = estimate_elasticity(s, reg)
    assert eps is not None and eps == pytest.approx(-1.5, abs=0.1)
    assert r2 is not None and r2 > 0.9
    assert n >= 8


def test_elasticity_is_reported_in_attribution():
    s = _elastic_series(eps_true=-1.2)
    res = _run(s, price=True, seed=5)
    a = res.attribution
    assert a is not None and "price" in a.regressors_used
    assert a.price_elasticity is not None and a.price_elasticity < 0
    assert a.elasticity_n_obs is not None and a.elasticity_n_obs >= 8


def test_flat_price_is_not_identifiable():
    # A single constant price gives no price variation → ε must be None, never a spurious number.
    s = _elastic_series(eps_true=-2.0, prices=(60.0,))
    reg = build_regctx(s, promo_regressor=True, price_regressor=True)
    eps, r2, n = estimate_elasticity(s, reg)
    assert eps is None


def test_too_few_observations_not_identifiable():
    s = _elastic_series(eps_true=-1.5, n=6)
    reg = build_regctx(s, promo_regressor=True, price_regressor=True)
    eps, r2, n = estimate_elasticity(s, reg)
    assert eps is None and n < 8


def test_weak_fit_is_suppressed():
    # Heavy demand noise around a tiny true slope → r² below floor → ε suppressed to None.
    s = _elastic_series(eps_true=-0.05, jitter=0.9)
    reg = build_regctx(s, promo_regressor=True, price_regressor=True)
    eps, r2, n = estimate_elasticity(s, reg)
    assert eps is None


def test_elasticity_is_clamped():
    from app.forecasting import ELASTICITY_CLAMP
    s = _elastic_series(eps_true=-9.0)  # absurdly steep → clamp
    reg = build_regctx(s, promo_regressor=True, price_regressor=True)
    eps, r2, n = estimate_elasticity(s, reg)
    assert eps is not None and abs(eps) <= ELASTICITY_CLAMP + 1e-9


def test_stockout_days_excluded_from_elasticity():
    # A stockout day is right-censored demand; it must not enter the price-response fit.
    s = _elastic_series(eps_true=-1.5)
    s.history[0].stockout = True
    reg = build_regctx(s, promo_regressor=True, price_regressor=True)
    eps, r2, n = estimate_elasticity(s, reg)
    assert n == len(s.history) - 1


# ── docs/59 D2 — warm-start / model registry ───────────────────────────────────
# The engine fits Prophet deterministically (MAP/L-BFGS) and reseeds numpy right before sampling, so a
# serialized fit reused on an UNCHANGED training window must reproduce the cold fit byte-for-byte. These
# need a real prophet wheel (importorskip); CI installs it.


def test_warm_start_cold_fit_returns_fitted_state():
    pytest.importorskip("prophet")
    out = run(series(days=120))
    assert out.model == "prophet"
    assert out.fitted_state is not None  # a fresh fit ships its serialized state for the API to cache
    assert out.fitted_state.params and out.fitted_state.fit_hash
    assert out.fitted_state.fit_wape is not None  # 120 days ≥ BACKTEST_MIN_DAYS ⇒ a holdout WAPE baseline


def test_warm_start_reproduces_cold_fit_byte_identical():
    pytest.importorskip("prophet")
    cold = run(series(days=120))
    assert cold.fitted_state is not None
    warm = run(series(days=120, warm_start=WarmStart(params=cold.fitted_state.params, fit_hash=cold.fitted_state.fit_hash)))
    assert warm.fitted_state is None  # a HIT reuses the cache — nothing new to persist
    assert warm.sample_paths == cold.sample_paths  # reuse ≡ cold fit, byte-for-byte (determinism gate)


def test_warm_start_refits_on_training_window_change():
    pytest.importorskip("prophet")
    cold = run(series(days=120))
    assert cold.fitted_state is not None
    # A changed training window (one more day, so every dated row differs) recomputes to a different
    # fit_hash than the cached one ⇒ the stale warm-start is ignored and the series refits.
    changed = run(series(days=121, warm_start=WarmStart(params=cold.fitted_state.params, fit_hash=cold.fitted_state.fit_hash)))
    assert changed.fitted_state is not None  # a refit happened
    assert changed.fitted_state.fit_hash != cold.fitted_state.fit_hash


def test_warm_start_corrupt_cache_falls_back_to_fit():
    pytest.importorskip("prophet")
    cold = run(series(days=120))
    assert cold.fitted_state is not None
    # Same window (hash matches) but unparseable params ⇒ the reconstruct fails closed to a fresh fit.
    out = run(series(days=120, warm_start=WarmStart(params="{not-prophet-json}", fit_hash=cold.fitted_state.fit_hash)))
    assert out.model == "prophet"
    assert out.fitted_state is not None  # refit, not a crash


# ── docs/56 A4 — analog / zero-history cold-start ──────────────────────────────
from app.contracts import ForecastSeriesResult, Accuracy, ForecastPoint  # noqa: E402
from app.forecasting import forecast_series as _fs  # noqa: E402
from app.service import run_forecast  # noqa: E402
from app.contracts import ForecastRequest  # noqa: E402


def _donor_result(series_id="DONOR", level=20.0, horizon=7, k=20):
    return ForecastSeriesResult(
        series_id=series_id, model="prophet",
        points=[ForecastPoint(ds="2026-07-01", yhat=level, q={"0.1": level*0.8, "0.5": level, "0.9": level*1.2})],
        sample_paths=[[level] * horizon for _ in range(k)],  # flat k×horizon, mean == level
        accuracy=Accuracy(wape=None, cutoffs=0),
    )


def test_analog_borrows_donor_shape_and_is_flagged():
    new_sku = SeriesInput(series_id="NEW", history=daily_history(10, 5.0), analog_of=["DONOR"])
    out = _fs(series=new_sku, holidays=[], closures=set(), horizon=7, k=20, quantiles=[0.1, 0.5, 0.9],
              payday_regressor=True, rng=np.random.default_rng(3), donors={"DONOR": _donor_result(level=20.0)})
    assert out.model == "baseline_dow"
    assert "analog" in out.attribution.regressors_used  # a reviewer sees it is borrowed, not observed
    mean = float(np.mean([v for p in out.sample_paths for v in p]))
    assert 3.0 < mean < 8.0  # rescaled to the NEW sku's own ~5 baseline, not the donor's 20


def test_analog_without_donors_falls_back_to_own_baseline():
    # analog_of declared but the donor is absent from the batch ⇒ no borrow; forecast the short own history.
    new_sku = SeriesInput(series_id="NEW", history=daily_history(10, 5.0), analog_of=["MISSING"])
    out = _fs(series=new_sku, holidays=[], closures=set(), horizon=7, k=20, quantiles=[0.1, 0.5, 0.9],
              payday_regressor=True, rng=np.random.default_rng(3), donors={})
    assert "analog" not in out.attribution.regressors_used


def test_analog_ignored_when_history_is_sufficient():
    # a SKU with enough history does NOT borrow even if analog_of is set (it can fit its own model).
    established = SeriesInput(series_id="OLD", history=daily_history(120, 8.0), analog_of=["DONOR"])
    out = _fs(series=established, holidays=[], closures=set(), horizon=7, k=20, quantiles=[0.1, 0.5, 0.9],
              payday_regressor=True, rng=np.random.default_rng(3), donors={"DONOR": _donor_result()})
    assert "analog" not in out.attribution.regressors_used


def test_run_forecast_two_phase_analog_end_to_end():
    donor = SeriesInput(series_id="DONOR", history=daily_history(120, 20.0, weekend_lift=1.5))
    newbie = SeriesInput(series_id="NEW", history=daily_history(8, 6.0), analog_of=["DONOR"])
    req = ForecastRequest(contract_version="2", request_id="r-a4", horizon_days=7, scenario_count=20,
                          quantiles=[0.1, 0.5, 0.9], holidays=[], series=[newbie, donor])  # analog listed first
    resp = run_forecast(req)
    by = {r.series_id: r for r in resp.results}
    assert set(by) == {"DONOR", "NEW"}
    assert "analog" in by["NEW"].attribution.regressors_used  # borrowed the donor forecast (phase 2)
    assert "analog" not in by["DONOR"].attribution.regressors_used
