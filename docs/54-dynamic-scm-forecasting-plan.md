# 54 · Dynamic Supply Chain & Demand Forecasting

**Status: DRAFT v0.1 · 2026-07-21** · Owner: Supply-chain / Planning · Related: PN-34 (pending),
docs/19–23 (PPM), docs/46 (module boundaries), docs/45 (demand-ML)

RELEX/Kinaxis-class **per-(branch, item) probabilistic demand forecasting** and **perishable-aware
order optimization** for the 33-branch restaurant chain. The TypeScript ERP stays the system of
record and orchestrator; the OR/ML compute runs in a dedicated **Python microservice**
(`services/forecast-engine`: FastAPI + Prophet + PuLP), because Node has no mature equivalent of
Prophet's posterior sampling or CBC's mixed-integer solver.

---

## 1. Why this, and what it is NOT

This module **extends** an existing spine — it does not replace it. An audit of the codebase before
design found substantial capability already shipped:

| Already shipped — extend/consume, do not rebuild | Where |
|---|---|
| Multi-model demand forecaster (SMA/SES/Holt/seasonal-naive/Croston/Croston-SBA/DOW/th-holiday/weather) with walk-forward WAPE/MASE champion selection | `modules/demand-ml/` |
| Branch min-max replenishment, transfer-before-buy, par recommendations, `autoPr()` | `modules/wms/replenishment.service.ts` |
| MRP explosion + plan-to-PR; EOQ fields on `items` | `modules/mfg-depth/mrp.service.ts` |
| FEFO lot layers carrying `expiryDate` / `remainingQty` | `inv_cost_layers`, `lot_ledger`, `bin_stock` |
| Spoilage ground truth with reason codes and cost | `waste_log`, `usageVariance()` |
| SMA stockout predictor — **sha256 parity-pinned, do not touch** | `modules/analytics/forecasting.service.ts` |

**What is genuinely new**, and therefore the whole scope of this program:

1. **Per-(branch, item) grain** — the existing forecaster is tenant-wide; a 33-branch chain cannot
   order per outlet from a chain-level number.
2. **Probabilistic forecasts** — sample paths and quantiles, not point estimates. Ordering decisions
   are asymmetric-cost decisions under uncertainty; a point forecast cannot express them.
3. **Shelf-life-aware order sizing** — the expiry data exists and nothing plans with it.
4. **Scenario what-ifs** — "what if Songkran doubles demand at BKK01?"
5. **Spike-triggered replanning** — event-driven, not only nightly.

---

## 2. Architecture decisions

1. **The engine is stateless pure-compute — no database access from Python.** All tenant data
   extraction happens in the API under RLS; the engine receives a self-contained payload and returns
   results. Tenant-isolation enforcement stays in exactly one place, no PII ever leaves the API
   (payloads are item codes and quantities), and the engine scales horizontally and tests trivially.
2. **Contract-first, TypeScript is the source of truth.** `packages/shared/src/scm-engine.ts` (zod)
   defines the wire format; `services/forecast-engine/app/contracts.py` (pydantic) mirrors it; shared
   JSON fixtures are parsed by **both** vitest and pytest, so drift fails one side's CI.
3. **Opt-in with graceful degradation.** `SCM_ENGINE_URL` + `SCM_ENGINE_SECRET` unset ⇒ the API never
   calls out and runs an in-process fallback planner. This mirrors the `DEMAND_WEATHER_ENABLED`
   precedent and keeps the audit posture: every engine output persists with its rationale (model,
   WAPE, solver status, binding constraints).
4. **Jobs ride existing rails** — the `background_jobs` queue and the BI report scheduler. Spike
   detection is a **scheduled micro-batch, never an inline hook** in `createSale`/`buildSale`: those
   are golden-master-pinned money paths that must not gain latency or a new failure mode.
5. **Plans are maker-checker'd recommendations.** The optimizer proposes; a human with `scm_approve`
   (≠ the maker) disposes; execution hands off to procurement via `ProcurementService.createPr`.
   This module posts **no GL entries** of its own.
6. **Inter-service auth: HMAC-SHA256 over `${unixSeconds}.${rawBody}`**, 300 s freshness window —
   the same convention as inbound webhooks (`common/webhook-auth.ts`).

---

## 3. The mathematics

### 3.1 Model routing (Syntetos–Boylan)

Restaurant demand is heterogeneous, so one model cannot fit all series. Per series the engine
computes **ADI** (average inter-demand interval) and **CV²** (squared coefficient of variation of
non-zero demand sizes):

| Class | Condition | Model |
|---|---|---|
| Smooth | ADI ≤ 1.32, CV² ≤ 0.49 | Prophet |
| Erratic | ADI ≤ 1.32, CV² > 0.49 | Prophet (wider posterior) |
| Intermittent | ADI > 1.32, CV² ≤ 0.49 | Croston–SBA |
| Lumpy | ADI > 1.32, CV² > 0.49 | Empirical bootstrap |
| Short (< 8 weeks) | — | Day-of-week baseline |

Every model emits the same artifact: **K demand sample paths**.

### 3.2 Prophet configuration

Multiplicative seasonality, weekly always on, yearly only with ≥ 52 weeks of history,
`changepoint_prior_scale ≈ 0.05`. **Holidays are data, shipped in the payload** (the API owns the
Thai calendar — national fixed and lunar dates, Songkran with `upper_window = 2`, plus tenant promo
events), so the engine stays dumb. A **payday regressor** captures the Thai pay cycle (1st–2nd,
15th–17th, month-end). **Closed days and stockout-censored days are excluded from the fit** — a
stockout is a supply cap, not observed demand, and learning phantom zeros suppresses future orders.
Uncertainty comes from `predictive_samples()`; a rolling-origin holdout reports WAPE per series.

### 3.3 Menu → ingredient explosion: sum paths, never quantiles

Signal (seasonality, holidays) lives at menu level; ordering happens at ingredient level. The API
explodes per scenario ω:

`D_ingredient[ω][t] = Σ_menu bom_gross[ingredient, menu] × D_menu[ω][t]`

with `bom_gross = qtyPer / (yieldFactor − wasteFactor) / yieldQty`. **Quantiles are not additive**
(P95 of a sum ≠ sum of P95s); summing per path preserves the correlation that makes a big Songkran
day lift every dish at once. The contract is path-shaped specifically to make the common DIY error
impossible to express.

### 3.4 Dynamic safety stock — distribution-free newsvendor

Protection-period demand per scenario `D_P[ω] = Σ_{t ≤ L[ω]+R} d[ω][t]`, with lead time L drawn per
scenario from Gamma(μ_L, σ_L). With underage cost `Cu = margin + goodwill` and overage cost
`Co = cost − salvage + disposal`:

- **critical ratio** `CR = Cu / (Cu + Co)`
- **order-up-to** `S* = empirical CR-quantile of {D_P[ω]}`
- **dynamic safety stock** `SS = S* − mean(D_P)`, recomputed daily from fresh paths

The textbook `z_α·√(L·σ_d² + d̄²·σ_L²)` is retained only as a cross-check: restaurant demand is
right-skewed, so the normal approximation understates the tail. (Empirically the CR quantile can sit
**below** the mean, giving a negative safety stock — a correct answer the normal form cannot produce.)

### 3.5 Perishable MILP (PuLP/CBC) — SAA over remaining life

When integrality or expiry binds, the engine solves a two-stage stochastic program by Sample Average
Approximation: first-stage order quantities are shared across all scenarios; sales, waste and
shortage are per-scenario recourse. Inventory is indexed by **remaining life r**, which maps 1:1
onto the FEFO `inv_cost_layers` the ERP already keeps.

```
Arrivals:   avail[ω,t,S] = x[t−L[ω]] + T[t]        (T = known in-transit)
Aging:      avail[ω,t,r] = I[ω,t−1,r+1]            (r = 1..S−1)
Balance:    I[ω,t,r] = avail[ω,t,r] − s[ω,t,r]
Expiry:     w[ω,t] = I[ω,t,1]                      (last sellable day's leftovers die overnight)
Demand:     Σ_r s[ω,t,r] + u[ω,t] = d[ω,t]
Ordering:   x_t = q·n_t ;  m·y_t ≤ x_t ≤ M·y_t     (pack q, MOQ m, indicator y)
Initial:    I[ω,0,r] = Σ FEFO layer qty with (expiry − today) = r
Joint:      Σ_i c_i·x[i,t] ≤ B  ·  Σ_i I[i,ω,t] ≤ V
```

Objective — **expected profit**, which avoids the classic double-count of purchase cost inside both
`c·x` and the overage term:

```
max (1/K)·Σ_ω Σ_t [ p·Σ_r s − g·u − (dc−v)·w − h·Σ_{r≥2} I ] − Σ_t (c·x_t + F·y_t)
```

Two properties are asserted as tests rather than asserted in prose:
**(a)** in the single-period unconstrained limit the MILP optimum converges to the §3.4 newsvendor
quantile; **(b)** FEFO needs no explicit constraints — with positive holding and net disposal cost,
oldest-first weakly dominates, so LP optima are FEFO-consistent, and a greedy-FEFO replay of the
MILP's own schedule reproduces its objective exactly.

**Tiering.** Closed-form newsvendor when neither shelf life nor integrality binds (milliseconds);
MILP otherwise; one joint MILP across items when a shared budget or storage cap is present. Both
tiers report expected fill rate / lost sales / waste / profit from the **same** FEFO simulator, so
they are directly comparable and the MILP has an independent oracle.

**Scale.** ~3k continuous vars + 2H integers per item ⇒ CBC solves in well under a second;
33 branches × ~150 perishables ≈ 5k solves per night, minutes on a small worker pool.

### 3.6 Spike detection (API side)

Per (branch, item) daily state: West's numerically stable EWMA (`μ += λ·diff`,
`σ² = (1−λ)(σ² + λ·diff²)`) plus a one-sided CUSUM (`C = max(0, C + z − k)`, k ≈ 0.5, h ≈ 4). Fire on
`z ≥ h` or a CUSUM crossing, subject to a minimum-volume floor, a hard per-day unique key, and a
cooldown — one viral evening produces one event, not forty.

---

## 4. Phases

| Phase | Scope | Status |
|---|---|---|
| **P1** | Shared zod contract, Python engine (FastAPI + Prophet + PuLP), pytest suite + shared fixtures, `engine-tests` CI job, `.env.example`, this plan | **DELIVERED** (2026-07-21) |
| **P2** | API module `modules/scm-planning` — migration, extraction, engine client, jobs, plan lifecycle + maker-checker, PR handoff, `scm` harness; PN-34 + RCM SCM-01..03 + UAT | **DELIVERED** (2026-07-21) |
| **P3** | Planner workspace (`/demand` tabs: branch plans, order plans, scenario, spike feed), user manual, UAT screen cases | **DELIVERED** (2026-07-21) |
| **Ops** | Railway `forecast-engine` service + secret, `deploy_service` line | **DELIVERED (plumbing, 2026-07-21)** — `deploy_service forecast-engine` added to `deploy.yml` (best-effort) + `ops-provision-forecast-engine.yml` wires secret/URL in the right order. **One manual dashboard step remains**: create+configure the Railway service (see §6). |

### P1 delivered (this change)

- `packages/shared/src/scm-engine.ts` — the wire contract (forecast + optimize, request + response,
  error envelope, header names, `SCM_ENGINE_CONTRACT_VERSION`), barrel-exported.
- `services/forecast-engine/` — `app/{main,contracts,classify,forecasting,optimization,service}.py`,
  `pyproject.toml`, `Dockerfile`, `railway.json`, `README.md`. Deliberately **outside the pnpm
  workspace** (globs are `apps/* packages/* tools/*`), so `pnpm -r` never touches it.
- 53 pytest cases: HMAC boundary (unsigned / wrong secret / stale timestamp / tampered body /
  fail-closed when unconfigured), S-B classification, forecaster behaviour (closure zeroing,
  determinism, censored-day exclusion, DOW shape recovery, Croston intermittency, Prophet holiday
  uplift), and the optimizer soundness properties of §3.5.
- Contract parity: `apps/api/test/scm-contract.test.ts` (zod) and
  `tests/test_contract_fixtures.py` (pydantic) read the **same** fixture files.
- CI: new `engine-tests` job (setup-python 3.12 + `pip install -e .[dev]` + `pytest`).
  ⚠ **Not a required check until branch protection is updated** — see §6.

### P2 delivered (2026-07-21)

Migration **`0459_scm_planning`** (7 tenant tables + `items.shelf_life_days`, canonical 0232-form RLS
loop, tenant-leading indexes — note the number moved from 0458, taken by a concurrent PR);
`modules/scm-planning/` (14 files, largest 380 LOC) registered in `SupplyChainDomainModule`;
permissions `scm_plan` / `scm_approve` + SoD rule **R24**; `cutover:scm` harness (20 checks) in the
`scm-mfg` shard; PN-34, RCM SCM-01..03 (299→302 controls), UAT cycle 18.

**The load-bearing extraction rule** (verified against `DineInSaleService.buildSale`): dine-in lines —
including ฿0 buffet lines — are written into `cust_pos_items` at checkout, so demand extraction
**partitions by sales channel** (retail leg excludes `payment_method IN ('Dine-in','Split')`; the
restaurant leg reads `dine_in_order_items` directly) or every dine-in dish is counted twice. The
harness pins this end-to-end: 14 partitioned versus 18 naive. Dine-in orders carry no branch column,
so restaurant demand is attributed via `scm_settings.dine_in_branch_id`, and the untagged share is
reported on every run so the gap is visible rather than silent.

**Two defects the harness caught that review would not have:**

1. **The spike detector scored an observation against the baseline it had already been folded into**,
   so a 6× day computed z ≈ 2 instead of ≈ 28 and never fired — the classic EWMA control-chart error.
   An observation is now judged against the baseline as it stood *before* it arrived.
2. **A failed run's own error handling destroyed the diagnosis**: when the failure was a DB error the
   transaction was already aborted, so the "mark run Failed" UPDATE also failed and *its* error
   replaced the original. The original cause chain now always wins, and is recorded in full
   (drizzle 0.45 nests the pg SQLSTATE under `.cause`).

A third, subtler one: interpolating the business-timezone offset into a Drizzle `sql` fragment used
in both SELECT and GROUP BY emits *different* placeholders (`$1` vs `$4`), which Postgres does not
treat as the same expression (42803). The offset is now inlined as a validated integer literal.

---

## 5. Verification

- **Engine:** `cd services/forecast-engine && pip install -e ".[dev]" && pytest`
- **Contract parity (TS):** `pnpm --filter @ierp/api test:coverage` (includes `scm-contract.test.ts`)
- **Gates:** shared build → `pnpm -r typecheck` → `pnpm -r build` → api coverage → the five ratchets
- P1 touches no service, controller, migration or web file, so the service-size, use-client,
  ledger-boundary and maker-checker ratchets are unaffected by construction.

## 6. Operational notes

- **Branch protection:** `engine-tests` is a NEW top-level job, i.e. a new check name. It is not in
  the required set until the repo owner adds it — flag this at merge (adding a `cutover:` script
  inside an existing shard would not have needed it; a new job does).
- **Going live:** the `deploy_service forecast-engine` line is now in `deploy.yml` (best-effort — its
  failure never blocks the mandatory API rollout, since the APIs only call the engine once
  `SCM_ENGINE_URL`+`SCM_ENGINE_SECRET` are set), and `ops-provision-forecast-engine.yml` automates the
  secret + env-var wiring. The one remaining **manual** step is creating the Railway service, because a
  service's config-as-code path is a per-service setting the CLI cannot set (the two API services set
  theirs — `apps/api/railway.json` / `apps/web/railway.json` — the same way):
  1. **Railway dashboard →** New Service → from the GitHub repo → name it **exactly** `forecast-engine`
     (the internal host `forecast-engine.railway.internal` derives from the service name) → Settings →
     Root Directory `/` (repo root, same as invisibleERP) → Config-as-code path
     `services/forecast-engine/railway.json` (which selects the Dockerfile builder).
  2. **Run `ops-provision-forecast-engine.yml`** (Actions → manual dispatch). It generates
     `SCM_ENGINE_SECRET`, sets it on the engine, builds+deploys it and waits for `/healthz`, then wires
     `SCM_ENGINE_URL`+`SCM_ENGINE_SECRET` onto **both** API services and redeploys — in that order,
     because scm-run has no *runtime* fallback (a call to a down engine marks the run Failed), so the
     engine must be healthy before the APIs point at it.

  Until both steps are done the API runs the in-process fallback planner and never calls out — safe, but
  without full Prophet/MILP.
- **Engine trust boundary:** the API zod-validates and **clamps** engine output before persisting
  (qty ≥ 0, ≤ 2× max stock, flagged in `detail.clamped`) — a buggy or compromised engine must not be
  able to plant absurd quantities into a Draft plan that a hurried approver rubber-stamps.

## 7. Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-07-21 | Supply-chain / Planning | Initial plan. **Phase 1 DELIVERED**: shared contract, Python forecast-engine (Prophet + PuLP), pytest + shared contract fixtures, `engine-tests` CI job, `.env.example` SCM block. Phases 2–3 planned. |
| 0.3 | 2026-07-21 | Supply-chain / Planning | **Phase 3 DELIVERED**: planner workspace as four new tabs on the existing `/demand` page (branch plans with the p10–p90 band and the untagged-demand warning, order plans with line edit → submit → approve → convert, the advisory scenario tool, the spike feed), `scm.*` th/en catalog, nav perms extended. The components live under `components/scm/` **without** their own `'use client'` directive — they inherit the page's boundary, so the use-client ratchet stayed flat at 288. Doc-sync: user-manual chapter 21 with body walkthroughs per flow, FAQ error codes, UAT §7 screen cases (UAT-SCM-033..042). |
| 0.6 | 2026-07-21 | Supply-chain / Planning | **Engine boot-crash fix (port)**: the Railway service got no `PORT` (private-only), and `railway.json`'s `startCommand` bound `--port $PORT` — Railway passes that string un-shell-expanded, so uvicorn crashed at boot (`Invalid value for '--port': '$PORT'`) and `/healthz` never came up (provisioning aborted at the healthcheck, before wiring the APIs, so prod was never affected). The engine's internal address is a fixed `forecast-engine.railway.internal:8000` (hard-wired in `SCM_ENGINE_URL`), so `startCommand` now binds a fixed `--port 8000` and the provisioning workflow sets `PORT=8000`. Also set `MPLCONFIGDIR=/tmp/matplotlib` in the Dockerfile so prophet's transitive matplotlib import can't fail under the non-root user's read-only HOME at forecast time. |
| 0.5 | 2026-07-21 | Supply-chain / Planning | **Dockerfile build-context fix**: the Railway service uses Root Directory `/` (repo root, like invisibleERP) and railway.json's repo-root-relative `dockerfilePath`, so the Docker build context is the whole repo. The `COPY pyproject.toml`/`COPY app` lines were repo-root-relative-wrong (`"/pyproject.toml": not found` at build) and are now `COPY services/forecast-engine/pyproject.toml`/`… /app`. No behaviour change. |
| 0.4 | 2026-07-21 | Supply-chain / Planning | **Ops plumbing DELIVERED**: `deploy_service forecast-engine` added to `deploy.yml` (best-effort — deployed first, its failure downgraded to a warning so it can never block the API rollout); new `ops-provision-forecast-engine.yml` (manual dispatch, `production` env) generates `SCM_ENGINE_SECRET`, deploys the engine and waits for `/healthz`, then wires `SCM_ENGINE_URL`+`SCM_ENGINE_SECRET` onto both API services and redeploys — engine-first, because scm-run has no runtime fallback. §4 Ops row + §6 "Going live" rewritten with the one remaining manual dashboard step (create+configure the service). No app/API/control/behaviour change — narratives (PN-34), user manual, UAT, and RCM (SCM-01..03) are unaffected. |
| 0.2 | 2026-07-21 | Supply-chain / Planning | **Phase 2 DELIVERED**: `modules/scm-planning` (migration `0459` — renumbered from 0458, taken by a concurrent PR), channel-partitioned demand extraction, engine client, background jobs + spike detector, maker-checker plan lifecycle with the procurement PR hand-off, `cutover:scm` harness (20 checks). New controls **SCM-01/02/03** (RCM 299→302), SoD **R24**, permissions `scm_plan`/`scm_approve`. Doc-sync: PN-34, UAT cycle 18 (UAT-SCM-001..032) + traceability, RCM census bumped and xlsx/catalog regenerated. Phase 3 (planner workspace) planned. |
