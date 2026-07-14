"""Sentiment-Weighted RFM model.

Classic RFM (Recency, Frequency, Monetary) scoring, then multiplied by a social-sentiment factor to surface
*actionable* segments (a happy big spender and an unhappy big spender need different plays). Two entry
points share one scoring/segmentation core:

* ``compute_rfm`` — from raw transactions (customer_id, order_date, order_value) per the classic spec.
* ``rfm_from_facts`` — from the ERP's pre-aggregated per-customer purchase facts (what
  ``GET /api/v1/customers/transactions`` returns), so the live pipeline needn't re-aggregate.
"""
from __future__ import annotations

import logging
from typing import Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

SENTIMENT_WEIGHT = 0.5  # Multiplier = 1 + SENTIMENT_WEIGHT * sentiment_score  (sentiment in [-1, 1])


def _quantile_score(series: pd.Series, reverse: bool = False, bins: int = 5) -> pd.Series:
    """Assign an integer score 1..bins by quantile. ``reverse=True`` gives the smallest value the top score
    (used for Recency: fewer days since purchase = better). Robust to ties and low cardinality: ranks with
    ``method='first'`` guarantee unique edges; too-few-distinct falls back to a linear cut.
    """
    ranks = series.rank(method="first")
    labels = list(range(1, bins + 1))
    try:
        scored = pd.qcut(ranks, bins, labels=labels).astype(int)
    except ValueError:
        n = max(int(series.nunique()), 1)
        binned = pd.cut(ranks, bins=min(bins, n), labels=False)
        # spread whatever bins we got across the 1..bins scale
        scored = (binned.astype(float) / max(min(bins, n) - 1, 1) * (bins - 1) + 1).round().astype(int)
    if reverse:
        scored = (bins + 1) - scored
    return scored


def compute_rfm(transactions: pd.DataFrame, snapshot_date: Optional[pd.Timestamp] = None) -> pd.DataFrame:
    """Aggregate raw transactions into per-customer Recency/Frequency/Monetary.

    ``transactions`` needs columns ``customer_id``, ``order_date`` (datetime-like), ``order_value``.
    Recency = days from the customer's last order to ``snapshot_date`` (defaults to the latest order date).
    """
    required = {"customer_id", "order_date", "order_value"}
    missing = required - set(transactions.columns)
    if missing:
        raise KeyError(f"transactions missing columns: {sorted(missing)}")
    tx = transactions.copy()
    tx["order_date"] = pd.to_datetime(tx["order_date"])
    snap = pd.to_datetime(snapshot_date) if snapshot_date is not None else tx["order_date"].max()

    grouped = tx.groupby("customer_id").agg(
        last_order=("order_date", "max"),
        frequency=("order_date", "count"),
        monetary=("order_value", "sum"),
    )
    grouped["recency_days"] = (snap - grouped["last_order"]).dt.days.clip(lower=0)
    return grouped.reset_index().rename(columns={"customer_id": "customer_no"})[
        ["customer_no", "recency_days", "frequency", "monetary"]
    ]


def rfm_from_facts(facts: pd.DataFrame, snapshot_date: Optional[pd.Timestamp] = None) -> pd.DataFrame:
    """Build the RFM base from pre-aggregated ERP facts (customer_no, order_count, total_spend,
    last_order_date)."""
    required = {"customer_no", "order_count", "total_spend", "last_order_date"}
    missing = required - set(facts.columns)
    if missing:
        raise KeyError(f"facts missing columns: {sorted(missing)}")
    f = facts.copy()
    f["last_order_date"] = pd.to_datetime(f["last_order_date"])
    snap = pd.to_datetime(snapshot_date) if snapshot_date is not None else f["last_order_date"].max()
    f["recency_days"] = (snap - f["last_order_date"]).dt.days.clip(lower=0)
    return f.rename(columns={"order_count": "frequency", "total_spend": "monetary"})[
        ["customer_no", "recency_days", "frequency", "monetary"]
    ]


def _assign_segment(base_rfm: float, r: int, f: int, m: int, sentiment: float) -> str:
    """Map an RFM tier + sentiment onto an actionable segment label.

    High value = high F and M. Recency (r) low ⇒ hasn't bought lately. Sentiment splits otherwise-similar
    customers into save-vs-grow plays.
    """
    high_value = f >= 4 and m >= 4
    recent = r >= 4
    if high_value and recent and sentiment >= 0.2:
        return "Loyal Promoters"          # Growth: reward + referral
    if high_value and (not recent or sentiment < 0):
        return "At Risk VIPs"             # Risk: valuable but lapsing / unhappy — win-back priority
    if base_rfm <= 6 and sentiment < 0:
        return "Churn Risk"               # Churn: low engagement + negative sentiment
    if recent and f <= 2:
        return "New / Growing"            # Growth: nurture to loyalty
    if base_rfm >= 12:
        return "Steady Loyal"             # Growth/stable
    return "Needs Attention"              # Stable: re-engage


# Coarse category the analytics-engine prompt asked for (Risk / Churn / Growth), derived from the segment.
_SEGMENT_CATEGORY = {
    "Loyal Promoters": "Growth",
    "Steady Loyal": "Growth",
    "New / Growing": "Growth",
    "At Risk VIPs": "Risk",
    "Churn Risk": "Churn",
    "Needs Attention": "Stable",
}


def sentiment_weighted_rfm(
    rfm_base: pd.DataFrame,
    sentiment: pd.DataFrame,
    default_sentiment: float = 0.0,
) -> pd.DataFrame:
    """Score RFM, apply the sentiment multiplier, and segment.

    ``rfm_base``: customer_no, recency_days, frequency, monetary (from ``compute_rfm``/``rfm_from_facts``).
    ``sentiment``: customer_no, sentiment_score in [-1, 1] (missing customers use ``default_sentiment``).
    Returns a DataFrame ready for ``analytics.customer_rfm_segments``.
    """
    df = rfm_base.copy()
    if df.empty:
        return df.assign(segment=pd.Series(dtype=str))

    df["r_score"] = _quantile_score(df["recency_days"], reverse=True)   # fewer days ⇒ higher score
    df["f_score"] = _quantile_score(df["frequency"])
    df["m_score"] = _quantile_score(df["monetary"])
    df["base_rfm_score"] = df["r_score"] + df["f_score"] + df["m_score"]  # 3..15

    sent = sentiment[["customer_no", "sentiment_score"]].copy() if not sentiment.empty else pd.DataFrame(columns=["customer_no", "sentiment_score"])
    df = df.merge(sent, on="customer_no", how="left")
    df["sentiment_score"] = df["sentiment_score"].fillna(default_sentiment).clip(-1.0, 1.0)

    df["sentiment_multiplier"] = 1.0 + SENTIMENT_WEIGHT * df["sentiment_score"]
    df["weighted_rfm_score"] = (df["base_rfm_score"] * df["sentiment_multiplier"]).round(3)

    df["segment"] = df.apply(
        lambda x: _assign_segment(x["base_rfm_score"], int(x["r_score"]), int(x["f_score"]), int(x["m_score"]), float(x["sentiment_score"])),
        axis=1,
    )
    df["category"] = df["segment"].map(_SEGMENT_CATEGORY).fillna("Stable")

    logger.info("RFM: scored %d customers; segments: %s", len(df), df["segment"].value_counts().to_dict())
    return df[[
        "customer_no", "recency_days", "frequency", "monetary",
        "r_score", "f_score", "m_score", "base_rfm_score",
        "sentiment_score", "sentiment_multiplier", "weighted_rfm_score", "segment", "category",
    ]]
