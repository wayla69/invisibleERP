"""Analytics-engine orchestrator.

Reads the platform data warehouse, runs the three models (MMM -> RFM -> TOWS), and writes results back to
the ``analytics`` schema. Invoked by the ``run_analytics`` Celery task (or ``python -m run`` locally). Each
model is isolated so one failure doesn't sink the others; every step logs what it did.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from typing import Dict, List, Optional

import pandas as pd
from sqlalchemy import text

# Support both `python run.py` (flat) and package import.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from shared import connection, ensure_schema, fetch_df, get_engine, write_df  # noqa: E402

from mmm_model import ChannelSpec, MarketingMixModel  # noqa: E402
from rfm_model import rfm_from_facts, sentiment_weighted_rfm  # noqa: E402
from tows_analyzer import TowsAnalyzer  # noqa: E402

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("analytics-engine")


# ── MMM ──────────────────────────────────────────────────────────────────────────────────────────
def _build_mmm_frame() -> tuple[pd.DataFrame, List[ChannelSpec]]:
    """Daily revenue (target) joined with per-platform spend/engagement/views (media features)."""
    revenue = fetch_df("SELECT biz_date, SUM(revenue) AS revenue FROM staging.erp_sales_daily GROUP BY biz_date ORDER BY biz_date")
    social = fetch_df(
        "SELECT biz_date, platform, SUM(ad_spend) AS spend, SUM(engagement) AS engagement, SUM(views) AS views "
        "FROM core.social_sentiment_trends GROUP BY biz_date, platform"
    )
    if revenue.empty or social.empty:
        return pd.DataFrame(), []

    wide = social.pivot_table(index="biz_date", columns="platform", values=["spend", "engagement", "views"], fill_value=0)
    wide.columns = [f"{platform}_{metric}" for metric, platform in wide.columns]
    frame = revenue.merge(wide.reset_index(), on="biz_date", how="left").fillna(0.0).sort_values("biz_date")

    platforms = sorted(social["platform"].unique())
    channels = [
        ChannelSpec(name=p, spend_col=f"{p}_spend", extra_cols=[c for c in (f"{p}_engagement", f"{p}_views") if c in frame.columns])
        for p in platforms
        if f"{p}_spend" in frame.columns
    ]
    return frame, channels


def _run_mmm() -> Optional[pd.DataFrame]:
    frame, channels = _build_mmm_frame()
    if frame.empty or not channels:
        logger.warning("MMM skipped — no sales/social data in the warehouse yet.")
        return None

    model = MarketingMixModel(channels=channels, target_col="revenue", ridge_alpha=1.0, saturation="hill")
    model.fit(frame, optimize_adstock=os.environ.get("MMM_OPTIMIZE", "0") == "1")
    summary = model.summary_dict()

    window_from = str(frame["biz_date"].min())
    window_to = str(frame["biz_date"].max())
    with connection() as conn:
        run_id = conn.execute(
            text(
                "INSERT INTO analytics.mmm_runs (window_from, window_to, total_spend, r2, ridge_alpha, params) "
                "VALUES (:wf, :wt, :ts, :r2, :ra, CAST(:params AS jsonb)) RETURNING run_id"
            ),
            {"wf": window_from, "wt": window_to, "ts": summary["total_spend"], "r2": summary["r2"],
             "ra": summary["ridge_alpha"], "params": json.dumps({"intercept": summary["intercept"]})},
        ).scalar_one()
        for ch in summary["channels"]:
            conn.execute(
                text(
                    "INSERT INTO analytics.mmm_results (run_id, channel, beta, spend, attributed_revenue, "
                    "contribution_pct, roi, adstock_theta, saturation) "
                    "VALUES (:run_id, :channel, :beta, :spend, :ar, :cp, :roi, :theta, CAST(:sat AS jsonb)) "
                    "ON CONFLICT (run_id, channel) DO NOTHING"
                ),
                {"run_id": run_id, "channel": ch["channel"], "beta": ch["beta"], "spend": ch["spend"],
                 "ar": ch["attributed_revenue"], "cp": ch["contribution_pct"], "roi": ch["roi"],
                 "theta": ch["adstock_theta"], "sat": json.dumps(ch["saturation"])},
            )
    logger.info("MMM run %s persisted (R²=%.3f, %d channels).", run_id, summary["r2"], len(summary["channels"]))
    return pd.DataFrame(summary["channels"]).assign(run_id=run_id)


# ── RFM ──────────────────────────────────────────────────────────────────────────────────────────
def _run_rfm() -> Optional[pd.DataFrame]:
    facts = fetch_df("SELECT customer_no, order_count, total_spend, last_order_date FROM staging.erp_customer_facts")
    if facts.empty:
        logger.warning("RFM skipped — no customer facts synced yet.")
        return None
    sentiment = fetch_df("SELECT customer_no, avg_sentiment_score AS sentiment_score FROM core.customer_sentiment")
    base = rfm_from_facts(facts)
    result = sentiment_weighted_rfm(base, sentiment)

    persist = result.drop(columns=["category"])  # category is derived; the table stores the segment label
    with get_engine().begin() as conn:
        conn.exec_driver_sql("TRUNCATE analytics.customer_rfm_segments")
    write_df(persist, "customer_rfm_segments", schema="analytics")
    logger.info("RFM persisted for %d customers.", len(result))
    return result


# ── TOWS ─────────────────────────────────────────────────────────────────────────────────────────
def _run_tows(mmm: Optional[pd.DataFrame], rfm: Optional[pd.DataFrame]) -> None:
    sentiment = fetch_df(
        "SELECT platform, AVG(sentiment_score) AS avg_sentiment, SUM(engagement) AS engagement "
        "FROM core.social_sentiment_trends GROUP BY platform"
    )
    tows = TowsAnalyzer().build(
        mmm if mmm is not None else pd.DataFrame(),
        rfm if rfm is not None else pd.DataFrame(),
        sentiment,
    )
    run_id = int(mmm["run_id"].iloc[0]) if mmm is not None and not mmm.empty else None
    with get_engine().begin() as conn:
        conn.exec_driver_sql("TRUNCATE analytics.tows_matrix")
    write_df(tows.assign(run_id=run_id), "tows_matrix", schema="analytics")
    logger.info("TOWS persisted (%d recommendations).", len(tows))


def run_all() -> None:
    ensure_schema()
    mmm = _safe("MMM", _run_mmm)
    rfm = _safe("RFM", _run_rfm)
    _safe("TOWS", lambda: _run_tows(mmm, rfm))
    logger.info("Analytics run complete.")


def _safe(name: str, fn):
    try:
        return fn()
    except Exception:
        logger.exception("%s step failed — continuing.", name)
        return None


if __name__ == "__main__":
    run_all()
