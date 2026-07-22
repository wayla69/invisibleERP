"""TOWS strategy — opportunities & risks.

Renders ``analytics.tows_matrix`` (SO/ST/WO/WT) with prioritized recommendations derived from the MMM +
RFM (internal) and social sentiment (external). Read-only.
"""
from __future__ import annotations

import os
import sys

import pandas as pd
import streamlit as st

_here = os.path.dirname(os.path.abspath(__file__))
for _ in range(6):
    if os.path.isdir(os.path.join(_here, "shared")):
        if _here not in sys.path:
            sys.path.insert(0, _here)
        break
    _here = os.path.dirname(_here)

from shared import fetch_df  # noqa: E402

st.set_page_config(page_title="TOWS Strategy", page_icon="🧭", layout="wide")
st.title("🧭 TOWS Strategy Matrix")
st.caption("Internal strengths/weaknesses (MMM + RFM) × external opportunities/threats (social sentiment).")

QUADRANTS = {
    "SO": ("Strengths → Opportunities (maxi-maxi)", "Attack: scale what works into what's trending."),
    "ST": ("Strengths → Threats (maxi-mini)", "Defend: use strengths to blunt external threats."),
    "WO": ("Weaknesses → Opportunities (mini-maxi)", "Improve: fix gaps to capture openings."),
    "WT": ("Weaknesses → Threats (mini-mini)", "Protect: reduce exposure, avoid compounding harm."),
}


@st.cache_data(ttl=300)
def load_tows() -> pd.DataFrame:
    return fetch_df("SELECT quadrant, factor, recommendation, priority FROM analytics.tows_matrix ORDER BY priority ASC, quadrant ASC")


try:
    tows = load_tows()
except Exception as exc:
    if "does not exist" in str(exc).lower() or "undefinedtable" in str(exc).lower():
        st.warning("No TOWS analysis yet — start the ingestion worker, then run the analytics engine, and refresh.")
    else:
        st.error(f"Could not load TOWS data: {exc}")
    st.stop()

if tows.empty:
    st.warning("No TOWS analysis yet — run the analytics engine after ingesting sales + social data.")
    st.stop()

# Priority summary
p1 = int((tows["priority"] == 1).sum())
st.metric("High-priority actions", p1, help="Priority 1 = act now (SO opportunities to seize; WT risks to contain).")

# 2×2 grid
row1 = st.columns(2)
row2 = st.columns(2)
cells = {"SO": row1[0], "ST": row1[1], "WO": row2[0], "WT": row2[1]}
for q, cell in cells.items():
    with cell:
        title, blurb = QUADRANTS[q]
        st.subheader(title)
        st.caption(blurb)
        sub = tows[tows["quadrant"] == q]
        if sub.empty:
            st.info("No items.")
            continue
        for _, r in sub.iterrows():
            flag = "🔴" if int(r["priority"]) == 1 else ("🟠" if int(r["priority"]) == 2 else "🟡")
            with st.container(border=True):
                st.markdown(f"{flag} **{r['factor']}**")
                st.write(r["recommendation"])

with st.expander("All recommendations (table)"):
    st.dataframe(tows, use_container_width=True, hide_index=True)
