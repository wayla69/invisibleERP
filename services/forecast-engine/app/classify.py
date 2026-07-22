"""Syntetos–Boylan series classification → model routing (docs/54 §1.1).

ADI (average inter-demand interval) and CV² (squared coefficient of variation of the non-zero
demand sizes) partition series into smooth / erratic / intermittent / lumpy; the 1.32 / 0.49
cutoffs are the standard S-B boundaries. Histories under 8 weeks (or with almost no demand days)
route to the day-of-week baseline regardless.
"""

from __future__ import annotations

ADI_CUTOFF = 1.32
CV2_CUTOFF = 0.49
MIN_DAYS = 56  # < 8 weeks of history → 'short'
MIN_NONZERO = 8


def classify(values: list[float]) -> str:
    nz = [v for v in values if v > 0]
    if len(values) < MIN_DAYS or len(nz) < MIN_NONZERO:
        return "short"
    adi = len(values) / len(nz)
    mean = sum(nz) / len(nz)
    var = sum((v - mean) ** 2 for v in nz) / len(nz)
    cv2 = (var / (mean * mean)) if mean > 0 else 0.0
    if adi <= ADI_CUTOFF:
        return "smooth" if cv2 <= CV2_CUTOFF else "erratic"
    return "intermittent" if cv2 <= CV2_CUTOFF else "lumpy"


def route(cls: str) -> str:
    """Map a series class to the model that produces its sample paths."""
    return {
        "smooth": "prophet",
        "erratic": "prophet",  # wider intervals fall out of the posterior naturally
        "intermittent": "croston_sba",
        "lumpy": "bootstrap",
        "short": "baseline_dow",
    }[cls]
