"""Unit tests for the analytics engines — pure math, no DB. Run: `pytest test_engines.py`."""
from __future__ import annotations

import numpy as np
import pandas as pd

from mmm_model import (
    ChannelSpec,
    MarketingMixModel,
    geometric_adstock,
    hill_saturation,
    log_saturation,
)
from rfm_model import compute_rfm, rfm_from_facts, sentiment_weighted_rfm


# ── transformations ────────────────────────────────────────────────────────────────────────────────
def test_geometric_adstock_carryover():
    x = np.array([1.0, 0.0, 0.0, 0.0])
    ad = geometric_adstock(x, theta=0.5, normalize=False)
    # impulse decays geometrically: 1, 0.5, 0.25, 0.125
    assert np.allclose(ad, [1.0, 0.5, 0.25, 0.125])


def test_geometric_adstock_normalized_preserves_steady_state():
    x = np.ones(50)
    ad = geometric_adstock(x, theta=0.6, normalize=True)
    # a constant input should converge back to ~1 when normalized by (1 - theta)
    assert abs(ad[-1] - 1.0) < 1e-6


def test_hill_saturation_monotone_bounded():
    x = np.linspace(0, 5, 50)
    y = hill_saturation(x, alpha=2.0, gamma=0.5)
    assert np.all(np.diff(y) >= -1e-9)          # monotone non-decreasing
    assert y.min() >= 0.0 and y.max() < 1.0     # bounded in [0, 1)


def test_log_saturation_diminishing():
    y = log_saturation(np.array([0.0, 1.0, 3.0, 7.0]))
    assert np.allclose(y, np.log1p([0.0, 1.0, 3.0, 7.0]))
    # marginal gains shrink
    assert (y[1] - y[0]) > (y[3] - y[2])


# ── MMM ────────────────────────────────────────────────────────────────────────────────────────────
def _synthetic_mmm_frame(n: int = 120) -> pd.DataFrame:
    """Revenue driven mostly by channel A's spend, weakly by B; A should get the higher ROI/contribution."""
    rng = np.random.default_rng(42)
    a_spend = rng.uniform(50, 100, n)
    b_spend = rng.uniform(50, 100, n)
    a_sat = hill_saturation(geometric_adstock(a_spend, 0.5) / a_spend.max(), 1.5, 0.5)
    b_sat = hill_saturation(geometric_adstock(b_spend, 0.5) / b_spend.max(), 1.5, 0.5)
    revenue = 1000 + 4000 * a_sat + 800 * b_sat + rng.normal(0, 50, n)
    return pd.DataFrame({"a_spend": a_spend, "b_spend": b_spend, "revenue": revenue})


def test_mmm_fits_and_ranks_channels():
    df = _synthetic_mmm_frame()
    model = MarketingMixModel(
        channels=[ChannelSpec("A", "a_spend"), ChannelSpec("B", "b_spend")],
        target_col="revenue",
        ridge_alpha=0.1,
    ).fit(df)
    assert model.r2_ is not None and model.r2_ > 0.5      # recovers the signal
    contrib = model.contributions().set_index("channel")
    # A drives more revenue than B ⇒ higher contribution % and higher ROI.
    assert contrib.loc["A", "contribution_pct"] > contrib.loc["B", "contribution_pct"]
    assert contrib.loc["A", "roi"] > contrib.loc["B", "roi"]


def test_mmm_summary_is_json_ready():
    df = _synthetic_mmm_frame(60)
    summary = MarketingMixModel([ChannelSpec("A", "a_spend"), ChannelSpec("B", "b_spend")], "revenue").fit(df).summary_dict()
    assert set(summary) >= {"r2", "ridge_alpha", "total_spend", "channels"}
    for ch in summary["channels"]:
        assert set(ch) >= {"channel", "beta", "spend", "attributed_revenue", "contribution_pct", "roi", "adstock_theta", "saturation"}
    # ROI is None (not inf) if a channel had zero spend.
    zero = df.assign(a_spend=0.0)
    z = MarketingMixModel([ChannelSpec("A", "a_spend")], "revenue").fit(zero).contributions()
    assert z.loc[0, "roi"] is None


def test_hill_saturation_emits_erp_optimizer_contract():
    """Hill runs push raw-spend {beta, kappa, slope} for the ERP Budget Optimizer (docs/60)."""
    df = _synthetic_mmm_frame(60)
    model = MarketingMixModel(
        [ChannelSpec("A", "a_spend"), ChannelSpec("B", "b_spend")], "revenue",
        saturation="hill", hill_alpha=1.5, hill_gamma=0.5,
    ).fit(df)
    for ch in model.summary_dict()["channels"]:
        sat = ch["saturation"]
        assert sat["type"] == "hill"
        assert set(sat) >= {"beta", "kappa", "slope"}
        assert sat["slope"] == round(model.hill_alpha, 4)                 # slope = Hill exponent α
        assert sat["kappa"] == round(model.hill_gamma * sat["ref_scale"], 2)  # kappa = γ · ref_scale (raw spend)
        assert sat["kappa"] > 0 and sat["slope"] > 0
    # log saturation has no matching raw-spend Hill form → the ERP fields are omitted (ERP falls back).
    log_ch = MarketingMixModel([ChannelSpec("A", "a_spend")], "revenue", saturation="log").fit(df).summary_dict()["channels"][0]
    assert log_ch["saturation"]["type"] == "log"
    assert "kappa" not in log_ch["saturation"] and "slope" not in log_ch["saturation"]


def test_mmm_simulate_scales_with_spend():
    df = _synthetic_mmm_frame(80)
    model = MarketingMixModel([ChannelSpec("A", "a_spend"), ChannelSpec("B", "b_spend")], "revenue").fit(df)
    low = model.simulate({"A": np.full(30, 40.0)})
    high = model.simulate({"A": np.full(30, 90.0)})
    assert high > low  # more spend ⇒ more predicted incremental revenue (saturating, but monotone)


# ── RFM ────────────────────────────────────────────────────────────────────────────────────────────
def test_compute_rfm_from_transactions():
    tx = pd.DataFrame({
        "customer_id": ["C1", "C1", "C2"],
        "order_date": ["2026-01-01", "2026-06-01", "2026-05-01"],
        "order_value": [100, 200, 50],
    })
    rfm = compute_rfm(tx, snapshot_date=pd.Timestamp("2026-06-30")).set_index("customer_no")
    assert rfm.loc["C1", "frequency"] == 2 and rfm.loc["C1", "monetary"] == 300
    assert rfm.loc["C1", "recency_days"] == 29      # 2026-06-01 -> 2026-06-30
    assert rfm.loc["C2", "recency_days"] == 60


def test_sentiment_multiplier_and_segments():
    # 10 customers spanning the RFM range so qcut has enough spread.
    base = pd.DataFrame({
        "customer_no": [f"C{i}" for i in range(10)],
        "recency_days": [1, 3, 5, 10, 20, 40, 60, 90, 120, 200],
        "frequency": [20, 18, 15, 10, 8, 6, 4, 3, 2, 1],
        "monetary": [9000, 8000, 7000, 5000, 4000, 3000, 2000, 1200, 800, 300],
    })
    sentiment = pd.DataFrame({"customer_no": ["C0", "C9"], "sentiment_score": [0.8, -0.6]})
    out = sentiment_weighted_rfm(base, sentiment).set_index("customer_no")

    # Multiplier = 1 + 0.5*sentiment
    assert abs(out.loc["C0", "sentiment_multiplier"] - 1.4) < 1e-9
    assert abs(out.loc["C9", "sentiment_multiplier"] - 0.7) < 1e-9
    # Weighted = base * multiplier
    assert abs(out.loc["C0", "weighted_rfm_score"] - out.loc["C0", "base_rfm_score"] * 1.4) < 1e-6
    # Best customer (recent, frequent, big spend, happy) is a Growth-category promoter.
    assert out.loc["C0", "segment"] in {"Loyal Promoters", "Steady Loyal"}
    # A defaulted (missing) sentiment uses 0.0 ⇒ multiplier 1.0
    assert abs(out.loc["C5", "sentiment_multiplier"] - 1.0) < 1e-9


def test_rfm_from_facts_matches_shape():
    facts = pd.DataFrame({
        "customer_no": ["C1", "C2"],
        "order_count": [5, 1],
        "total_spend": [1250.0, 100.0],
        "last_order_date": ["2026-06-02", "2026-01-01"],
    })
    base = rfm_from_facts(facts, snapshot_date=pd.Timestamp("2026-06-30"))
    assert set(base.columns) == {"customer_no", "recency_days", "frequency", "monetary"}
    assert base.set_index("customer_no").loc["C1", "frequency"] == 5


def test_rfm_handles_low_cardinality_without_crashing():
    base = pd.DataFrame({"customer_no": ["A", "B"], "recency_days": [1, 100], "frequency": [10, 1], "monetary": [500, 10]})
    out = sentiment_weighted_rfm(base, pd.DataFrame(columns=["customer_no", "sentiment_score"]))
    assert len(out) == 2 and "segment" in out.columns
