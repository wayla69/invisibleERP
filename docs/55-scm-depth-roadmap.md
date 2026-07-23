# docs/55 — SCM depth roadmap (toward planning-suite class)

**Status: DRAFT v0.10 · 2026-07-23** · Owner: Supply-chain / Planning · Depends on docs/54 (delivered)

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
| 0.3 | 2026-07-22 | Supply-chain / Planning | **A1 delivered** (docs/56) — engine contract **v1→v2** (per-series promo/price `regressors` + `attribution`), Prophet `add_regressor` + `U_MAX`-capped Croston/bootstrap uplift, `ScmPromoExtractService` (server-derived from approved `promotions` under RLS), attribution persisted on `scm_demand_forecasts` (migration 0462), control **SCM-04** (RCM 302→303). Contract stays v2 for C2 (adds only reconciliation fields). C2 next in Wave 1. |
| 0.4 | 2026-07-22 | Supply-chain / Planning | **C2 delivered** (docs/58) — **Wave 1 complete**. Additive `reconciliation` input + `reconciled` output on the v2 contract; engine `reconcile.py` bottom_up + top_down_hist over the sample paths (coherent per scenario; MinT→BU until C3); `ScmRunService` sends a bottom-up forest and explodes the reconciled leaf paths with a coherence trust-boundary. No new control/migration. Next: **Wave 2** — A2 (own-price elasticity), A3 (cannibalization), B1 (network master data). |
| 0.10 | 2026-07-23 | Supply-chain / Planning | **D2 delivered — Wave 3 Track D warm-start / model registry** (docs/59): `scm_model_cache` (migration **0475**, canonical 0232-form RLS + leading `(tenant_id, branch_id, item_id)` index + `coalesce(branch_id,0)` unique) caches each series' serialized Prophet fit; `ScmModelCacheService` ships the cached fit as an **optional** `warm_start:{params, fit_hash}` on `/v1/forecast` and persists the returned optional `fitted_state`, so a run whose training window is unchanged reuses the fit (skips BOTH the primary fit and the backtest refit) and only samples — the compute win. Contract is **additive — NO version bump** (still v2; both fields optional so a rolling deploy degrades to cold-fit, never hard-breaks — mirrors B2a's additive route). Two fail-safe staleness guards: `fit_hash` mismatch (training window changed) and `refit_cadence_days` age (new additive `scm_settings` column, default 14, range 1–90); a warm hit carries `fit_wape` forward. Determinism preserved (warm reuse ≡ cold fit byte-for-byte); corrupt cache fails closed to a refit. **No new control** (SCM-07 is D4). `scm` harness **57/57** (+4 D2, `scm-mfg` shard); engine pytest reproducibility / refit-on-window-change / corrupt-cache. PN-34 §7.16, manual ch.21, UAT §15 (UAT-SCM-061..063). **D1/D3/D4 remain planned.** |
| 0.9 | 2026-07-23 | Supply-chain / Planning | **B2b delivered — Wave 3 Track B two-echelon planning + SCM-05** (docs/57): the API half of B2 wires `modules/scm-network`'s plan lifecycle — `POST /api/scm-network/plans/run {item_code}` builds a two-echelon plan (GSM base-stock + risk pooling via the B2a `/v1/optimize-network` route, or an in-process fallback `B=μ·(L+R)+z·σ·√(L+R)`, DC=Σ, no pooling; demand paths via scm-planning's public `demandPathsFor` seam; every engine quantity zod-validated + clamped), persisted to `scm_network_plans`/`scm_network_plan_lines` (migration 0474, canonical RLS + tenant-leading index) as **Draft**. New control **SCM-05** — network-plan maker-checker: submit (`scm_plan`) → approve by a DIFFERENT `scm_approve` holder (self-approval `403 SOD_SELF_APPROVAL`, maker bound to submitter; **SoD R24 reused, no new rule**) → convert rolls the DC order up to a PR via the existing `ProcurementService.createPr` seam (reason `SCM-NET`, idempotent by `pr_no`). No GL, no golden-master path. `scm` harness +8 B2 checks (`scm-mfg` shard); PN-34 §7.15, manual ch.21 §2, UAT §14 (UAT-SCM-057..060). **B3 next** — allocation & fair-share (SCM-06, SoD R25). |
| 0.8 | 2026-07-23 | Supply-chain / Planning | **Wave 3 started — B2a delivered** (docs/57): the engine-only half of the two-echelon MEIO lift. New stateless **`/v1/optimize-network`** forecast-engine route (`network.py`) — guaranteed-service base-stock + risk pooling (`σ_DC=√(Σσ²+2Σρσσ)`), a 1-D service-time search over the DC's outbound commitment, per-node orders/`expected` reusing the docs/54 optimizer (single-branch ⇒ single-tier), and a tested fair-share `allocate()` primitive. Contract is **additive — no version bump** (still v2): network request/response schemas + shared fixture parsed by vitest AND pytest. Engine pytest 87 (14 network soundness), TS contract 14, typecheck clean. **B2b next** wires the API (`ScmNetworkExtractService`/`ScmNetworkRunService`, plan persistence + maker-checker, **control SCM-05**, `scm` harness, PN-34/manual/UAT/RCM). No GL, no golden-master path. |
| 0.7 | 2026-07-22 | Supply-chain / Planning | **A3 delivered — Wave 2 complete** (docs/56). Category-scoped cannibalization/halo cross-price elasticity: `ScmCrossElasticityService` estimates γ_{a,b} API-side by log-log OLS with the A2 identifiability floor, scoped to `item_categories` siblings only; a run persists credible pairs to `scm_cross_elasticity` (migration 0470); the scenario what-if composes own ε + Σ sibling γ. No contract change, no new control. apps/api vitest +7, `scm` harness +3. **Wave 2 (B1 · A2 · A3) done; Wave 3 next — B2 MEIO (SCM-05), D2 warm-start.** |
| 0.6 | 2026-07-22 | Supply-chain / Planning | **A2 delivered** (docs/56) — own-price elasticity. Governed effective-price signal (base × (1−discount)) from `ScmPromoExtractService`; engine OLS log-log ε estimator with an identifiability floor (ε=null when not identified) reported in attribution; `scm_price_elasticity` (migration 0464) + `ScmElasticityService` persist/serve it; the advisory scenario tool applies `demand × (price)^ε` via a new `price_multiplier`. No contract-version change (v2 attribution fields pre-existed), no new control. Engine pytest +7, `scm` harness +4. A3 (cannibalization) is the last Wave 2 phase. |
| 0.5 | 2026-07-22 | Supply-chain / Planning | **Wave 2 started — B1 delivered** (docs/57). New `modules/scm-network` bounded context + governed `supply_nodes`/`supply_lanes` (migration 0463, canonical RLS + tenant-leading index) via `POST /api/scm-network/nodes\|lanes`, and `GET /api/scm-network/topology` assembling + validating the two-echelon DAG (kind↔echelon, ≤2 stocking echelons, single-sourcing, acyclic, branch reachability). Definition only — no engine/contract change (the `/v1/optimize-network` route + optimizer land with B2), no control (SCM-05/06 arrive with B2/B3), no GL. Web `/network` master screen. ToE `cutover/scm.ts` +8. A2 (own-price elasticity) + A3 (cannibalization) follow in Wave 2. |
