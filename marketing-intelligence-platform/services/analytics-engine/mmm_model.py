"""Marketing Mix Modeling (MMM) engine.

A production MMM pipeline: Geometric Adstock (carry-over) -> Saturation (diminishing returns, Hill or log)
-> Ridge Regression (handles multicollinearity among correlated social variables) -> contribution / ROI
decomposition. Pure math + a small persistence hook; no EDA plots.

The design keeps every fitted transform (theta, reference scale, saturation params, beta) so a downstream
budget simulator can re-apply the model to hypothetical spend. Swapping in a Bayesian/other model later
means replacing this class only.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Sequence

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score

logger = logging.getLogger(__name__)

SaturationType = Literal["hill", "log"]


# ── Transformations ─────────────────────────────────────────────────────────────────────────────────
def geometric_adstock(x: np.ndarray, theta: float, normalize: bool = True) -> np.ndarray:
    """Geometric adstock (carry-over): ``x_ad[t] = x[t] + theta * x_ad[t-1]``.

    theta in [0, 1) is the decay/retention rate. With ``normalize`` the series is rescaled by ``(1 - theta)``
    so its steady-state level matches the raw input (keeps units interpretable and the fit numerically
    comparable across channels with different thetas).
    """
    if not 0.0 <= theta < 1.0:
        raise ValueError(f"adstock theta must be in [0, 1); got {theta}")
    x = np.asarray(x, dtype=float)
    out = np.empty_like(x)
    carry = 0.0
    for t in range(x.size):
        carry = x[t] + theta * carry
        out[t] = carry
    return out * (1.0 - theta) if normalize else out


def hill_saturation(x: np.ndarray, alpha: float, gamma: float) -> np.ndarray:
    """Hill saturation (S-curve diminishing returns): ``x^alpha / (x^alpha + gamma^alpha)``.

    Expects ``x`` pre-scaled to roughly [0, 1]; ``gamma`` in (0, 1] is the half-saturation point, ``alpha``
    the steepness. Output is in [0, 1).
    """
    if alpha <= 0 or gamma <= 0:
        raise ValueError(f"hill params must be positive; got alpha={alpha}, gamma={gamma}")
    x = np.clip(np.asarray(x, dtype=float), 0.0, None)
    xa = np.power(x, alpha)
    return xa / (xa + gamma ** alpha)


def log_saturation(x: np.ndarray) -> np.ndarray:
    """Logarithmic saturation: ``ln(1 + x)``. A gentle, parameter-free diminishing-returns curve."""
    return np.log1p(np.clip(np.asarray(x, dtype=float), 0.0, None))


# ── Model configuration ───────────────────────────────────────────────────────────────────────────
@dataclass
class ChannelSpec:
    """A marketing channel and the DataFrame columns that describe it.

    ``spend_col`` is the controllable lever (used for ROI); ``extra_cols`` are correlated activity metrics
    (impressions, engagements) — Ridge absorbs their multicollinearity. All are adstocked + saturated.
    """
    name: str
    spend_col: str
    extra_cols: List[str] = field(default_factory=list)

    @property
    def media_cols(self) -> List[str]:
        return [self.spend_col, *self.extra_cols]


@dataclass
class _FeatureTransform:
    """The fitted transform for one media column — enough to re-apply to new data."""
    channel: str
    column: str
    theta: float
    ref_scale: float          # max of the adstocked series (used to scale into [0,1] before saturation)
    saturation: SaturationType
    alpha: float
    gamma: float
    beta: float = 0.0         # filled after the Ridge fit

    def transform(self, raw: np.ndarray) -> np.ndarray:
        ad = geometric_adstock(raw, self.theta)
        scaled = ad / self.ref_scale if self.ref_scale > 0 else ad
        if self.saturation == "hill":
            return hill_saturation(scaled, self.alpha, self.gamma)
        return log_saturation(scaled)


# ── The model ─────────────────────────────────────────────────────────────────────────────────────
class MarketingMixModel:
    """Fit an MMM and decompose per-channel contribution % and ROI."""

    def __init__(
        self,
        channels: Sequence[ChannelSpec],
        target_col: str,
        control_cols: Optional[Sequence[str]] = None,
        ridge_alpha: float = 1.0,
        adstock_theta: float = 0.5,
        saturation: SaturationType = "hill",
        hill_alpha: float = 1.5,
        hill_gamma: float = 0.5,
    ) -> None:
        if not channels:
            raise ValueError("at least one ChannelSpec is required")
        self.channels = list(channels)
        self.target_col = target_col
        self.control_cols = list(control_cols or [])
        self.ridge_alpha = float(ridge_alpha)
        self.default_theta = float(adstock_theta)
        self.saturation: SaturationType = saturation
        self.hill_alpha = float(hill_alpha)
        self.hill_gamma = float(hill_gamma)

        self._transforms: List[_FeatureTransform] = []
        self._control_mean: Dict[str, float] = {}
        self._control_std: Dict[str, float] = {}
        self._model: Optional[Ridge] = None
        self._df: Optional[pd.DataFrame] = None
        self.r2_: Optional[float] = None

    # -- feature construction --------------------------------------------------------------------------
    def _media_columns(self) -> List[tuple[ChannelSpec, str]]:
        return [(ch, col) for ch in self.channels for col in ch.media_cols]

    def _build_transforms(self, df: pd.DataFrame, thetas: Dict[str, float]) -> List[_FeatureTransform]:
        transforms: List[_FeatureTransform] = []
        for ch, col in self._media_columns():
            if col not in df.columns:
                raise KeyError(f"channel '{ch.name}' column '{col}' missing from the DataFrame")
            theta = thetas.get(col, self.default_theta)
            ad = geometric_adstock(df[col].to_numpy(dtype=float), theta)
            ref = float(np.max(ad)) if np.max(ad) > 0 else 1.0
            transforms.append(
                _FeatureTransform(
                    channel=ch.name, column=col, theta=theta, ref_scale=ref,
                    saturation=self.saturation, alpha=self.hill_alpha, gamma=self.hill_gamma,
                )
            )
        return transforms

    def _feature_matrix(self, df: pd.DataFrame, transforms: List[_FeatureTransform]) -> np.ndarray:
        media = np.column_stack([t.transform(df[t.column].to_numpy(dtype=float)) for t in transforms])
        if not self.control_cols:
            return media
        controls = []
        for c in self.control_cols:
            v = df[c].to_numpy(dtype=float)
            mean, std = float(np.mean(v)), float(np.std(v)) or 1.0
            self._control_mean[c], self._control_std[c] = mean, std
            controls.append((v - mean) / std)
        return np.column_stack([media, *controls])

    # -- fitting ---------------------------------------------------------------------------------------
    def fit(self, df: pd.DataFrame, optimize_adstock: bool = False) -> "MarketingMixModel":
        """Fit the Ridge MMM. With ``optimize_adstock`` a bounded scipy search tunes per-column theta to
        maximize in-sample R² (senior-DS touch; guarded and optional — defaults to the fixed theta)."""
        if self.target_col not in df.columns:
            raise KeyError(f"target column '{self.target_col}' missing from the DataFrame")
        df = df.reset_index(drop=True)
        self._df = df
        y = df[self.target_col].to_numpy(dtype=float)

        thetas = {col: self.default_theta for _, col in self._media_columns()}
        if optimize_adstock:
            thetas = self._optimize_thetas(df, y, thetas)

        self._transforms = self._build_transforms(df, thetas)
        X = self._feature_matrix(df, self._transforms)

        self._model = Ridge(alpha=self.ridge_alpha, fit_intercept=True)
        self._model.fit(X, y)
        self.r2_ = float(r2_score(y, self._model.predict(X)))

        # Persist the media betas onto their transforms (controls' betas are not decomposed).
        for i, t in enumerate(self._transforms):
            t.beta = float(self._model.coef_[i])
        logger.info("MMM fit: R²=%.4f, ridge_alpha=%.3f, %d media feature(s).", self.r2_, self.ridge_alpha, len(self._transforms))
        return self

    def _optimize_thetas(self, df: pd.DataFrame, y: np.ndarray, seed: Dict[str, float]) -> Dict[str, float]:
        cols = [col for _, col in self._media_columns()]
        x0 = np.array([seed[c] for c in cols])

        def neg_r2(theta_vec: np.ndarray) -> float:
            try:
                transforms = self._build_transforms(df, {c: float(t) for c, t in zip(cols, theta_vec)})
                X = self._feature_matrix(df, transforms)
                model = Ridge(alpha=self.ridge_alpha, fit_intercept=True).fit(X, y)
                return -r2_score(y, model.predict(X))
            except Exception:  # a degenerate theta set — treat as a bad objective, keep searching
                logger.debug("theta search hit a degenerate point", exc_info=True)
                return 1.0

        try:
            res = minimize(neg_r2, x0, method="L-BFGS-B", bounds=[(0.0, 0.9)] * len(cols))
            if res.success:
                logger.info("Adstock optimization improved R² to %.4f", -res.fun)
                return {c: float(t) for c, t in zip(cols, res.x)}
            logger.warning("Adstock optimization did not converge — using default theta.")
        except Exception:
            logger.exception("Adstock optimization failed — using default theta.")
        return seed

    # -- decomposition ---------------------------------------------------------------------------------
    def _require_fit(self) -> None:
        if self._model is None or self._df is None:
            raise RuntimeError("call fit() before decomposition")

    def contributions(self) -> pd.DataFrame:
        """Per-channel decomposition: attributed revenue, contribution %, ROI. One row per channel."""
        self._require_fit()
        assert self._df is not None
        df = self._df
        total_pred = float(np.sum(self._model.predict(self._feature_matrix(df, self._transforms))))  # type: ignore[arg-type]

        rows: List[Dict[str, Any]] = []
        for ch in self.channels:
            ch_transforms = [t for t in self._transforms if t.channel == ch.name]
            # Attributed revenue = Σ_t Σ_{features of this channel} beta_f * saturated_f(t).
            attributed = sum(
                float(np.sum(t.beta * t.transform(df[t.column].to_numpy(dtype=float)))) for t in ch_transforms
            )
            spend = float(np.sum(df[ch.spend_col].to_numpy(dtype=float)))
            spend_t = next((t for t in ch_transforms if t.column == ch.spend_col), None)
            spend_beta = spend_t.beta if spend_t else 0.0
            spend_theta = spend_t.theta if spend_t else self.default_theta
            spend_ref = spend_t.ref_scale if spend_t else 1.0
            # ref_scale lets a downstream simulator reconstruct the fitted response curve for this channel.
            saturation: Dict[str, Any] = {
                "type": self.saturation, "alpha": self.hill_alpha, "gamma": self.hill_gamma,
                "ref_scale": round(spend_ref, 4),
            }
            # ERP Budget-Optimizer contract (raw-spend units) — see docs/60. The platform's Hill on the
            # ref-scaled adstocked series, response(x) = spend_beta · scaled^α / (scaled^α + γ^α) with
            # scaled = x / ref_scale, is algebraically identical to the ERP's raw-spend Hill,
            # response(x) = beta · x^slope / (kappa^slope + x^slope), under: slope = α, kappa = γ · ref_scale,
            # beta = spend_beta. Only emitted for Hill (log saturation has no matching raw-spend form; the
            # ERP then falls back to its own derived curve).
            if self.saturation == "hill":
                saturation["beta"] = round(spend_beta, 6)
                saturation["kappa"] = round(self.hill_gamma * spend_ref, 2)
                saturation["slope"] = round(self.hill_alpha, 4)
            rows.append({
                "channel": ch.name,
                "beta": round(spend_beta, 6),
                "spend": round(spend, 2),
                "attributed_revenue": round(attributed, 2),
                "contribution_pct": round(100.0 * attributed / total_pred, 2) if total_pred else 0.0,
                "roi": round(attributed / spend, 4) if spend > 0 else None,
                "adstock_theta": round(spend_theta, 4),
                "saturation": saturation,
            })
        return pd.DataFrame(rows)

    def summary_dict(self) -> Dict[str, Any]:
        """A clean, JSON-serializable summary ready to persist to the ``analytics`` schema."""
        self._require_fit()
        assert self._df is not None and self._model is not None
        contrib = self.contributions()
        total_spend = float(sum(c["spend"] for c in contrib.to_dict("records")))
        return {
            "r2": round(self.r2_ or 0.0, 4),
            "ridge_alpha": self.ridge_alpha,
            "intercept": round(float(self._model.intercept_), 4),
            "total_spend": round(total_spend, 2),
            "n_observations": int(len(self._df)),
            "channels": contrib.to_dict("records"),
        }

    def simulate(self, spend_by_channel: Dict[str, np.ndarray]) -> float:
        """Predict total incremental revenue for a hypothetical per-channel spend series (budget simulator).

        Only the media contribution is returned (base/controls are held constant); each channel's spend is
        re-run through its fitted adstock/saturation/beta. Non-spend activity features are held at 0.
        """
        self._require_fit()
        total = 0.0
        for ch in self.channels:
            if ch.name not in spend_by_channel:
                continue
            t = next((t for t in self._transforms if t.column == ch.spend_col), None)
            if t is None:
                continue
            total += float(np.sum(t.beta * t.transform(np.asarray(spend_by_channel[ch.name], dtype=float))))
        return total
