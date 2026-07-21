"""Budget experiment — a what-if simulator on the fitted MMM.

Reconstructs each channel's response curve from the persisted MMM params (beta + Hill saturation +
ref_scale) and lets a marketer reallocate daily spend to see predicted incremental revenue. Read-only;
no writes back to the ERP.
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

st.set_page_config(page_title="Budget Experiment", page_icon="🧪", layout="wide")
st.title("🧪 Budget Experiment")
st.caption("Reallocate spend and see the MMM's predicted incremental revenue (per-channel diminishing returns).")


def hill(x: float, alpha: float, gamma: float) -> float:
    x = max(x, 0.0)
    xa = x ** alpha
    return xa / (xa + gamma ** alpha) if (xa + gamma ** alpha) else 0.0


@st.cache_data(ttl=300)
def load_latest() -> tuple[pd.DataFrame, pd.DataFrame]:
    run = fetch_df("SELECT run_id, window_from, window_to FROM analytics.mmm_runs ORDER BY run_id DESC LIMIT 1")
    if run.empty:
        return run, run
    results = fetch_df(
        "SELECT channel, beta, spend, adstock_theta, saturation FROM analytics.mmm_results WHERE run_id = :rid",
        {"rid": int(run.iloc[0]["run_id"])},
    )
    return run, results


try:
    run, results = load_latest()
except Exception as exc:  # tables not created yet vs a real error
    if "does not exist" in str(exc).lower() or "undefinedtable" in str(exc).lower():
        st.warning("No model run yet — start the ingestion worker, then run the analytics engine, and refresh.")
    else:
        st.error(f"Could not load model data: {exc}")
    st.stop()
if run.empty or results.empty:
    st.warning("No model run yet — run the analytics engine first.")
    st.stop()

window_days = max((pd.to_datetime(run.iloc[0]["window_to"]) - pd.to_datetime(run.iloc[0]["window_from"])).days, 1)


def predict_daily(channel_row: pd.Series, daily_spend: float) -> float:
    """Predicted incremental revenue per day at a constant daily spend (steady-state adstock)."""
    sat = channel_row["saturation"] or {}
    ref = float(sat.get("ref_scale", 1.0)) or 1.0
    alpha = float(sat.get("alpha", 1.5))
    gamma = float(sat.get("gamma", 0.5))
    beta = float(channel_row["beta"])
    return beta * hill(daily_spend / ref, alpha, gamma)


st.subheader("Set daily spend per channel")
st.write(f"Baseline = the fitted window's average daily spend ({window_days} days).")

new_daily: dict[str, float] = {}
cols = st.columns(len(results))
for i, (_, row) in enumerate(results.iterrows()):
    base_daily = float(row["spend"]) / window_days
    with cols[i]:
        new_daily[row["channel"]] = st.slider(
            f"{row['channel']} (฿/day)",
            min_value=0.0,
            max_value=round(base_daily * 3 + 1, 0),
            value=round(base_daily, 0),
            step=max(round(base_daily / 20, 0), 1.0),
        )

# Baseline vs proposed predicted revenue.
rows = []
for _, row in results.iterrows():
    ch = row["channel"]
    base_daily = float(row["spend"]) / window_days
    base_rev = predict_daily(row, base_daily) * window_days
    new_rev = predict_daily(row, new_daily[ch]) * window_days
    rows.append({
        "channel": ch,
        "baseline_daily": round(base_daily, 0),
        "proposed_daily": round(new_daily[ch], 0),
        "baseline_revenue": round(base_rev, 0),
        "proposed_revenue": round(new_rev, 0),
        "delta_revenue": round(new_rev - base_rev, 0),
        "proposed_roi": round(new_rev / (new_daily[ch] * window_days), 3) if new_daily[ch] > 0 else None,
    })
sim = pd.DataFrame(rows)

st.divider()
total_base_spend = sum(float(r["spend"]) for _, r in results.iterrows())
total_new_spend = sum(new_daily[c] * window_days for c in new_daily)
total_base_rev = sim["baseline_revenue"].sum()
total_new_rev = sim["proposed_revenue"].sum()

k1, k2, k3 = st.columns(3)
k1.metric("Total spend", f"฿{total_new_spend:,.0f}", f"{total_new_spend - total_base_spend:+,.0f}")
k2.metric("Predicted incremental revenue", f"฿{total_new_rev:,.0f}", f"{total_new_rev - total_base_rev:+,.0f}")
k3.metric("Blended ROI", f"{(total_new_rev / total_new_spend):.2f}" if total_new_spend else "–")

st.bar_chart(sim.set_index("channel")[["baseline_revenue", "proposed_revenue"]])
st.dataframe(
    sim.assign(
        baseline_revenue=sim["baseline_revenue"].map(lambda v: f"฿{v:,.0f}"),
        proposed_revenue=sim["proposed_revenue"].map(lambda v: f"฿{v:,.0f}"),
        delta_revenue=sim["delta_revenue"].map(lambda v: f"฿{v:,.0f}"),
    ),
    use_container_width=True,
    hide_index=True,
)
st.caption("Diminishing returns mean doubling a channel's spend less-than-doubles its revenue — the model captures this via Hill saturation.")
