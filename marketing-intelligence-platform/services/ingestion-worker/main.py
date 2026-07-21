"""Ingestion worker — Celery app + beat schedule.

Runs as a Railway background service (no public port). Redis (Railway add-on) is the broker + result
backend. Two scheduled jobs:

* ``fetch_social`` — pull the social-listening API into ``staging.social_raw_feeds`` + derive sentiment.
* ``sync_erp``    — pull ERP sales + customer facts (via the ERP public API) into the staging tables.

Run locally:
    celery -A main worker --beat --loglevel=info
On Railway (worker service start command):
    celery -A main worker --beat --loglevel=info --concurrency=2

The analytics-engine runs on its own schedule (`python run.py`) after the daily sync — see the README.
"""
from __future__ import annotations

import logging
import os
from datetime import timedelta

from celery import Celery
from celery.schedules import crontab
from celery.signals import worker_ready

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
FETCH_INTERVAL_MIN = int(os.environ.get("FETCH_INTERVAL_MIN", "30"))

app = Celery(
    "mi_ingestion",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=["tasks.fetch_social", "tasks.sync_erp"],
)

app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone=os.environ.get("TZ", "Asia/Bangkok"),
    enable_utc=True,
    task_acks_late=True,                 # re-deliver if a worker dies mid-task
    task_reject_on_worker_lost=True,
    worker_max_tasks_per_child=200,      # guard against slow memory growth in long-running workers
    broker_connection_retry_on_startup=True,
    result_expires=3600,
)

app.conf.beat_schedule = {
    "fetch-social-feeds": {
        "task": "tasks.fetch_social.fetch_social_feeds",
        "schedule": timedelta(minutes=FETCH_INTERVAL_MIN),
    },
    "sync-erp-daily": {
        "task": "tasks.sync_erp.sync_erp_data",
        "schedule": crontab(hour=2, minute=0),  # 02:00 business time
    },
    "refresh-customer-sentiment": {
        "task": "tasks.sync_erp.refresh_customer_sentiment",
        "schedule": crontab(hour=2, minute=30),
    },
}


@worker_ready.connect
def _bootstrap_on_boot(sender, **_kwargs) -> None:
    """On worker boot: create the data-warehouse schema and kick an initial sync so the pipeline
    populates without waiting for the beat schedule (fetch every 30 min, sync daily 02:00).

    Failures here must NOT crash the worker — the schema is also ensured idempotently inside each
    task, and the beat schedule will retry — so log and continue (no silent ``except: pass``).
    """
    log = logging.getLogger(__name__)
    try:
        from shared import ensure_schema

        ensure_schema()
        log.info("Data-warehouse schema ensured on worker boot.")
    except Exception:  # noqa: BLE001 — boot must survive a transient DB hiccup; tasks re-ensure
        log.exception("ensure_schema() on boot failed; will be retried when the first task runs.")

    # Kick the pipeline once so the first data lands right after deploy (idempotent tasks).
    for task_name in ("tasks.fetch_social.fetch_social_feeds", "tasks.sync_erp.sync_erp_data"):
        try:
            app.send_task(task_name)
            log.info("Dispatched initial task on boot: %s", task_name)
        except Exception:  # noqa: BLE001 — a broker hiccup shouldn't block boot; beat will run it
            log.exception("Initial dispatch of %s failed; the beat schedule will run it.", task_name)


if __name__ == "__main__":
    app.start()
