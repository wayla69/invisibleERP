# docs/55 — SCM depth roadmap (toward planning-suite class)

**Status: DRAFT v0.1** · Owner: Supply-chain / Planning · Depends on docs/54 (delivered)

A phased plan to deepen the SCM planning capability built in **docs/54** (`services/forecast-engine` +
`modules/scm-planning`) along four tracks: **(A)** promotion & price-effect demand modeling,
**(B)** multi-echelon replenishment, **(C)** hierarchical forecast reconciliation, and **(D)** scale-out
retraining & accuracy operations.

## 0. Framing — what this is and is not

This is a path to move the planner **toward** the capability class of RELEX / SAP IBP / o9 / Blue Yonder,
**not** a parity target. Those are enterprise S&OP/IBP suites carrying web-signal demand sensing, full
demand→supply→finance loops, and years of catalog tuning — hundreds of engineer-years that are not a
schedulable backlog. Delivered in full, this roadmap lands a **strong mid-market planner** for the ERP's
restaurant/retail perishable buyer, which is the correct altitude for this product.

The docs/54 baseline is already real (not a mockup): probabilistic demand forecasting (Prophet /
Croston–SBA / bootstrap with quantiles + backtest WAPE), a perishable-aware order optimizer
(distribution-free newsvendor + remaining-life SAA MILP over FEFO stock), BoM explosion, spike detection,
maker-checker approval, tenant RLS, and an HMAC-signed stateless engine. Each track below **extends** that
spine — it does not replace it.

## 1. Baseline to build on (docs/54, delivered)

| Piece | Location |
|---|---|
| Forecast/optimize engine (FastAPI + Prophet + PuLP/CBC) | `services/forecast-engine/app/{forecasting,optimization,classify,service}.py` |
| Wire contract (zod ↔ pydantic, versioned) | `packages/shared/src/scm-engine.ts` ↔ `services/forecast-engine/app/contracts.py` |
| API module (extract → engine|fallback → persist → approve → PR handoff) | `apps/api/src/modules/scm-planning/*` |
| Controls / narrative / UAT | RCM **SCM-01..03**, **PN-34**, UAT cycle 18, `tools/cutover/src/scm.ts` |

## 2. Cross-cutting engineering rules (apply to every phase)

These are the repo gatekeeper rules, not restated per phase:

1. **Bounded context** — new responsibilities land in their own sub-module (e.g. `scm-network`), never
   appended to a facade; the `check-service-size` ratchet enforces it.
2. **Contract as the boundary** — any engine payload change bumps `SCM_ENGINE_CONTRACT_VERSION`; the zod
   and pydantic sides move together (the shared fixtures fail one side's CI on drift).
3. **Tenant isolation** — every new table carries the canonical 0232-form RLS loop + a leading
   `(tenant_id, …)` index; the `tenant-idx` gate enforces it.
4. **Tested core logic** — new forecasting/optimization math ships with pytest (engine) + `scm` harness
   (API) coverage, including a cross-tenant boundary check.
5. **Doc-sync** — each phase updates PN-34, the user manual, UAT cycle 18, and adds/edits its RCM control
   (regenerate the xlsx + census spans) in the same PR.

---

## 3. Track A — Promotion & price-effect demand modeling

*Goal: forecasts that respond to promotions and price, not just calendar seasonality.*

| Phase | Scope & key deliverables | New control | Size |
|---|---|---|---|
| **A1** | **Promo/price regressors.** Extract the known promo calendar + price (docs/52 pricing/promotions) and pass them as external regressors on `/v1/forecast` — contract gains per-series `regressors:[{ds, promo_flag, discount_pct, price}]`; Prophet adds them (generalizes the existing payday regressor), Croston/bootstrap paths get an uplift term. Plan surfaces promo attribution. | **SCM-04** (promo-forecast governance: promo inputs are auditable; a forecast cannot be silently inflated by fabricated promo flags) | S |
| **A2** | **Own-price elasticity.** Estimate log-log price↔demand elasticity per item from history; apply to future price scenarios; feeds the existing advisory scenario tool. | — | M |
| **A3** | **Cannibalization / halo.** Category-scoped substitution matrix (`item_categories`, not full cross-product) so promoting X adjusts its siblings. | — | L |
| **A4** | **Cold-start / new items.** Attribute-based analog ("like-item") forecasting for zero-history SKUs. | — | M |

---

## 4. Track B — Multi-echelon (supplier → DC → branch) replenishment

*Goal: plan across tiers with risk pooling, not per-branch in isolation. The largest lift.*

| Phase | Scope & key deliverables | New control | Size |
|---|---|---|---|
| **B1** | **Network master data.** New `scm-network` sub-module + tables `supply_nodes` (supplier / central-kitchen / DC / branch) and `supply_lanes` (per-lane lead-time, cost, MOQ). Topology as governed master data. | — | M |
| **B2** | **Two-echelon optimization.** DC pools branch risk (base-stock at DC + allocation down). New engine route `/v1/optimize-network` doing a guaranteed-service / stochastic-service MEIO approximation. Strictly 2 echelons to start. | **SCM-05** (MEIO plan approval) | XL |
| **B3** | **Allocation & fair-share.** On DC shortage, allocate to branches by service-level priority (proportional / fair-share), with an approval control on the allocation policy. | **SCM-06** (allocation fairness) | L |
| **B4** | **DRP roll-up.** Time-phased net requirements roll branch→DC→supplier and hand off to the **existing** procurement PR flow (reuse, do not rebuild). | — | L |

---

## 5. Track C — Hierarchical forecast reconciliation

*Goal: forecasts that sum coherently across item→category→total and branch→region→company.*

| Phase | Scope & key deliverables | New control | Size |
|---|---|---|---|
| **C1** | **Hierarchy definition.** Declare aggregation structures (leverages `item_categories` + the branch/org hierarchy already present). | — | S |
| **C2** | **Bottom-up / top-down.** The cheap coherence win: forecast at base + aggregate, or forecast at top + disaggregate by historical shares. Ship early — high value, low risk. | — | S |
| **C3** | **Optimal reconciliation (MinT).** Minimum-trace reconciliation (Hyndman et al.), a well-defined algorithm that fits the Python engine. `/v1/forecast` gains a hierarchy input + reconciled output. | — | M |
| **C4** | **Coherent probabilistic paths.** Reconcile the *sample paths* (not just point forecasts) so the downstream optimizer still receives coherent scenarios. | — | M |

---

## 6. Track D — Scale-out retraining & accuracy operations

*Goal: large catalogs stay responsive; retrain incrementally; monitor accuracy.*

| Phase | Scope & key deliverables | New control | Size |
|---|---|---|---|
| **D1** | **Scheduled batch retrain.** Move refit off the request path onto the existing BI-scheduler nightly job; persist forecasts; per-tenant fairness + backpressure (the engine already chunks at 200 series). | — | M |
| **D2** | **Warm-start / model registry.** Cache fitted Prophet params; skip refit for stable series, refit only on cadence or when WAPE degrades. | — | M |
| **D3** | **Horizontal scale.** Run the engine as N stateless replicas + a shared result cache and work queue (reuse the Redis `common/rate-limit-store.ts` L-8/L-12 pattern). | — | L |
| **D4** | **Accuracy monitoring.** Track WAPE/bias per item over time, drift alerts, champion/challenger — surfaced on the BI live SSE bus. | **SCM-07** (forecast-accuracy detective control) | M |

---

## 7. Sequencing (respecting dependencies)

| Wave | Ships | Rationale |
|---|---|---|
| 1 | **A1**, **C1 → C2** | Cheap, engine-only; promo regressors + coherent totals are immediately visible wins |
| 2 | **A2 / A3**, **B1** | Elasticity / cannibalization while network master data is modeled |
| 3 | **B2**, **D2** | The MEIO core; warm-start once catalogs/compute grow |
| 4 | **B3 / B4**, **C3 / C4** | Allocation + DRP handoff; optimal reconciliation |
| 5 | **D3 / D4**, **A4** | Scale-out + accuracy ops once volume demands it |

Each phase is ~1–3 doc-synced PRs; the whole program is multi-quarter. Track A and Track C are engine-only
and low-risk; Track B is the architectural lift (network master data + a new optimizer + procurement
integration); Track D becomes mandatory only as A/B/C raise compute.

## 8. New controls introduced (RCM)

| Control | Track/phase | Type | Assertion |
|---|---|---|---|
| **SCM-04** | A1 | Preventive | Promo/price forecast inputs are auditable; forecasts cannot be inflated by fabricated promo signals |
| **SCM-05** | B2 | Preventive | Multi-echelon (network) plans require maker-checker approval before PR handoff |
| **SCM-06** | B3 | Preventive | DC-shortage allocation follows the approved fair-share policy; overrides are logged and second-approved |
| **SCM-07** | D4 | Detective | Forecast accuracy (WAPE/bias) is monitored per item; sustained degradation raises an ops alert |

Each lands with its `build_rcm.py` `add(...)`, an xlsx regenerate, and the census-span bump across the
compliance/docs markdown (per the `check-rcm-census` gate).

## 9. Verification (per phase)

- **Engine:** `cd services/forecast-engine && pytest` (new math gets soundness properties, as in docs/54 §3.5).
- **Contract parity:** `pnpm --filter @ierp/api test:coverage` (scm-contract fixtures).
- **API/controls:** extend `tools/cutover/src/scm.ts` (positive + negative/control + cross-tenant).
- **Gates:** shared build → `pnpm -r typecheck` → `pnpm -r build` → api coverage → the CI ratchets.

## 10. Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-07-21 | Supply-chain / Planning | Initial roadmap: four depth tracks (promo/price, multi-echelon, hierarchical reconciliation, scale-out), phased with sequencing, new controls SCM-04..07, and per-phase doc-sync/verification obligations. Planning only — no code, contract, or control change yet. |
| 0.2 | 2026-07-22 | Supply-chain / Planning | **Implementation started (Wave 1).** **C1 delivered** — `scm_forecast_hierarchy` (migration 0461) + `ScmHierarchyService` + `/api/scm-planning/hierarchy` declare/forest, synthesizing from `branches`/`item_categories` when undefined (docs/58 §6). Engine-only/low-risk; no contract or control change. A1 (promo/price regressors, contract v2, SCM-04) and C2 (bottom-up/top-down reconciliation on the v2 contract) follow in the same wave. |
