"""Social-listening ingestion task.

Fetches per-platform social payloads (a real API if configured, else a deterministic-ish mock so the
service runs on Railway out of the box), stores the raw JSON in ``staging.social_raw_feeds``, cleans the
text, scores sentiment with a lightweight lexicon, and rolls it up into ``core.social_sentiment_trends``.
Resilient: retry/backoff on transport + explicit 429 rate-limit handling; explicit error handling and
logging throughout (no silent excepts).
"""
from __future__ import annotations

import json
import logging
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests
from celery import shared_task
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ── make the `shared` package importable in both the repo and the container layout ──────────────────
_here = os.path.dirname(os.path.abspath(__file__))
for _ in range(6):
    if os.path.isdir(os.path.join(_here, "shared")):
        if _here not in sys.path:
            sys.path.insert(0, _here)
        break
    _here = os.path.dirname(_here)

from shared import connection, ensure_schema, get_engine  # noqa: E402
from sqlalchemy import text  # noqa: E402

logger = logging.getLogger(__name__)

PLATFORMS = os.environ.get("SOCIAL_PLATFORMS", "tiktok,x,instagram,facebook").split(",")

# ── text cleaning (basic regex) ─────────────────────────────────────────────────────────────────────
_URL_RE = re.compile(r"https?://\S+|www\.\S+")
_MENTION_RE = re.compile(r"@\w+")
_HASHTAG_RE = re.compile(r"#(\w+)")
_EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF]",  # symbols/emoji/flags
    flags=re.UNICODE,
)
_NON_WORD_RE = re.compile(r"[^\w\s]", re.UNICODE)
_WS_RE = re.compile(r"\s+")


def clean_text(raw: str) -> str:
    """Basic regex cleaning: lowercase, strip URLs/mentions/emoji/punctuation, keep hashtag words,
    collapse whitespace. Prepares text for sentiment scoring / the next pipeline step."""
    if not raw:
        return ""
    t = raw.lower()
    t = _URL_RE.sub(" ", t)
    t = _MENTION_RE.sub(" ", t)
    t = _HASHTAG_RE.sub(r"\1", t)      # "#great" -> "great"
    t = _EMOJI_RE.sub(" ", t)
    t = _NON_WORD_RE.sub(" ", t)
    return _WS_RE.sub(" ", t).strip()


# Tiny sentiment lexicon (deliberately simple — swap for a model later). Returns a score in [-1, 1].
_POS = {"love", "great", "amazing", "best", "good", "excellent", "happy", "recommend", "awesome", "perfect", "fast", "delicious", "worth"}
_NEG = {"bad", "worst", "hate", "slow", "terrible", "broken", "late", "poor", "disappointed", "refund", "scam", "rude", "expensive"}


def score_sentiment(cleaned: str) -> float:
    tokens = cleaned.split()
    if not tokens:
        return 0.0
    pos = sum(tok in _POS for tok in tokens)
    neg = sum(tok in _NEG for tok in tokens)
    if pos + neg == 0:
        return 0.0
    return round((pos - neg) / (pos + neg), 3)


# ── social API client (real or mock) ────────────────────────────────────────────────────────────────
class SocialListeningClient:
    """Fetch social posts for a platform. Uses the configured API when ``SOCIAL_API_BASE_URL`` is set,
    otherwise synthesizes a realistic batch so the pipeline runs without external credentials."""

    def __init__(self) -> None:
        self.base_url = os.environ.get("SOCIAL_API_BASE_URL", "").rstrip("/")
        self.api_key = os.environ.get("SOCIAL_API_KEY", "")
        self.max_retries = int(os.environ.get("SOCIAL_MAX_RETRIES", "4"))
        self._session = requests.Session()
        if self.api_key:
            self._session.headers["Authorization"] = f"Bearer {self.api_key}"
        retry = Retry(total=self.max_retries, connect=self.max_retries, read=self.max_retries,
                      status_forcelist=(500, 502, 503, 504), allowed_methods=("GET",),
                      backoff_factor=1.0, raise_on_status=False)
        adapter = HTTPAdapter(max_retries=retry)
        self._session.mount("http://", adapter)
        self._session.mount("https://", adapter)

    def fetch(self, platform: str) -> List[Dict[str, Any]]:
        if not self.base_url:
            return self._mock(platform)
        url = f"{self.base_url}/posts"
        for attempt in range(self.max_retries + 1):
            resp = self._session.get(url, params={"platform": platform}, timeout=30)
            if resp.status_code == 429:
                wait = _retry_after(resp, default=2 ** attempt)
                logger.warning("Social API 429 for %s — backing off %.1fs (attempt %d)", platform, wait, attempt + 1)
                time.sleep(wait)
                continue
            if resp.status_code >= 400:
                raise RuntimeError(f"Social API {resp.status_code} for {platform}: {resp.text[:200]}")
            return resp.json().get("posts", resp.json() if isinstance(resp.json(), list) else [])
        raise RuntimeError(f"Social API still rate-limited after {self.max_retries} retries ({platform})")

    def _mock(self, platform: str) -> List[Dict[str, Any]]:
        rng = random.Random(f"{platform}-{datetime.now(timezone.utc):%Y%m%d%H}")
        samples = [
            "I love this brand, the delivery was so fast and the food is delicious #great",
            "Worst experience, my order was late and the support was rude, want a refund",
            "Pretty good value overall, would recommend to friends",
            "Too expensive now, quality feels poor lately :(",
            "Amazing campaign on {p}! best promo this year".format(p=platform),
        ]
        posts = []
        for i in range(rng.randint(8, 20)):
            txt = rng.choice(samples)
            posts.append({
                "id": f"{platform}-{datetime.now(timezone.utc):%Y%m%d}-{i}",
                "platform": platform,
                "text": txt,
                "views": rng.randint(500, 50000),
                "likes": rng.randint(10, 3000),
                "shares": rng.randint(0, 500),
                "comments": rng.randint(0, 400),
                "ad_spend": round(rng.uniform(200, 5000), 2),
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
        return posts

    def close(self) -> None:
        self._session.close()


def _retry_after(resp: requests.Response, default: float) -> float:
    hdr = resp.headers.get("Retry-After")
    if hdr:
        try:
            return max(float(hdr), 0.5)
        except ValueError:
            pass
    return max(float(default), 0.5)


# ── the Celery task ─────────────────────────────────────────────────────────────────────────────────
@shared_task(name="tasks.fetch_social.fetch_social_feeds", bind=True, max_retries=3, default_retry_delay=60)
def fetch_social_feeds(self, platforms: Optional[List[str]] = None) -> Dict[str, int]:
    """Fetch → store raw → clean → score → roll up per platform. Returns per-platform post counts."""
    ensure_schema()
    client = SocialListeningClient()
    platforms = platforms or PLATFORMS
    counts: Dict[str, int] = {}
    biz_date = datetime.now(timezone.utc).date().isoformat()
    try:
        for platform in platforms:
            platform = platform.strip()
            try:
                posts = client.fetch(platform)
            except Exception as exc:  # a single platform failing must not abort the others
                logger.exception("Social fetch failed for %s: %s", platform, exc)
                continue
            _store_raw(platform, posts)
            _rollup_sentiment(biz_date, platform, posts)
            counts[platform] = len(posts)
            logger.info("Social ingest: %s -> %d post(s)", platform, len(posts))
    finally:
        client.close()
    return counts


def _store_raw(platform: str, posts: List[Dict[str, Any]]) -> None:
    if not posts:
        return
    with connection() as conn:
        conn.execute(
            text("INSERT INTO staging.social_raw_feeds (platform, raw_payload) VALUES (:p, CAST(:payload AS jsonb))"),
            [{"p": platform, "payload": json.dumps(post)} for post in posts],
        )


def _rollup_sentiment(biz_date: str, platform: str, posts: List[Dict[str, Any]]) -> None:
    """Clean each post, score sentiment, aggregate to one (biz_date, platform) row (idempotent upsert)."""
    if not posts:
        return
    mentions = len(posts)
    engagement = sum(int(p.get("likes", 0)) + int(p.get("shares", 0)) + int(p.get("comments", 0)) for p in posts)
    views = sum(int(p.get("views", 0)) for p in posts)
    ad_spend = round(sum(float(p.get("ad_spend", 0.0)) for p in posts), 2)
    scores = [score_sentiment(clean_text(str(p.get("text", "")))) for p in posts]
    avg_sentiment = round(sum(scores) / len(scores), 3) if scores else 0.0

    with connection() as conn:
        conn.execute(
            text(
                "INSERT INTO core.social_sentiment_trends "
                "(biz_date, platform, keyword_or_topic, mention_count, engagement, views, ad_spend, sentiment_score) "
                "VALUES (:d, :p, '', :m, :e, :v, :s, :sent) "
                "ON CONFLICT (biz_date, platform, keyword_or_topic) DO UPDATE SET "
                "mention_count = EXCLUDED.mention_count, engagement = EXCLUDED.engagement, views = EXCLUDED.views, "
                "ad_spend = EXCLUDED.ad_spend, sentiment_score = EXCLUDED.sentiment_score, processed_at = now()"
            ),
            {"d": biz_date, "p": platform, "m": mentions, "e": engagement, "v": views, "s": ad_spend, "sent": avg_sentiment},
        )
