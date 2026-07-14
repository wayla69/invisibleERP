"""Shared database access for the Marketing Intelligence Platform.

A single pooled SQLAlchemy engine (the platform's OWN Railway Postgres data warehouse), plus small
context-manager helpers so every service uses one connection-pooling strategy. Never hard-codes
credentials — everything comes from ``DATABASE_URL``.
"""
from __future__ import annotations

import logging
import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional, Sequence

import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine

logger = logging.getLogger(__name__)

_SCHEMA_SQL = Path(__file__).with_name("schema.sql")

_engine: Optional[Engine] = None
_engine_lock = threading.Lock()


def _normalize_url(url: str) -> str:
    """Railway/Heroku hand out ``postgres://…``; SQLAlchemy 2.x needs an explicit driver."""
    if url.startswith("postgres://"):
        url = "postgresql+psycopg2://" + url[len("postgres://") :]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg2://" + url[len("postgresql://") :]
    return url


def get_engine() -> Engine:
    """Return the process-wide pooled engine (created lazily, thread-safe)."""
    global _engine
    if _engine is not None:
        return _engine
    with _engine_lock:
        if _engine is not None:  # re-check inside the lock
            return _engine
        raw_url = os.environ.get("DATABASE_URL")
        if not raw_url:
            raise RuntimeError("DATABASE_URL is not set — cannot connect to the data warehouse.")
        _engine = create_engine(
            _normalize_url(raw_url),
            pool_size=int(os.environ.get("DB_POOL_SIZE", "5")),
            max_overflow=int(os.environ.get("DB_MAX_OVERFLOW", "10")),
            pool_pre_ping=True,           # drop dead connections instead of erroring mid-query
            pool_recycle=1800,            # recycle every 30 min (proxies drop idle conns)
            pool_timeout=30,
            future=True,
            connect_args={"application_name": os.environ.get("SERVICE_NAME", "mi-platform")},
        )
        logger.info("Database engine initialised (pool_size=%s).", _engine.pool.size())
        return _engine


@contextmanager
def connection() -> Iterator[Connection]:
    """A pooled connection inside a transaction (commit on success, rollback on error)."""
    engine = get_engine()
    conn = engine.connect()
    trans = conn.begin()
    try:
        yield conn
        trans.commit()
    except Exception:
        trans.rollback()
        logger.exception("DB transaction rolled back.")
        raise
    finally:
        conn.close()


def execute(sql: str, params: Optional[Mapping[str, Any] | Sequence[Mapping[str, Any]]] = None) -> None:
    """Run a parameterized statement (or a batch, if ``params`` is a list of dicts)."""
    with connection() as conn:
        conn.execute(text(sql), params or {})


def fetch_df(sql: str, params: Optional[Mapping[str, Any]] = None) -> pd.DataFrame:
    """Read a SQL query into a DataFrame using a pooled connection (parameterized — never f-string SQL)."""
    with get_engine().connect() as conn:
        return pd.read_sql(text(sql), conn, params=dict(params or {}))


def write_df(df: pd.DataFrame, table: str, schema: str, if_exists: str = "append") -> int:
    """Bulk-write a DataFrame to ``schema.table``. Returns the row count written."""
    if df.empty:
        logger.info("write_df: nothing to write to %s.%s", schema, table)
        return 0
    with get_engine().begin() as conn:
        df.to_sql(table, conn, schema=schema, if_exists=if_exists, index=False, method="multi", chunksize=500)
    logger.info("write_df: wrote %d row(s) to %s.%s", len(df), schema, table)
    return len(df)


def ensure_schema() -> None:
    """Create the staging/core/analytics schemas + tables if missing (idempotent). Call on boot."""
    ddl = _SCHEMA_SQL.read_text(encoding="utf-8")
    # psycopg2 handles multi-statement scripts via exec_driver_sql; run inside one transaction.
    with get_engine().begin() as conn:
        conn.exec_driver_sql(ddl)
    logger.info("Data-warehouse schema ensured (staging/core/analytics).")


def dispose() -> None:
    """Dispose the pool (useful for worker shutdown / tests)."""
    global _engine
    if _engine is not None:
        _engine.dispose()
        _engine = None
