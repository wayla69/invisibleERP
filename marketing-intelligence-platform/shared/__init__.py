"""Shared utilities for the Marketing Intelligence Platform (DB access + ERP API client)."""
from .db_connection import (
    connection,
    dispose,
    ensure_schema,
    execute,
    fetch_df,
    get_engine,
    write_df,
)
from .erp_client import ErpApiError, ErpClient, ErpConfig

__all__ = [
    "connection",
    "dispose",
    "ensure_schema",
    "execute",
    "fetch_df",
    "get_engine",
    "write_df",
    "ErpApiError",
    "ErpClient",
    "ErpConfig",
]
