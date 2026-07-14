"""TOWS strategy analyzer.

Maps INTERNAL factors (from the MMM + RFM outputs — what we're good/bad at) against EXTERNAL factors (from
social sentiment trends — the market's opportunities/threats) into the four TOWS quadrants with concrete,
prioritized recommendations:

* SO (maxi-maxi) — use strengths to seize opportunities
* ST (maxi-mini) — use strengths to counter threats
* WO (mini-maxi) — fix weaknesses to capture opportunities
* WT (mini-mini) — reduce weaknesses to avoid threats

Pure, deterministic rules over the model outputs; returns a DataFrame ready for ``analytics.tows_matrix``.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import List

import pandas as pd

logger = logging.getLogger(__name__)


@dataclass
class TowsFactor:
    kind: str          # strength | weakness | opportunity | threat
    label: str


class TowsAnalyzer:
    def __init__(self, roi_strong: float = 2.0, roi_weak: float = 1.0, sentiment_pos: float = 0.2, sentiment_neg: float = -0.1) -> None:
        self.roi_strong = roi_strong
        self.roi_weak = roi_weak
        self.sentiment_pos = sentiment_pos
        self.sentiment_neg = sentiment_neg

    # ── factor extraction ────────────────────────────────────────────────────────────────────────
    def _internal_factors(self, mmm: pd.DataFrame, rfm: pd.DataFrame) -> tuple[List[TowsFactor], List[TowsFactor]]:
        strengths: List[TowsFactor] = []
        weaknesses: List[TowsFactor] = []

        if mmm is not None and not mmm.empty:
            for _, row in mmm.iterrows():
                roi = row.get("roi")
                if roi is None or pd.isna(roi):
                    continue
                if roi >= self.roi_strong:
                    strengths.append(TowsFactor("strength", f"High-ROI channel '{row['channel']}' (ROI {roi:.2f}, {row.get('contribution_pct', 0):.0f}% of sales)"))
                elif roi < self.roi_weak:
                    weaknesses.append(TowsFactor("weakness", f"Under-performing channel '{row['channel']}' (ROI {roi:.2f}) — spend not returning"))

        if rfm is not None and not rfm.empty and "segment" in rfm.columns:
            counts = rfm["segment"].value_counts()
            loyal = int(counts.get("Loyal Promoters", 0) + counts.get("Steady Loyal", 0))
            at_risk = int(counts.get("At Risk VIPs", 0))
            churn = int(counts.get("Churn Risk", 0))
            total = int(len(rfm))
            if total and loyal / total >= 0.25:
                strengths.append(TowsFactor("strength", f"Strong loyal base ({loyal}/{total} customers are Loyal/Steady)"))
            if at_risk:
                weaknesses.append(TowsFactor("weakness", f"{at_risk} At-Risk VIP(s) — high value, lapsing or unhappy"))
            if total and churn / total >= 0.25:
                weaknesses.append(TowsFactor("weakness", f"Elevated churn risk ({churn}/{total} customers)"))
        return strengths, weaknesses

    def _external_factors(self, sentiment: pd.DataFrame) -> tuple[List[TowsFactor], List[TowsFactor]]:
        opportunities: List[TowsFactor] = []
        threats: List[TowsFactor] = []
        if sentiment is None or sentiment.empty:
            return opportunities, threats
        # Expect columns: platform, avg_sentiment, engagement (or mention_count).
        vol_col = "engagement" if "engagement" in sentiment.columns else ("mention_count" if "mention_count" in sentiment.columns else None)
        for _, row in sentiment.iterrows():
            s = row.get("avg_sentiment", row.get("sentiment_score"))
            if s is None or pd.isna(s):
                continue
            vol = float(row.get(vol_col, 0)) if vol_col else 0.0
            platform = row.get("platform", "?")
            if s >= self.sentiment_pos:
                opportunities.append(TowsFactor("opportunity", f"Positive buzz on {platform} (sentiment {s:+.2f}, volume {vol:.0f})"))
            elif s <= self.sentiment_neg:
                threats.append(TowsFactor("threat", f"Negative sentiment on {platform} (sentiment {s:+.2f}) — reputation risk"))
        return opportunities, threats

    # ── TOWS matrix ──────────────────────────────────────────────────────────────────────────────
    def build(self, mmm: pd.DataFrame, rfm: pd.DataFrame, sentiment: pd.DataFrame) -> pd.DataFrame:
        strengths, weaknesses = self._internal_factors(mmm, rfm)
        opportunities, threats = self._external_factors(sentiment)

        rows: List[dict] = []

        def add(quadrant: str, factor: str, recommendation: str, priority: int) -> None:
            rows.append({"quadrant": quadrant, "factor": factor, "recommendation": recommendation, "priority": priority})

        # SO — strengths × opportunities: double down.
        for s in strengths:
            for o in opportunities:
                add("SO", f"{s.label} + {o.label}", "Scale the high-ROI channel into the trending positive topic while momentum lasts.", 1)
        # ST — strengths × threats: defend.
        for s in strengths:
            for t in threats:
                add("ST", f"{s.label} + {t.label}", "Use the strong channel to push proactive, positive messaging that counters the negative sentiment.", 2)
        # WO — weaknesses × opportunities: fix to capture.
        for w in weaknesses:
            for o in opportunities:
                add("WO", f"{w.label} + {o.label}", "Reallocate budget away from the weak channel toward the trending opportunity; re-test creative.", 2)
        # WT — weaknesses × threats: minimize exposure.
        for w in weaknesses:
            for t in threats:
                add("WT", f"{w.label} + {t.label}", "Pause spend on the weak channel and run service recovery / win-back before the threat compounds.", 1)

        if not rows:
            add("WT", "Insufficient signal", "Not enough MMM/RFM/sentiment signal yet — keep ingesting and re-run.", 3)
        df = pd.DataFrame(rows)
        logger.info("TOWS: %d recommendation(s) across %s", len(df), df["quadrant"].value_counts().to_dict())
        return df
