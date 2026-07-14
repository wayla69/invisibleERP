"""Marketing Intelligence — Streamlit dashboard (overview).

Read-only view of the ``analytics`` schema (MMM channel ROI, RFM segments, sentiment). Business logic and
DB queries stay in the shared layer / analytics engine; this file only presents. DB reads are cached; all
dynamic text is rendered through Streamlit's text APIs (never raw HTML) to avoid injection.
"""
from __future__ import annotations

import os
import sys

import pandas as pd
import streamlit as st

# make the shared package importable in both the repo and the container layout
_here = os.path.dirname(os.path.abspath(__file__))
for _ in range(6):
    if os.path.isdir(os.path.join(_here, "shared")):
        if _here not in sys.path:
            sys.path.insert(0, _here)
        break
    _here = os.path.dirname(_here)

from shared import fetch_df  # noqa: E402

st.set_page_config(page_title="Marketing Intelligence", page_icon="📊", layout="wide")


@st.cache_data(ttl=300)
def load_latest_mmm() -> pd.DataFrame:
    return fetch_df(
        "SELECT r.channel, r.beta, r.spend, r.attributed_revenue, r.contribution_pct, r.roi "
        "FROM analytics.mmm_results r "
        "JOIN (SELECT MAX(run_id) AS run_id FROM analytics.mmm_runs) latest ON r.run_id = latest.run_id "
        "ORDER BY r.contribution_pct DESC"
    )


@st.cache_data(ttl=300)
def load_mmm_run() -> pd.DataFrame:
    return fetch_df("SELECT run_id, window_from, window_to, r2, total_spend, created_at FROM analytics.mmm_runs ORDER BY run_id DESC LIMIT 1")


@st.cache_data(ttl=300)
def load_rfm() -> pd.DataFrame:
    return fetch_df("SELECT segment, COUNT(*) AS customers, SUM(monetary) AS monetary FROM analytics.customer_rfm_segments GROUP BY segment ORDER BY customers DESC")


@st.cache_data(ttl=300)
def load_sentiment() -> pd.DataFrame:
    return fetch_df(
        "SELECT biz_date, platform, sentiment_score FROM core.social_sentiment_trends "
        "WHERE biz_date >= (CURRENT_DATE - INTERVAL '60 days') ORDER BY biz_date"
    )


st.title("📊 Marketing Intelligence")
st.caption("Advanced MMM · Sentiment-Weighted RFM · TOWS — fed from the ERP via API + social listening.")

try:
    run = load_mmm_run()
    mmm = load_latest_mmm()
    rfm = load_rfm()
    sentiment = load_sentiment()
except Exception as exc:  # surface DB/connection errors gracefully rather than a stack trace
    st.error(f"Could not load analytics data: {exc}")
    st.stop()

if run.empty or mmm.empty:
    st.warning("No model run yet. Start the ingestion worker and run the analytics engine, then refresh.")
    st.stop()

# ── KPI row ───────────────────────────────────────────────────────────────────────────────────────
r = run.iloc[0]
top = mmm.iloc[0]
c1, c2, c3, c4 = st.columns(4)
c1.metric("Model fit (R²)", f"{float(r['r2']):.2f}")
c2.metric("Total ad spend", f"฿{float(r['total_spend']):,.0f}")
c3.metric("Top channel", str(top["channel"]), f"ROI {float(top['roi'] or 0):.2f}")
c4.metric("Window", f"{r['window_from']} → {r['window_to']}")

st.divider()

# ── MMM: contribution + ROI ───────────────────────────────────────────────────────────────────────
left, right = st.columns(2)
with left:
    st.subheader("Channel contribution to sales (%)")
    st.bar_chart(mmm.set_index("channel")["contribution_pct"], color="#4C78A8")
with right:
    st.subheader("Return on ad spend (ROI)")
    st.bar_chart(mmm.set_index("channel")["roi"], color="#59A14F")

with st.expander("MMM detail (per channel)"):
    st.dataframe(
        mmm.assign(
            spend=mmm["spend"].map(lambda v: f"฿{v:,.0f}"),
            attributed_revenue=mmm["attributed_revenue"].map(lambda v: f"฿{v:,.0f}"),
        ),
        use_container_width=True,
        hide_index=True,
    )

st.divider()

# ── RFM + sentiment ─────────────────────────────────────────────────────────────────────────────
left2, right2 = st.columns(2)
with left2:
    st.subheader("Customer segments (Sentiment-Weighted RFM)")
    if rfm.empty:
        st.info("No RFM segments yet.")
    else:
        st.bar_chart(rfm.set_index("segment")["customers"], color="#E45756")
with right2:
    st.subheader("Social sentiment trend")
    if sentiment.empty:
        st.info("No sentiment data yet.")
    else:
        pivot = sentiment.pivot_table(index="biz_date", columns="platform", values="sentiment_score", aggfunc="mean")
        st.line_chart(pivot)

st.caption("Data refreshes every 5 minutes (cached). Use the pages in the sidebar for budget experiments and TOWS strategy.")
