"""HTTP client for the Invisible ERP public API (`/api/v1`).

This is the platform's ONLY coupling to the ERP — machine-to-machine over HTTP, never a shared database.
Auth is a tenant-bound API key (`Authorization: Bearer ierp_…`) minted in the ERP at
``POST /api/platform/api-keys`` with the ``analytics:read`` scope. The client is resilient (retry with
backoff on 5xx/connect errors, explicit 429 rate-limit handling honouring ``Retry-After``) and typed.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = logging.getLogger(__name__)


class ErpApiError(RuntimeError):
    """Raised for a non-retryable ERP API failure (auth, scope, 4xx)."""


@dataclass
class ErpConfig:
    base_url: str
    api_key: str
    timeout: float = 30.0
    max_retries: int = 4

    @classmethod
    def from_env(cls) -> "ErpConfig":
        base_url = os.environ.get("ERP_API_URL", "").rstrip("/")
        api_key = os.environ.get("ERP_API_KEY", "")
        if not base_url or not api_key:
            raise RuntimeError("ERP_API_URL and ERP_API_KEY must be set to reach the ERP public API.")
        if not api_key.startswith("ierp_"):
            logger.warning("ERP_API_KEY does not look like an 'ierp_' key — check the value.")
        return cls(base_url=base_url, api_key=api_key)


class ErpClient:
    """Thin, resilient wrapper over the ERP `/api/v1` surface."""

    def __init__(self, config: Optional[ErpConfig] = None) -> None:
        self.cfg = config or ErpConfig.from_env()
        self._session = requests.Session()
        self._session.headers.update(
            {"Authorization": f"Bearer {self.cfg.api_key}", "Accept": "application/json"}
        )
        # urllib3 retry for transient transport/5xx errors (429 handled explicitly below so we can honour
        # Retry-After precisely rather than urllib3's generic backoff).
        retry = Retry(
            total=self.cfg.max_retries,
            connect=self.cfg.max_retries,
            read=self.cfg.max_retries,
            status_forcelist=(500, 502, 503, 504),
            allowed_methods=("GET",),
            backoff_factor=1.0,
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=8)
        self._session.mount("http://", adapter)
        self._session.mount("https://", adapter)

    # ── low-level GET with explicit 429 backoff ─────────────────────────────────────────────────────
    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.cfg.base_url}{path}"
        for attempt in range(self.cfg.max_retries + 1):
            resp = self._session.get(url, params=params, timeout=self.cfg.timeout)
            if resp.status_code == 429:
                wait = _retry_after_seconds(resp, default=2 ** attempt)
                logger.warning("ERP rate-limited on %s (attempt %d) — sleeping %.1fs", path, attempt + 1, wait)
                time.sleep(wait)
                continue
            if resp.status_code in (401, 403):
                # Non-retryable: bad/expired key or a missing scope (analytics:read).
                raise ErpApiError(
                    f"ERP auth/scope error {resp.status_code} on {path}: {resp.text[:200]} "
                    f"(the key needs the 'analytics:read' scope)"
                )
            if resp.status_code >= 400:
                raise ErpApiError(f"ERP API {resp.status_code} on {path}: {resp.text[:200]}")
            return resp.json()
        raise ErpApiError(f"ERP API still rate-limited after {self.cfg.max_retries} retries on {path}")

    def _paginate(self, path: str, params: Optional[Dict[str, Any]] = None, page_size: int = 200) -> Iterator[Dict[str, Any]]:
        """Yield every row from a paginated `{ data, pagination }` endpoint."""
        offset = 0
        params = dict(params or {})
        while True:
            params.update({"limit": page_size, "offset": offset})
            body = self._get(path, params)
            rows: List[Dict[str, Any]] = body.get("data", [])
            for row in rows:
                yield row
            if len(rows) < page_size:
                return
            offset += page_size

    # ── typed feeds the ingestion worker consumes ───────────────────────────────────────────────────
    def me(self) -> Dict[str, Any]:
        """Identify the key (tenant + scopes) — a cheap connectivity/scope check."""
        return self._get("/api/v1/me")

    def fetch_sales_daily(self, date_from: str, date_to: str, group_by: str = "day") -> List[Dict[str, Any]]:
        """GET /api/v1/sales/daily — per-day revenue series (the MMM target)."""
        body = self._get("/api/v1/sales/daily", {"from": date_from, "to": date_to, "group_by": group_by})
        return body.get("data", [])

    def push_analytics_snapshots(self, snapshots: List[Dict[str, Any]]) -> Dict[str, Any]:
        """POST /api/v1/analytics/snapshots — push computed MMM/RFM/TOWS back into the ERP.

        The key must hold the `analytics:write` scope (distinct from the read scope). Each snapshot is
        `{ "kind": "mmm"|"rfm"|"tows", "payload": {...}, "model_run_ref": "..."?, "model_card": {...}? }`
        — the `model_card` (docs/60 Phase 4) carries the run's version / training window / features / metrics
        for the ERP's governance surface. Append-only server-side (history preserved).
        """
        return self._post("/api/v1/analytics/snapshots", {"snapshots": snapshots})

    def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.cfg.base_url}{path}"
        for attempt in range(self.cfg.max_retries + 1):
            resp = self._session.post(url, json=body, timeout=self.cfg.timeout)
            if resp.status_code == 429:
                wait = _retry_after_seconds(resp, default=2 ** attempt)
                logger.warning("ERP rate-limited on %s (attempt %d) — sleeping %.1fs", path, attempt + 1, wait)
                time.sleep(wait)
                continue
            if resp.status_code in (401, 403):
                raise ErpApiError(
                    f"ERP auth/scope error {resp.status_code} on {path}: {resp.text[:200]} "
                    f"(the key needs the 'analytics:write' scope)"
                )
            if resp.status_code >= 400:
                raise ErpApiError(f"ERP API {resp.status_code} on {path}: {resp.text[:200]}")
            return resp.json()
        raise ErpApiError(f"ERP API still rate-limited after {self.cfg.max_retries} retries on {path}")

    def fetch_customer_transactions(self, date_from: Optional[str] = None, date_to: Optional[str] = None) -> List[Dict[str, Any]]:
        """GET /api/v1/customers/transactions — per-customer RFM base facts (auto-paginated)."""
        params: Dict[str, Any] = {}
        if date_from:
            params["from"] = date_from
        if date_to:
            params["to"] = date_to
        return list(self._paginate("/api/v1/customers/transactions", params))

    def fetch_invoices(self, status: Optional[str] = None) -> List[Dict[str, Any]]:
        """GET /api/v1/invoices — AR invoices (auto-paginated)."""
        params = {"status": status} if status else {}
        return list(self._paginate("/api/v1/invoices", params))

    def fetch_experiment_outcomes(self, limit: int = 100) -> List[Dict[str, Any]]:
        """GET /api/v1/marketing/experiment-outcomes — measured campaign LIFT (docs/60 Phase 3 pull-back).

        The ERP splits an activated segment into a treatment arm and a randomised holdout control, then
        measures the incremental revenue the campaign caused. Pulling these realised outcomes lets the next
        MMM fit use campaign lift as a regressor — the loop's feedback edge. Returns a list of
        ``{experiment_no, segment, incremental_revenue, lift_pct, treatment_count, control_count,
        window_days, measured_at}``.
        """
        return self._get("/api/v1/marketing/experiment-outcomes", {"limit": limit}).get("outcomes", [])

    def close(self) -> None:
        self._session.close()

    def __enter__(self) -> "ErpClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


def _retry_after_seconds(resp: requests.Response, default: float) -> float:
    header = resp.headers.get("Retry-After")
    if header:
        try:
            return max(float(header), 0.5)
        except ValueError:
            pass
    return max(float(default), 0.5)
