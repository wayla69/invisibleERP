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
from shared import ErpApiError, ErpClient  # noqa: E402

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


# ── Push-back to the ERP ───────────────────────────────────────────────────────────────────────────
def _push_to_erp() -> None:
    """POST the computed MMM / RFM / TOWS back into the ERP (scope analytics:write) so it owns what it
    renders at /marketing-intel. Reads the persisted ``analytics.*`` tables (the canonical result) and
    upserts one snapshot per kind. Opt-in via ERP_PUSH_ENABLED — off by default so a read-only key or an
    unconfigured ERP never turns a clean analytics run red."""
    if os.environ.get("ERP_PUSH_ENABLED", "0") != "1" or not os.environ.get("ERP_API_URL"):
        logger.info("ERP push-back disabled (set ERP_PUSH_ENABLED=1 + an analytics:write key to enable).")
        return

    snapshots: List[Dict] = []

    run = fetch_df("SELECT run_id, r2, total_spend FROM analytics.mmm_runs ORDER BY run_id DESC LIMIT 1")
    if not run.empty:
        rid = int(run.iloc[0]["run_id"])
        channels = fetch_df(
            "SELECT channel, spend, attributed_revenue, contribution_pct, roi FROM analytics.mmm_results "
            "WHERE run_id = :rid ORDER BY contribution_pct DESC", {"rid": rid}
        )
        snapshots.append({"kind": "mmm", "model_run_ref": str(rid), "payload": {
            "r2": float(run.iloc[0]["r2"]) if run.iloc[0]["r2"] is not None else None,
            "total_spend": float(run.iloc[0]["total_spend"] or 0),
            "channels": channels.to_dict(orient="records"),
        }})

    rfm = fetch_df("SELECT segment, COUNT(*) AS customers, SUM(monetary) AS monetary FROM analytics.customer_rfm_segments GROUP BY segment ORDER BY customers DESC")
    if not rfm.empty:
        # Per-customer assignments so the ERP can ACT on the segments (campaign targeting via mi_segment).
        members = fetch_df("SELECT customer_no, segment FROM analytics.customer_rfm_segments WHERE customer_no IS NOT NULL")
        snapshots.append({
            "kind": "rfm",
            "payload": {"segments": rfm.to_dict(orient="records")},
            "members": members.to_dict(orient="records"),
        })

    tows = fetch_df("SELECT quadrant, factor, recommendation, priority FROM analytics.tows_matrix ORDER BY priority ASC, quadrant ASC")
    if not tows.empty:
        snapshots.append({"kind": "tows", "payload": {"items": tows.to_dict(orient="records")}})

    if not snapshots:
        logger.warning("ERP push-back skipped — no analytics results to push yet.")
        return
    try:
        with ErpClient() as erp:
            res = erp.push_analytics_snapshots(snapshots)
        logger.info("Pushed %s analytics snapshots to the ERP: %s", res.get("pushed"), res.get("kinds"))
    except ErpApiError:
        logger.exception("ERP push-back failed (check the key has the analytics:write scope).")


def run_all() -> None:
    ensure_schema()
    mmm = _safe("MMM", _run_mmm)
    rfm = _safe("RFM", _run_rfm)
    _safe("TOWS", lambda: _run_tows(mmm, rfm))
    _safe("push-back", _push_to_erp)
    logger.info("Analytics run complete.")


def _safe(name: str, fn):
    try:
        return fn()
    except Exception:
        logger.exception("%s step failed — continuing.", name)
        return None


if __name__ == "__main__":
    run_all()
