"""Sample-path forecasters (docs/54 §1.1–§1.3).

Every model emits the SAME artifact — a K×H matrix of non-negative demand sample paths — because
downstream optimization is stochastic (SAA) and BoM explosion must sum paths, never quantiles.

Prophet and pandas are imported lazily inside the functions that need them: they are heavyweight,
and the optimizer/contract halves of the engine (and dev boxes without prophet wheels) must work
without them. A prophet failure of any kind degrades the series to the day-of-week bootstrap
rather than failing the batch.

Determinism: every stochastic step draws from the per-series numpy Generator seeded from
(request_id, series_id) — the same request replays identically (idempotency + harness stability).
Prophet's own `predictive_samples` uses numpy's GLOBAL RNG internally, so that one call is wrapped
in a lock that seeds the global RNG from the per-series generator; the fit itself (MAP/L-BFGS) is
deterministic.
"""

from __future__ import annotations

import datetime as dt
import logging
import threading
from dataclasses import dataclass

import numpy as np

from .classify import classify, route
from .contracts import (
    Accuracy,
    ForecastPoint,
    ForecastSeriesResult,
    HolidayEvent,
    SeriesInput,
)

MIN_PROPHET_DAYS = 56  # fitted (non-dropped) observations needed before Prophet is attempted
YEARLY_MIN_DAYS = 364  # enable yearly seasonality only with a full year of data
BACKTEST_MIN_DAYS = 120  # holdout backtest only when history affords it (costs a second fit)
BACKTEST_HOLDOUT = 14
DEFAULT_HOLIDAY_PRIOR = 10.0

_SAMPLE_LOCK = threading.Lock()


class SeriesTooShort(Exception):
    code = "SERIES_TOO_SHORT"


@dataclass
class SeriesFrame:
    """Dense observed series with a drop-mask (closures + stockout-censored days)."""

    dates: list[dt.date]
    values: np.ndarray  # float, same length as dates
    drop: np.ndarray  # bool, same length — True = exclude from fit/estimation


def build_frame(series: SeriesInput, closures: set[str]) -> SeriesFrame:
    pts = sorted(series.history, key=lambda p: p.ds)
    dates = [dt.date.fromisoformat(p.ds) for p in pts]
    values = np.asarray([p.y for p in pts], dtype=float)
    drop = np.asarray([bool(p.stockout) or p.ds in closures for p in pts], dtype=bool)
    return SeriesFrame(dates=dates, values=values, drop=drop)


def future_days(last: dt.date, horizon: int) -> list[dt.date]:
    return [last + dt.timedelta(days=i + 1) for i in range(horizon)]


def is_payday(d: dt.date) -> float:
    """Thai payroll clusters: month-end (last 2 days), 1st–2nd, and mid-month 15th–17th."""
    last = (d.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)
    return 1.0 if d.day in (1, 2, 15, 16, 17) or d >= last - dt.timedelta(days=1) else 0.0


def wape(actual: np.ndarray, pred: np.ndarray) -> float | None:
    denom = float(np.abs(actual).sum())
    if denom <= 0:
        return None
    return float(np.abs(actual - pred).sum() / denom)


# ── Prophet ───────────────────────────────────────────────────────────────────


def _holidays_df(holidays: list[HolidayEvent]):
    if not holidays:
        return None
    import pandas as pd

    df = pd.DataFrame(
        [
            {
                "holiday": h.name,
                "ds": pd.Timestamp(h.ds),
                "lower_window": h.lower_window,
                "upper_window": h.upper_window,
            }
            for h in holidays
        ]
    )
    if any(h.prior_scale is not None for h in holidays):
        df["prior_scale"] = [h.prior_scale if h.prior_scale is not None else DEFAULT_HOLIDAY_PRIOR for h in holidays]
    return df


def _fit_prophet(df, holidays_df, payday_regressor: bool):
    from prophet import Prophet

    logging.getLogger("prophet").setLevel(logging.WARNING)
    logging.getLogger("cmdstanpy").setLevel(logging.WARNING)
    m = Prophet(
        seasonality_mode="multiplicative",
        weekly_seasonality=True,
        yearly_seasonality=len(df) >= YEARLY_MIN_DAYS,
        daily_seasonality=False,
        changepoint_prior_scale=0.05,
        holidays=holidays_df,
        interval_width=0.9,
        uncertainty_samples=300,
    )
    if payday_regressor:
        m.add_regressor("is_payday")
    m.fit(df)
    return m


def _prophet_frame(frame: SeriesFrame, payday_regressor: bool):
    import pandas as pd

    keep = ~frame.drop
    df = pd.DataFrame(
        {
            "ds": pd.to_datetime([d.isoformat() for d, k in zip(frame.dates, keep) if k]),
            "y": frame.values[keep],
        }
    )
    if payday_regressor:
        df["is_payday"] = [is_payday(d.date()) for d in df["ds"]]
    return df


def prophet_paths(
    frame: SeriesFrame,
    holidays: list[HolidayEvent],
    horizon: int,
    k: int,
    payday_regressor: bool,
    rng: np.random.Generator,
) -> tuple[np.ndarray, Accuracy]:
    import pandas as pd

    df = _prophet_frame(frame, payday_regressor)
    if len(df) < MIN_PROPHET_DAYS:
        raise SeriesTooShort()
    holidays_df = _holidays_df(holidays)
    m = _fit_prophet(df, holidays_df, payday_regressor)

    last = frame.dates[-1]
    fut_dates = future_days(last, horizon)
    future = pd.DataFrame({"ds": pd.to_datetime([d.isoformat() for d in fut_dates])})
    if payday_regressor:
        future["is_payday"] = [is_payday(d) for d in fut_dates]

    # predictive_samples draws through numpy's GLOBAL RNG — serialize + seed for determinism.
    with _SAMPLE_LOCK:
        np.random.seed(int(rng.integers(0, 2**31 - 1)))
        samples = m.predictive_samples(future)["yhat"]  # (horizon, uncertainty_samples)
    n_avail = samples.shape[1]
    cols = rng.choice(n_avail, size=min(k, n_avail), replace=False)
    paths = np.clip(samples[:, cols].T, 0.0, None)  # K × H
    if paths.shape[0] < k:  # uncertainty_samples < k (never with 300 ≥ 100, but stay safe)
        extra = rng.choice(paths.shape[0], size=k - paths.shape[0])
        paths = np.vstack([paths, paths[extra]])

    acc = Accuracy(wape=None, cutoffs=0)
    if len(df) >= BACKTEST_MIN_DAYS:
        try:
            train, test = df.iloc[:-BACKTEST_HOLDOUT], df.iloc[-BACKTEST_HOLDOUT:]
            mb = _fit_prophet(train, holidays_df, payday_regressor)
            pred = mb.predict(test[["ds", "is_payday"]] if payday_regressor else test[["ds"]])
            w = wape(test["y"].to_numpy(), np.clip(pred["yhat"].to_numpy(), 0.0, None))
            acc = Accuracy(wape=w, cutoffs=1)
        except Exception:  # noqa: BLE001 — backtest is best-effort reporting, never fails the series
            acc = Accuracy(wape=None, cutoffs=0)
    return paths, acc


# ── Croston–SBA (intermittent) ────────────────────────────────────────────────


def _croston_state(vals: np.ndarray, alpha: float = 0.1) -> tuple[float, float]:
    """EWMA of non-zero size z and inter-demand interval p (classic Croston recursion)."""
    nz = np.nonzero(vals > 0)[0]
    z = float(vals[nz[0]])
    p = float(nz[0] + 1)
    q = 1
    for v in vals[nz[0] + 1 :]:
        if v > 0:
            z += alpha * (v - z)
            p += alpha * (q - p)
            q = 1
        else:
            q += 1
    return z, max(p, 1.0)


def croston_sba_paths(
    frame: SeriesFrame, horizon: int, k: int, rng: np.random.Generator
) -> tuple[np.ndarray, Accuracy]:
    alpha = 0.1
    vals = frame.values[~frame.drop]
    sizes = vals[vals > 0]
    if len(sizes) < 2:
        raise SeriesTooShort()
    z, p = _croston_state(vals, alpha)
    rate = (1.0 - alpha / 2.0) * z / p  # SBA bias-corrected demand rate per day

    prob = min(1.0, 1.0 / p)
    occ = rng.random((k, horizon)) < prob
    draw = rng.choice(sizes, size=(k, horizon))
    theoretical = prob * float(sizes.mean())
    scale = rate / theoretical if theoretical > 0 else 1.0
    paths = np.where(occ, draw * scale, 0.0)

    acc = Accuracy(wape=None, cutoffs=0)
    if len(vals) >= 60:
        zt, pt = _croston_state(vals[:-BACKTEST_HOLDOUT], alpha)
        pred = np.full(BACKTEST_HOLDOUT, (1.0 - alpha / 2.0) * zt / pt)
        acc = Accuracy(wape=wape(vals[-BACKTEST_HOLDOUT:], pred), cutoffs=1)
    return paths, acc


# ── Day-of-week bootstrap (lumpy + short-history baseline) ────────────────────


def dow_bootstrap_paths(
    frame: SeriesFrame,
    horizon: int,
    k: int,
    rng: np.random.Generator,
) -> tuple[np.ndarray, Accuracy]:
    obs = [(d, v) for d, v, dr in zip(frame.dates, frame.values, frame.drop) if not dr]
    recent = obs[-56:]  # last 8 open weeks are the resample pool
    by_dow: dict[int, list[float]] = {}
    for d, v in recent:
        by_dow.setdefault(d.weekday(), []).append(v)
    all_vals = [v for _, v in recent] or [0.0]

    last = frame.dates[-1] if frame.dates else dt.date.today()
    cols = []
    for fd in future_days(last, horizon):
        pool = np.asarray(by_dow.get(fd.weekday()) or all_vals, dtype=float)
        cols.append(rng.choice(pool, size=k))
    paths = np.column_stack(cols) if cols else np.zeros((k, horizon))

    acc = Accuracy(wape=None, cutoffs=0)
    if len(obs) >= 56 + BACKTEST_HOLDOUT:
        train, test = obs[:-BACKTEST_HOLDOUT], obs[-BACKTEST_HOLDOUT:]
        tr_dow: dict[int, list[float]] = {}
        for d, v in train[-56:]:
            tr_dow.setdefault(d.weekday(), []).append(v)
        tr_all = [v for _, v in train[-56:]] or [0.0]
        pred = np.asarray([float(np.mean(tr_dow.get(d.weekday()) or tr_all)) for d, _ in test])
        acc = Accuracy(wape=wape(np.asarray([v for _, v in test]), pred), cutoffs=1)
    return paths, acc


# ── Orchestration ─────────────────────────────────────────────────────────────


def forecast_series(
    series: SeriesInput,
    holidays: list[HolidayEvent],
    closures: set[str],
    horizon: int,
    k: int,
    quantiles: list[float],
    payday_regressor: bool,
    rng: np.random.Generator,
) -> ForecastSeriesResult:
    frame = build_frame(series, closures)
    cls = series.class_hint if series.class_hint != "auto" else classify(list(frame.values[~frame.drop]))
    model = route(cls)

    acc = Accuracy(wape=None, cutoffs=0)
    if model == "prophet":
        try:
            paths, acc = prophet_paths(frame, holidays, horizon, k, payday_regressor, rng)
        except Exception:  # noqa: BLE001 — missing wheel, fit failure, too short: degrade, don't fail
            model = "baseline_dow"
            paths, acc = dow_bootstrap_paths(frame, horizon, k, rng)
    elif model == "croston_sba":
        try:
            paths, acc = croston_sba_paths(frame, horizon, k, rng)
        except SeriesTooShort:
            model = "baseline_dow"
            paths, acc = dow_bootstrap_paths(frame, horizon, k, rng)
    else:  # bootstrap | baseline_dow share the dow resampler
        paths, acc = dow_bootstrap_paths(frame, horizon, k, rng)

    last = frame.dates[-1]
    fut = future_days(last, horizon)
    closure_mask = np.asarray([fd.isoformat() in closures for fd in fut], dtype=bool)
    paths = np.clip(np.asarray(paths, dtype=float), 0.0, None)
    paths[:, closure_mask] = 0.0

    points = []
    for h, fd in enumerate(fut):
        col = paths[:, h]
        points.append(
            ForecastPoint(
                ds=fd.isoformat(),
                yhat=float(max(col.mean(), 0.0)),
                q={str(q): float(np.quantile(col, q)) for q in quantiles},
            )
        )
    return ForecastSeriesResult(
        series_id=series.series_id,
        model=model,  # type: ignore[arg-type] — narrowed to the contract literals above
        points=points,
        sample_paths=[[float(v) for v in row] for row in paths],
        accuracy=acc,
    )
