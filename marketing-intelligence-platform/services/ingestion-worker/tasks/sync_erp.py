"""ERP sync task.

Pulls the ERP's own sales + customer data through its public API (`/api/v1`, analytics:read key) into the
platform's staging tables. This is the ONLY coupling to the ERP — HTTP, never a shared DB. Idempotent
upserts on each table's grain key, so a re-run just refreshes.
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import date, timedelta
from typing import Dict

from celery import shared_task

# ── make the `shared` package importable in both the repo and the container layout ──────────────────
_here = os.path.dirname(os.path.abspath(__file__))
for _ in range(6):
    if os.path.isdir(os.path.join(_here, "shared")):
        if _here not in sys.path:
            sys.path.insert(0, _here)
        break
    _here = os.path.dirname(_here)

from shared import ErpClient, connection, ensure_schema  # noqa: E402
from sqlalchemy import text  # noqa: E402

logger = logging.getLogger(__name__)

SYNC_WINDOW_DAYS = int(os.environ.get("SYNC_WINDOW_DAYS", "90"))


@shared_task(name="tasks.sync_erp.sync_erp_data", bind=True, max_retries=3, default_retry_delay=120)
def sync_erp_data(self) -> Dict[str, int]:
    """Sync daily sales + per-customer facts from the ERP into staging. Returns row counts."""
    ensure_schema()
    date_to = date.today()
    date_from = date_to - timedelta(days=SYNC_WINDOW_DAYS)
    counts: Dict[str, int] = {}
    with ErpClient() as erp:
        me = erp.me()
        logger.info("ERP sync as %s (tenant %s, scopes %s)", me.get("principal"), me.get("tenant_id"), me.get("scopes"))
        counts["sales_daily"] = _sync_sales(erp, date_from.isoformat(), date_to.isoformat())
        counts["customer_facts"] = _sync_customers(erp, date_from.isoformat(), date_to.isoformat())
    logger.info("ERP sync complete: %s", counts)
    return counts


def _sync_sales(erp: ErpClient, date_from: str, date_to: str) -> int:
    rows = erp.fetch_sales_daily(date_from, date_to, group_by="product")
    if not rows:
        logger.warning("ERP sales/daily returned no rows for %s..%s", date_from, date_to)
        return 0
    payload = [
        {
            "d": r["date"],
            "sku": (r.get("product") or "")[:80],
            "rev": float(r.get("revenue") or 0.0),
            "units": int(r.get("units") or 0),
        }
        for r in rows
        if r.get("date")
    ]
    with connection() as conn:
        conn.execute(
            text(
                "INSERT INTO staging.erp_sales_daily (biz_date, product_sku, channel, revenue, units_sold) "
                "VALUES (:d, :sku, '', :rev, :units) "
                "ON CONFLICT (biz_date, product_sku, channel) DO UPDATE SET "
                "revenue = EXCLUDED.revenue, units_sold = EXCLUDED.units_sold, synced_at = now()"
            ),
            payload,
        )
    return len(payload)


def _sync_customers(erp: ErpClient, date_from: str, date_to: str) -> int:
    rows = erp.fetch_customer_transactions(date_from, date_to)
    if not rows:
        logger.warning("ERP customers/transactions returned no rows")
        return 0
    payload = [
        {
            "cno": r["customer_no"],
            "oc": int(r.get("order_count") or 0),
            "ts": float(r.get("total_spend") or 0.0),
            "aov": (float(r["avg_order_value"]) if r.get("avg_order_value") is not None else None),
            "fod": _as_date(r.get("first_order_date")),
            "lod": _as_date(r.get("last_order_date")),
        }
        for r in rows
        if r.get("customer_no")
    ]
    with connection() as conn:
        conn.execute(
            text(
                "INSERT INTO staging.erp_customer_facts "
                "(customer_no, order_count, total_spend, avg_order_value, first_order_date, last_order_date) "
                "VALUES (:cno, :oc, :ts, :aov, :fod, :lod) "
                "ON CONFLICT (customer_no) DO UPDATE SET "
                "order_count = EXCLUDED.order_count, total_spend = EXCLUDED.total_spend, "
                "avg_order_value = EXCLUDED.avg_order_value, first_order_date = EXCLUDED.first_order_date, "
                "last_order_date = EXCLUDED.last_order_date, synced_at = now()"
            ),
            payload,
        )
    return len(payload)


@shared_task(name="tasks.sync_erp.refresh_customer_sentiment")
def refresh_customer_sentiment() -> int:
    """Map social sentiment onto customers for the RFM multiplier.

    The ERP does not link individual customers to social handles, so this applies a **segment-level** mapping
    (the spec allows customer_id OR demographic segment): the recent overall social sentiment is assigned to
    every known customer. Replace with a real per-customer social join when handle-linkage exists.
    """
    ensure_schema()
    with connection() as conn:
        avg = conn.execute(
            text(
                "SELECT COALESCE(AVG(sentiment_score), 0) FROM core.social_sentiment_trends "
                "WHERE biz_date >= (CURRENT_DATE - INTERVAL '30 days')"
            )
        ).scalar_one()
        n = conn.execute(
            text(
                "INSERT INTO core.customer_sentiment (customer_no, avg_sentiment_score, refreshed_at) "
                "SELECT customer_no, :s, now() FROM staging.erp_customer_facts "
                "ON CONFLICT (customer_no) DO UPDATE SET avg_sentiment_score = EXCLUDED.avg_sentiment_score, refreshed_at = now()"
            ),
            {"s": round(float(avg), 3)},
        ).rowcount
    logger.info("Refreshed customer sentiment for %d customers (segment-level avg=%.3f).", n, float(avg))
    return n


def _as_date(value):
    """Normalize an ISO datetime/date string to a date (the ERP returns timestamptz for order dates)."""
    if not value:
        return None
    return str(value)[:10]
