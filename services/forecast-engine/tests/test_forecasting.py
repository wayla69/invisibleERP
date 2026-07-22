"""Forecaster behaviour (docs/54 §1.2–§1.3).

Prophet-dependent cases `importorskip` so the suite still runs on a box without the wheel (the
engine degrades the same way at runtime); CI installs prophet, so they execute there.
"""

from __future__ import annotations

import datetime as dt

import numpy as np
import pytest
from conftest import daily_history

from app.contracts import HolidayEvent, SeriesInput
from app.forecasting import (
    build_frame,
    croston_sba_paths,
    dow_bootstrap_paths,
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
