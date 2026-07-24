# 40 — Project Cost Benchmark: What This System Would Cost Built by a Human Team

**Status:** Reference / benchmark (no product impact)
**Audience:** Management, investors, auditors
**Date:** 2026-07-09

## 1. Purpose

This document estimates what it would cost to build Invisible ERP from scratch with a
conventional human software team. It is a benchmark for build-vs-buy discussions, investor
material, and internal capitalization analysis. It does not change any application behavior.

## 2. What was measured (repository census, 2026-07-09)

All figures below are measured directly from this repository, not estimated.

| Metric | Count |
|---|---|
| TypeScript source | ~175,000 lines (API ~80k, web ~62k, shared/tools remainder) |
| Test / control harnesses | ~25,000 lines (119 cutover scripts + parity/golden-master suites) |
| SQL migrations | 291 files, ~13,000 lines |
| Backend modules | 126 (GL, AR/AP, procurement, POS, restaurant, WMS, MRP/APS, projects/EVM, HCM/payroll, IFRS-16 leases, e-invoice, CRM, BI, …) |
| API endpoints | ~1,527 |
| Web pages / routes | 208 |
| Database tables | ~441 (multi-tenant, row-level security) |
| Documentation | 144 files, ~490,000 words (32 process narratives, 19 user-manual guides, 15 UAT packs) |
| Compliance artifacts | 187-control SOX/ICFR RCM, COSO readiness plan, ISO 27001 / SOC 2 gap analyses, policies (~65,000 words) |

Scope characterization: a full multi-tenant ERP with financial controls (maker-checker,
SoD, RLS tenant isolation), Thai localization, POS + restaurant operations, manufacturing
(MRP/RCCP/APS), project management with EVM, HCM/payroll, IFRS-16 lease accounting, and
an ISO-style documentation set (process narratives, control matrix, UAT packs) built
toward the audit-readiness roadmap in `compliance/` — i.e., enterprise software at the
expensive end of the complexity spectrum.

## 3. Effort estimate — three independent methods

1. **COCOMO II (parametric).** 175 KSLOC of enterprise software at nominal cost drivers
   → ~850–900 person-months ≈ **~70 person-years**.
2. **Productivity benchmark.** Enterprise teams deliver ~10–20 fully-loaded
   lines/person/day (design, review, test, rework, meetings included). ~188k LOC ÷ 15/day
   → ~12,500 person-days ≈ **~55 person-years** (range 40–85).
3. **Function-point sizing.** 441 tables + 1,527 endpoints + 208 screens ≈ 8,000–9,500
   function points; at the enterprise norm of 10–18 hours/FP → **45–85 person-years**.

Documentation and compliance are additional: ~550,000 words of narratives, manuals, UAT,
and SOX/ISO material is **3–5 person-years** of technical-writer and compliance-analyst
effort, normally supplemented by external SOX-readiness consultants.

**Triangulated total: ~55–75 person-years** (central estimate ~60), deliverable in
**~2.5–3 years by a team of 25–30**: product manager, 1–2 architects, 14–18 engineers,
3–4 QA, DevOps, UX, 2 technical writers, and a compliance analyst. ERP builds rarely
compress below ~2 years regardless of headcount — coordination costs dominate.

## 4. Cost scenarios

| Scenario | Blended fully-loaded cost / person-year | Total |
|---|---|---|
| Thailand-based in-house team | ~1.4–1.8M THB (~US$40–50k) | **~85–130M THB (US$2.4–3.6M)** |
| Mixed Thai + senior international leads | ~US$80–110k | **US$4.5–8M** |
| US/Western in-house team | ~US$180–230k | **US$10–16M** |
| Big-4 / SI vendor build | 1.5–2× in-house rates | **US$15–30M+** |

Add **US$300k–1M** for external SOX/ICFR readiness and ISO 27001 / SOC 2 consulting that
a NASDAQ-bound company purchases regardless of who writes the code.

For comparison, licensing plus implementation of a comparable commercial ERP
(SAP S/4HANA, Oracle NetSuite with heavy customization) for a multi-entity company
typically runs US$2–10M upfront plus ongoing license fees — a custom build of this scope
is the same order of magnitude as buying, with the difference that the company owns the
asset outright.

## 5. Bottom line

Built from scratch by real humans, this system represents **~60 person-years of
engineering effort**, equivalent to:

- **~100M THB (≈ US$2.5–3.5M)** with a competent Thailand-based team over ~3 years, or
- **~US$12M** with a US-based team, or
- **US$20M+** commissioned from a major systems-integration vendor.

## 6. Method caveats

- The repository clone used for the census is shallow, so sizing is from the code itself,
  not observed velocity.
- Parametric models (COCOMO, FP) assume human coordination overhead; the ±40% spread
  across the three methods is normal for this class of estimate.
- Figures are fully-loaded (salary + benefits + overhead + tooling), 2026 market rates.

## Revision history

| Date | Version | Change |
|---|---|---|
| 2026-07-09 | 1.0 | Initial benchmark: repository census, three-method effort estimate, cost scenarios. |
