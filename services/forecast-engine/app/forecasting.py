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
import math
import threading
from dataclasses import dataclass

import numpy as np

from .classify import classify, route
from .contracts import (
    Accuracy,
    Attribution,
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

# docs/56 A1 — the NON-Prophet uplift term (Croston/bootstrap/baseline have no regressor mechanism).
BETA_PROMO = 0.35  # shrunken promo-lift prior; the learned Prophet coefficient supersedes it there
U_MAX = 3.0  # hard per-day lift cap so a fat-fingered discount cannot plant an absurd path

# docs/56 A2 — own-price elasticity identifiability floor. Estimate a log-log slope only when the
# history actually identifies one; otherwise report ε=None so a spurious elasticity is never emitted
# (and the scenario tool falls back to a unit price response). A too-flat price, too few paired
# observations, or a poor fit are all "not identified".
ELASTICITY_MIN_OBS = 8  # paired (log price, log demand) observations required
ELASTICITY_MIN_LOGPRICE_VAR = 1e-4  # var(log price) floor (~1% price movement) — below = no signal
ELASTICITY_MIN_R2 = 0.05  # linear-fit r² floor — below = the price↔demand link is not credible
ELASTICITY_CLAMP = 5.0  # |ε| cap so a noisy fit cannot plant an absurd scenario response

_SAMPLE_LOCK = threading.Lock()


@dataclass
class RegCtx:
    """docs/56 A1 — resolved promo/price regressor signal for a series, keyed by business day.

    `promo_on`/`price_on` are True only when the request enabled the regressor AND the series
    actually carries the signal — so a series without governed promo/price is byte-identical to v1.
    """

    by_ds: dict  # ds(str) -> SeriesRegressor
    promo_on: bool
    price_on: bool
    ref_price: float  # reference (median observed) price for the Δlog-price regressor

    def promo_col(self, dates: list[dt.date]) -> list[float]:
        return [1.0 if (self.by_ds.get(d.isoformat()) and self.by_ds[d.isoformat()].promo_flag) else 0.0 for d in dates]

    def pricelog_col(self, dates: list[dt.date]) -> list[float]:
        out = []
        for d in dates:
            r = self.by_ds.get(d.isoformat())
            p = r.price if (r and r.price) else self.ref_price
            out.append(math.log(p / self.ref_price) if (self.ref_price > 0 and p and p > 0) else 0.0)
        return out


def build_regctx(series: SeriesInput, promo_regressor: bool, price_regressor: bool) -> RegCtx:
    regs = series.regressors or []
    by_ds = {r.ds: r for r in regs}
    prices = [r.price for r in regs if r.price is not None and r.price > 0]
    ref_price = float(np.median(prices)) if prices else 0.0
    promo_on = promo_regressor and any(r.promo_flag for r in regs)
    price_on = price_regressor and len(prices) >= 2 and ref_price > 0
    return RegCtx(by_ds=by_ds, promo_on=promo_on, price_on=price_on, ref_price=ref_price)


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


def _fit_prophet(df, holidays_df, reg_names: list[str]):
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
    for name in reg_names:  # is_payday (generalized in A1) + promo + price_log
        m.add_regressor(name)
    m.fit(df)
    return m


def _regressor_names(payday_regressor: bool, reg: RegCtx) -> list[str]:
    names = ["is_payday"] if payday_regressor else []
    if reg.promo_on:
        names.append("promo")
    if reg.price_on:
        names.append("price_log")
    return names


def _add_reg_cols(df, dates: list[dt.date], payday_regressor: bool, reg: RegCtx) -> None:
    if payday_regressor:
        df["is_payday"] = [is_payday(d) for d in dates]
    if reg.promo_on:
        df["promo"] = reg.promo_col(dates)
    if reg.price_on:
        df["price_log"] = reg.pricelog_col(dates)


def _prophet_frame(frame: SeriesFrame, payday_regressor: bool, reg: RegCtx):
    import pandas as pd

    keep = ~frame.drop
    kept_dates = [d for d, k in zip(frame.dates, keep) if k]
    df = pd.DataFrame({"ds": pd.to_datetime([d.isoformat() for d in kept_dates]), "y": frame.values[keep]})
    _add_reg_cols(df, kept_dates, payday_regressor, reg)
    return df, kept_dates


def prophet_paths(
    frame: SeriesFrame,
    holidays: list[HolidayEvent],
    horizon: int,
    k: int,
    payday_regressor: bool,
    reg: RegCtx,
    rng: np.random.Generator,
) -> tuple[np.ndarray, Accuracy]:
    import pandas as pd

    df, kept_dates = _prophet_frame(frame, payday_regressor, reg)
    if len(df) < MIN_PROPHET_DAYS:
        raise SeriesTooShort()
    reg_names = _regressor_names(payday_regressor, reg)
    holidays_df = _holidays_df(holidays)
    m = _fit_prophet(df, holidays_df, reg_names)

    last = frame.dates[-1]
    fut_dates = future_days(last, horizon)
    future = pd.DataFrame({"ds": pd.to_datetime([d.isoformat() for d in fut_dates])})
    _add_reg_cols(future, fut_dates, payday_regressor, reg)

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
            mb = _fit_prophet(train, holidays_df, reg_names)
            pred = mb.predict(test[["ds", *reg_names]] if reg_names else test[["ds"]])
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


def _uplift_vector(fut: list[dt.date], reg: RegCtx) -> np.ndarray:
    """Multiplicative promo lift per future day for models WITHOUT a regressor mechanism
    (Croston/bootstrap/baseline). uplift = clamp(1 + β·promo_flag, 0, U_MAX); applied post-sampling
    so intermittency structure is preserved. The price term (ε) is A2 — 0 here."""
    if not reg.promo_on:
        return np.ones(len(fut), dtype=float)
    promo = np.asarray(reg.promo_col(fut), dtype=float)
    return np.clip(1.0 + BETA_PROMO * promo, 0.0, U_MAX)


def estimate_elasticity(series: SeriesInput, reg: RegCtx) -> tuple[float | None, float | None, int]:
    """docs/56 A2 — own-price elasticity ε as the slope of an OLS log-log fit of demand on price over
    the observed history. Returns (ε, r², n_obs). ε is None (not identified) unless the identifiability
    floor holds: enough paired observations, real price variation, and a credible fit. Only historical
    days with an observed price, positive sold quantity and not stockout-censored contribute — a
    stockout day is right-censored demand, not a genuine price response."""
    if not reg.price_on:
        return None, None, 0
    xs: list[float] = []  # log price
    ys: list[float] = []  # log demand
    for pt in series.history:
        if pt.stockout or pt.y <= 0:
            continue
        r = reg.by_ds.get(pt.ds)
        price = r.price if (r and r.price and r.price > 0) else None
        if price is None:
            continue
        xs.append(math.log(price))
        ys.append(math.log(pt.y))
    n = len(xs)
    if n < ELASTICITY_MIN_OBS:
        return None, None, n
    x = np.asarray(xs, dtype=float)
    y = np.asarray(ys, dtype=float)
    var_x = float(np.var(x))
    if var_x < ELASTICITY_MIN_LOGPRICE_VAR:
        return None, None, n  # price barely moved — slope is not identified
    cov_xy = float(np.mean((x - x.mean()) * (y - y.mean())))
    beta = cov_xy / var_x
    var_y = float(np.var(y))
    r2 = (cov_xy * cov_xy) / (var_x * var_y) if var_y > 0 else 0.0
    if r2 < ELASTICITY_MIN_R2:
        return None, round(r2, 4), n  # fit too weak to trust
    eps = float(np.clip(beta, -ELASTICITY_CLAMP, ELASTICITY_CLAMP))
    return round(eps, 4), round(r2, 4), n


def _attribution(series: SeriesInput, points: list[ForecastPoint], fut: list[dt.date], reg: RegCtx, payday: bool) -> Attribution:
    used: list[str] = (["payday"] if payday else []) + (["promo"] if reg.promo_on else []) + (["price"] if reg.price_on else [])
    uplift_pct = None
    if reg.promo_on:
        promo = reg.promo_col(fut)
        on = [p.yhat for p, f in zip(points, promo) if f > 0]
        off = [p.yhat for p, f in zip(points, promo) if f <= 0]
        base = float(np.mean(off)) if off else 0.0
        if on and base > 0:
            uplift_pct = round(float(np.mean(on)) / base - 1.0, 4)
    eps, r2, n_obs = estimate_elasticity(series, reg)
    return Attribution(
        promo_uplift_pct=uplift_pct,
        price_elasticity=eps,
        elasticity_r2=r2,
        elasticity_n_obs=n_obs,
        regressors_used=used,
    )


def forecast_series(
    series: SeriesInput,
    holidays: list[HolidayEvent],
    closures: set[str],
    horizon: int,
    k: int,
    quantiles: list[float],
    payday_regressor: bool,
    rng: np.random.Generator,
    promo_regressor: bool = True,
    price_regressor: bool = True,
) -> ForecastSeriesResult:
    frame = build_frame(series, closures)
    reg = build_regctx(series, promo_regressor, price_regressor)
    cls = series.class_hint if series.class_hint != "auto" else classify(list(frame.values[~frame.drop]))
    model = route(cls)

    acc = Accuracy(wape=None, cutoffs=0)
    applied_uplift = False  # Prophet learns the promo effect via add_regressor; others get the term
    if model == "prophet":
        try:
            paths, acc = prophet_paths(frame, holidays, horizon, k, payday_regressor, reg, rng)
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
    paths = np.clip(np.asarray(paths, dtype=float), 0.0, None)
    if model != "prophet":  # apply the capped promo uplift term to the regressor-less models
        uplift = _uplift_vector(fut, reg)
        if not np.allclose(uplift, 1.0):
            paths = paths * uplift[np.newaxis, :]
            applied_uplift = True
    closure_mask = np.asarray([fd.isoformat() in closures for fd in fut], dtype=bool)
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
    _ = applied_uplift  # (kept for readability; attribution derives uplift% from the points below)
    return ForecastSeriesResult(
        series_id=series.series_id,
        model=model,  # type: ignore[arg-type] — narrowed to the contract literals above
        points=points,
        sample_paths=[[float(v) for v in row] for row in paths],
        accuracy=acc,
        attribution=_attribution(series, points, fut, reg, payday_regressor),
    )
