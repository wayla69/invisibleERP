# 59 · SCM Track D — Scale-out retraining & accuracy operations

**Status: DRAFT v0.2 · 2026-07-23** · Owner: Supply-chain / Planning · Depends on **docs/54**
(delivered — `services/forecast-engine` + `modules/scm-planning`) · Implements **docs/55 §6** (Track D,
phases D1–D4) and its cross-cutting rules (§2) · Related: docs/46 (module/report-registry boundaries),
`common/rate-limit-store.ts` (L-8/L-12 shared-backend pattern)

Track D makes the docs/54 planner **stay responsive as catalogs and compute grow**, without changing
what a plan *means*. Nothing here alters the forecast maths, the newsvendor/MILP optimizer, the wire
contract, or the maker-checker plan lifecycle. It moves model fitting **off the request path**, teaches
the engine to **skip refit for stable series** (warm-start), lets the stateless engine run as **N
horizontally-scaled replicas** behind a shared cache/queue, and adds a **detective control that watches
forecast accuracy over time** and raises an ops alert on sustained degradation.

---

## 1. Problem & approach

The docs/54 engine is correct but **fit-bound**. Every `/v1/forecast` refits Prophet (cmdstan child
process) from scratch for every series, and the API drives it synchronously inside a run
(`ScmRunService.runWithEngine`, one branch at a time, chunked at 200 — `scm-engine-client.service.ts`
`DEFAULT_MAX_SERIES`). Four pressures appear as A/B/C (docs/55) raise the series count:

1. **Refit is on the critical path.** A 33-branch × ~150-perishable nightly run is minutes of solver +
   Prophet time today; multi-echelon (Track B) and reconciliation (Track C) multiply the series count.
   Refit belongs on a **schedule**, producing persisted forecasts a run *reads*, not recomputes.
2. **Stable series are refit needlessly.** Most items' seasonality is stable week-to-week; refitting a
   settled Prophet model nightly buys nothing. **Warm-start** — cache the fitted params, reuse them, and
   refit only on cadence or when accuracy degrades — is the single biggest compute win.
3. **The engine is stateless but single-node.** It scales horizontally *by design* (docs/54 §2.1, no DB,
   no PII), yet the result cache (`service.py` `ResultCache`) and the idempotency key are **in-process**,
   so N replicas neither share cache hits nor coordinate work. A shared Redis cache/queue — reusing the
   exact `common/rate-limit-store.ts` fail-open pattern — turns the fleet into one logical engine.
4. **Accuracy is measured but not monitored.** Each run persists per-series backtest WAPE
   (`scm_demand_forecasts.wape`, written by `ScmRunService.saveForecast`), but nothing tracks it **over
   time**. A model that quietly drifts (a recipe change, a new competitor, a demand regime shift) degrades
   orders silently. Track D turns the already-captured WAPE into a **time series with drift alerts**.

The approach throughout: **ride existing rails.** Batch retrain rides the BI report scheduler + the
`background_jobs` queue (exactly as `scm_nightly_plan` already does — `scm-bi-reports.ts`); warm-start and
accuracy history are **new tenant tables** under the canonical 0232-form RLS; horizontal scale reuses the
rate-limiter's Redis-or-in-memory shape; accuracy alerts ride the existing `ScmLiveService` SSE bus and a
new BI **report type in its owning module** (docs/46 Phase 1 — a `BiReportSource` provider, never a branch
in `bi-generate.service.ts`).

---

## 2. Design

### D1 — Scheduled batch retrain (Size M, planned)

*Move refit off the request path; persist forecasts a run consumes.*

- **New job type `scm_batch_retrain`**, registered in `ScmPlanJobsService.onModuleInit` alongside
  `scm_nightly_plan`/`scm_replan`, and exposed as an **action report** in `ScmBiReports.biReports()` so a
  tenant subscribes to it at a cadence and the BI scheduler's cross-tenant sweep enqueues it under the
  tenant's own context (no new scheduling machinery — the `scm_nightly_plan` precedent).
- The retrain job forecasts every planning-enabled series (reusing `ScmExtractService` + the existing
  `chunk(...)` at 200) and **persists the forecast paths/quantiles** keyed by `(tenant, branch, item,
  run)` — `scm_demand_forecasts` already stores exactly this. The nightly *plan* run then reads the freshest
  persisted forecast instead of re-forecasting: `runWithEngine` gains a "forecast source" that prefers a
  fresh `scm_demand_forecasts` row (within a staleness window, default 24 h) and only calls `/v1/forecast`
  for series with no fresh forecast. The optimizer step is unchanged.
- **Per-tenant fairness + backpressure.** The batch sweep enqueues one job per due tenant; the
  `background_jobs` worker already claims `FOR UPDATE SKIP LOCKED` with backoff + dead-letter, so no tenant
  can starve another by queue-jumping. A per-tenant in-flight guard (a partial unique index on
  `scm_plan_runs` for non-failed `scope='retrain'` runs per `run_date`, mirroring the nightly guard in
  `ScmRunService.executePlanRun`) makes a duplicate scheduler tick a no-op. Chunk-level concurrency stays
  bounded by `ENGINE_WORKERS`; the API never fans out more than one branch's chunks at a time.
- **Idempotency** already exists end-to-end: the engine caches under `X-Engine-Idempotency`
  (`main.py` `_handle`), and a retrain job that re-runs for the same `(tenant, run_date)` short-circuits on
  the run guard.

### D2 — Warm-start / model registry (Size M, **DELIVERED** 2026-07-23)

*Cache fitted Prophet params so stable series skip refit.* **Shipped** — the tenant-table option (a) below;
migration **0475**; contract change is **additive, no version bump** (see §3).

- **Where fitted state lives (shipped: option a).** A tenant table **`scm_model_cache`** stores the
  serialized Prophet fit (`fit_params` jsonb: `stan_init` params + changepoints + fit metadata) per
  `(tenant, branch, item)`, a `fit_hash` over the training window, `fitted_at`, `fit_wape`, `model` name,
  and the `training_from`/`training_to` window. Canonical **0232-form RLS loop** (excluding
  `audit_expectations`), a leading `(tenant_id, branch_id, item_id)` index, a `coalesce(branch_id, 0)`
  unique index, and a journaled migration — **`0475`**. `ScmModelCacheService` extracts the cached fit under
  RLS and **ships it in the forecast payload** so the engine stays stateless and DB-free (docs/54 §2.1).
  - *(Option b — object-storage keying for bulky serialized state — was not needed: the serialized fit
    carries in the payload comfortably.)*
- **Contract delta (shipped — additive, NO version bump).** `/v1/forecast` per-series input gains an
  **optional** `warm_start:{params, fit_hash}` and each result gains an **optional**
  `fitted_state:{params, fit_hash, fit_wape}`; the engine reuses the fit when the training window's hash
  matches, else cold-fits and returns fresh `fitted_state` for the API to persist. Because both fields are
  optional and an engine that ignores `warm_start` simply cold-fits, this is **additive with no
  `SCM_ENGINE_CONTRACT_VERSION` bump** (stays `'2'`) — mirroring B2a's additive network-route delta. A
  version bump was avoided deliberately: a strict version check would otherwise hard-break a rolling deploy
  (old API ↔ new engine, or vice versa) for a field that is optional on both sides, which contradicts the
  "no hard break" clause below. The zod and pydantic sides move together; the shared fixtures fail one
  side's CI on drift (docs/55 §2 rule 2).
- **Refit triggers (fail-safe toward refitting).** A series refits when **any** holds: (i) no cached fit;
  (ii) cadence elapsed (`scm_settings.refit_cadence_days`, default 14, range 1–90); (iii) the training
  window changed materially (`fit_hash` mismatch — new history length / closures / promo calendar). *(The
  D4 WAPE-degradation force-refit is a fourth trigger that lands with D4's accuracy monitoring, not D2.)* A
  stable series with a valid warm-start skips the cmdstan fit **and the backtest refit** entirely and only
  samples — the compute win; on a warm hit the API carries the cached `fit_wape` forward so the persisted
  forecast WAPE stays meaningful.
- **Determinism preserved.** Warm-start is a *pure function of inputs*: the same `(history, warm_start,
  request_id)` replays byte-identically (docs/54's `seeded_rng` invariant), so an API retry stays safe and
  pytest asserts warm-start ≡ cold-fit-then-reuse. A **corrupt cache entry fails closed to a refit**. This
  is a hard test gate.

### D3 — Horizontal scale (Size L, planned)

*Run the engine as N stateless replicas behind a shared result cache + work queue.*

- **The engine is already stateless** (no DB, no tenant ids, no PII — README + `main.py`), so N replicas
  are correct by construction; only the **in-process `ResultCache` and idempotency** are node-local today.
- **Shared result cache via Redis, reusing `common/rate-limit-store.ts`'s exact shape** — a lazily-built
  single connection, **fail-open**: `SCM_ENGINE_REDIS_URL` (or the existing `REALTIME_REDIS_URL`) set ⇒
  the `ResultCache.get/put` in `service.py` read/write Redis under the `X-Engine-Idempotency` key (TTL 15
  min, unchanged); unset **or Redis unreachable** ⇒ the current per-process TTL/LRU path (CI, single-node,
  and PGlite need no Redis). The idempotency key **already exists** on every request, so a retry that lands
  on a *different* replica now still returns the original solve instead of recomputing.
- **Work distribution.** Two viable topologies, decided in D3's PR:
  - **Stateless replicas behind Railway's load balancer** (simplest): the API's chunked-at-200 fan-out
    already parallelizes across replicas naturally; the shared cache dedupes retries. `UVICORN_WORKERS` ×
    `replicas` × `ENGINE_WORKERS` is the total concurrency budget.
  - **A Redis work queue** for very large catalogs: the API enqueues chunk jobs; replicas pull. Preferred
    only if LB fan-out proves uneven under Track B/C volume — a deliberate later step, not D3's default.
- **Scale-relevant engine env** (all optional, documented in the README table + `.env.example`):
  `ENGINE_WORKERS` (exists), `UVICORN_WORKERS`/`replicas` (exists), `SCM_ENGINE_REDIS_URL` (new),
  `SCM_ENGINE_CACHE_TTL_S` (new, defaults to the current 900). No API-visible behavior change.

### D4 — Accuracy monitoring (Size M, planned)

*Track WAPE/bias per item over time; drift alerts; champion/challenger; surface it.*

- **Accuracy history table** `scm_accuracy_history` — one row per `(tenant, branch, item, as_of_date)`
  capturing `wape`, `bias` (mean signed error / mean actual), `model`, `sample_n`, `fit_wape` (the WAPE at
  fit time, the baseline), and a `degraded` flag. Populated cheaply: each run **already computes backtest
  WAPE** (`saveForecast`); D4 additionally computes **realized accuracy** by comparing a prior forecast to
  the actuals that have since arrived (a backtest→realized reconciliation over the elapsed horizon).
  Canonical **0232-form RLS loop**, leading `(tenant_id, branch_id, item_id, as_of_date)` index, journaled
  in **its own migration at D4 delivery** (re-derive the next-free number then — the model cache already
  shipped standalone in 0475 with D2, so this table lands separately, both new and fully tenant-scoped).
- **Drift alert (the SCM-07 teeth).** After each accuracy refresh, a series whose realized WAPE exceeds its
  fit-time baseline by `degradation_factor` (default 1.5×) **for `sustained_periods` consecutive as-of
  dates** (default 3, so one bad day is not an alert) is flagged `degraded`, raises a **`captureOpsAlert`
  (`scm_forecast_degraded`)** — the same ops-alert channel `ScmEngineClientService` and the job worker
  already use — and publishes a `scm_accuracy_degraded` event on the **`ScmLiveService` SSE bus** (a new
  member of the existing `ScmLiveEvent` union, tenant-tagged, re-filtered per subscriber). The degradation
  flag also **feeds D2's refit trigger (iv)** — a degraded series is force-refit on the next batch, closing
  the loop.
- **Champion/challenger (planned, advisory).** Where a series has a viable alternative model (S-B routing
  already picks one), the batch can score a *challenger* on the same holdout and record both WAPEs in
  `scm_accuracy_history`; a challenger that beats the champion by a margin for `sustained_periods` surfaces
  as an advisory (never an automatic swap — model selection stays a governed, reviewable decision).
- **Surfacing (two rails, both existing).**
  - **BI report type `scm_forecast_accuracy`** — a **`BiReportGenerator` in `ScmBiReports.biReports()`**
    (docs/46 Phase 1: a provider in the owning module, **never** a branch in `bi-generate.service.ts` nor a
    new ctor param there). Read-only digest: per-item WAPE/bias trend, currently-degraded items, and the
    champion/challenger gap — schedulable for LINE/email delivery like `scm_plan_summary`.
  - **SSE live feed** — `scm_accuracy_degraded` on the `ScmLiveService` bus, consumed by the planner
    workspace's existing live channel so a degradation shows up without a poll.

---

## 3. Contract / interface deltas

- **Wire contract: mostly none.** D1 and D3 change **nothing** on the zod↔pydantic wire — D1 is scheduling
  + persistence on the API side, D3 is infrastructure behind the same HTTP surface. The response envelope,
  header names, and error shapes are untouched.
- **The one wire change is D2's warm-start (shipped — additive, NO version bump):** an optional per-series
  `warm_start` input and an optional `fitted_state` field in the forecast response. Both fields are
  optional and an engine that ignores `warm_start` cold-fits, so this is **additive and does NOT bump
  `SCM_ENGINE_CONTRACT_VERSION`** (stays `'2'`) — mirroring B2a's additive network route. This is the safer
  choice for a rolling deploy: a strict version check would hard-break old-API↔new-engine (or vice versa)
  for a field that is optional on both sides, contradicting the no-hard-break intent; instead each side
  degrades to cold-fit. The zod and pydantic sides move together, and the shared fixtures (a warm-start
  request/response pair) fail one side's CI on drift.
- **New internal (non-wire) interfaces:**
  - Job type `scm_batch_retrain` (JobWorkerService registration) + its action-report entry.
  - BI report type `scm_forecast_accuracy` (a `REPORT_TYPES` catalog entry + a generator in `ScmBiReports`).
  - `ScmLiveEvent` union gains `scm_accuracy_degraded`.
  - A forecast-source seam in `ScmRunService.runWithEngine` (persisted-forecast-first, engine-on-miss).
- **New engine env vars** (all optional, fail-open/default-preserving): `SCM_ENGINE_REDIS_URL`,
  `SCM_ENGINE_CACHE_TTL_S`; `ENGINE_WORKERS`/`UVICORN_WORKERS` already exist. New API env:
  `SCM_FORECAST_STALENESS_HOURS`, `SCM_REFIT_CADENCE_DAYS`, `SCM_ACCURACY_DEGRADATION_FACTOR`,
  `SCM_ACCURACY_SUSTAINED_PERIODS` — all with safe defaults, added to `.env.example`.

---

## 4. Data model / migrations

The two tables were originally planned as one migration; **they shipped separately.** `scm_model_cache`
delivered with **D2** in **migration `0475`** (plus the additive `scm_settings.refit_cadence_days` column);
`scm_accuracy_history` remains **planned with D4** (its own migration, re-derived from the journal tail then
— concurrent PRs steal numbers, mantra #10). Both are **fully tenant-scoped** with the canonical **0232-form
org RLS loop** and a leading `(tenant_id, …)` index (the `tenant-idx` gate + RLS loop are mandatory —
docs/55 §2 rule 3):

| Table | Grain | Key columns | Index (leading tenant) |
|---|---|---|---|
| `scm_model_cache` | per (tenant, branch, item) fitted model | `model`, `fit_params` (jsonb), `fit_hash`, `fit_wape`, `fitted_at`, `training_from`/`training_to` | `(tenant_id, branch_id, item_id)` unique on `coalesce(branch_id,0)` |
| `scm_accuracy_history` | per (tenant, branch, item, as_of_date) | `wape`, `bias`, `fit_wape`, `model`, `challenger_model`, `challenger_wape`, `sample_n`, `degraded` | `(tenant_id, branch_id, item_id, as_of_date)` |

- Both tables carry `tenant_id bigint references tenants(id)` and follow the `scm_settings`/`scm_item_policies`
  shape in `schema/scm-planning.ts`. The `coalesce(branch_id, 0)` unique index (NULL-branch = tenant default)
  is written **in the migration**, not the drizzle schema (drizzle-kit cannot express an expression index —
  the existing scm tables note this).
- `scm_settings` gains a small set of nullable columns (defaults preserve current behavior):
  `refit_cadence_days` (default 14), `forecast_staleness_hours` (default 24),
  `accuracy_degradation_factor` (default 1.5), `accuracy_sustained_periods` (default 3). Additive columns on
  an existing tenant table — no new writer breaks (all writes stay in `ScmPlanningService`), no RLS change.
- The migration's `DO $$ … GRANT … $$` block grants `app_user` on both new tables (mirror the scm-planning
  migration). **Journal it** (append to `meta/_journal.json`, sequential `idx`, ascending `when`) or the
  `migrations-journaled` gate fails and prod `drizzle-kit migrate` skips it.

No other schema touches: `scm_demand_forecasts.wape` already exists (accuracy source); `items.shelf_life_days`
already exists (0459).

---

## 5. Controls (RCM)

**SCM-07 — Forecast-accuracy monitoring (DETECTIVE).** The docs/55 §6 D4 control.

- **Precise assertion:** *Forecast accuracy (WAPE and bias) is monitored per (branch, item) over time
  against each series' fit-time baseline; a sustained degradation (realized WAPE above the baseline by the
  configured factor for the configured number of consecutive periods) raises an ops alert and a live-feed
  event, and force-refits the series on the next batch — so a silently drifting model that would degrade
  order quantities is detected and surfaced rather than accepted.*
- **Type / frequency / owner / risk:** Detective · Automated · Per planning/retrain run · Planner /
  Controller · risk of silent forecast drift → mis-sized perishable orders (waste or stockout) with no
  visibility. It is the **detective complement** to SCM-03's preventive auditable-order-sizing control.
- **Implementation reference:** `scm-accuracy.service.ts` (WAPE/bias reconciliation + degradation flagging),
  `scm_accuracy_history` (schema/scm-planning.ts), `ScmBiReports.scm_forecast_accuracy` (report type),
  `ScmLiveService.scm_accuracy_degraded` (SSE), `captureOpsAlert('scm_forecast_degraded')`; ToE in
  `tools/cutover/src/scm.ts`.
- **Test of effectiveness:** seed a series with a good backtest, then feed actuals that diverge for
  `sustained_periods` consecutive as-of dates → the series flags `degraded`, an ops alert + live event fire,
  and the next batch force-refits it; a single bad day does **not** alert (re-performed by the scm harness).
- **RCM plumbing (the change, in the same PR):** add SCM-07 via `build_rcm.py` `add("SCM-07", …)`
  (Detective, mirroring the SCM-03 add shape), **regenerate the xlsx** (`python3 compliance/build_rcm.py`;
  `pip install openpyxl` if needed), and **bump the census spans** — total **302 → 303**, implemented +1 —
  across `CONTROL_STATUS_HONEST.md`, `COSO_ICFR_Audit_Readiness_Plan.md`, `iso27001-gap-analysis.md`,
  `soc2-readiness.md`, verifying with `node tools/ci/check-rcm-census.mjs`. Adding a `cutover:` check inside
  the existing `scm` harness needs **no** branch-protection change (the shard's check name already gates it).

---

## 6. Phases

| Phase | Scope & key deliverables | New control | Size |
|---|---|---|---|
| **D1** | **Scheduled batch retrain.** `scm_batch_retrain` job + action report on the BI scheduler; persist forecasts; nightly *plan* reads fresh persisted forecasts (engine only on miss); per-tenant fairness (queue) + backpressure (run guard). No wire change. | — | M |
| **D2** ✅ | **Warm-start / model registry — DELIVERED (2026-07-23).** `scm_model_cache` table (**migration 0475**, 0232-form RLS + leading `(tenant_id, branch_id, item_id)` index + `coalesce(branch_id,0)` unique) + additive `scm_settings.refit_cadence_days`; **optional** `warm_start` input + `fitted_state` output on `/v1/forecast` — **additive, NO version bump** (stays `'2'`); refit only on cadence (default 14) / `fit_hash`-change; determinism preserved, corrupt cache fails closed to refit. `scm` harness 57/57 (+4 D2). | — | M |
| **D3** | **Horizontal scale.** Shared `ResultCache` via `SCM_ENGINE_REDIS_URL` reusing `rate-limit-store.ts`'s fail-open shape; idempotency now cross-replica; N stateless replicas; README/.env env docs. No app behavior change. | — | L |
| **D4** | **Accuracy monitoring.** `scm_accuracy_history` table (a future migration at D4); WAPE/bias trend + drift alert (ops alert + SSE) + force-refit feedback into D2; champion/challenger advisory; `scm_forecast_accuracy` BI report type. | **SCM-07** (detective) | M |

Sequencing (docs/55 §7, wave 5): **D2 shipped standalone** (migration 0475, additive contract — no bump);
**D1** (batch retrain) remains planned; **D3** is independent infra; **D4** lands `scm_accuracy_history`, the
control (SCM-07) and the report type. Each phase is ~1–3 doc-synced PRs.

---

## 7. UAT (extend cycle 18)

Add cases to **UAT cycle 18** (the docs/54 SCM cycle), keeping the traceability matrix in sync and
mirroring exact expected results/error codes:

- **UAT-SCM-0xx — accuracy-degradation alert fires.** Seed a series with a good backtest WAPE; feed
  diverging actuals for `sustained_periods` consecutive as-of dates → `scm_accuracy_history.degraded=true`,
  an `scm_forecast_degraded` ops alert, an `scm_accuracy_degraded` SSE event, and a force-refit on the next
  batch. **Negative/control:** one bad day (below `sustained_periods`) raises **no** alert.
- **UAT-SCM-0xx — warm-start reproducibility.** A run with a valid warm-start produces a forecast
  **byte-identical** to a cold fit followed by warm-start reuse for the same `(history, request_id)`; a
  training-window change (hash mismatch) forces a refit and updates `scm_model_cache`.
- **UAT-SCM-0xx — batch retrain feeds the plan.** After a scheduled `scm_batch_retrain`, the nightly plan
  consumes the persisted fresh forecasts (engine not called for those series); a stale/missing forecast
  falls back to a live engine forecast.
- **UAT-SCM-0xx — cross-tenant isolation (mandatory).** Tenant A's session sees **0** of Tenant B's
  `scm_model_cache` / `scm_accuracy_history` rows; a cross-tenant fetch by id returns not-found/forbidden
  (the docs/55 §2 rule 4 + Multi-Tenant Test Protocol boundary check).

## 8. Verification

- **Engine (pytest, `services/forecast-engine`):** warm-start **determinism** (warm-start ≡ cold-fit-reuse,
  byte-identical), **cache-hit correctness** (a second identical request under the same idempotency key
  returns the original payload; Redis-backed path exercised with a fake/in-memory Redis, and the fail-open
  path when Redis is absent), and refit-trigger logic (cadence / hash-change / degradation). New math ships
  with soundness properties, as in docs/54 §3.5.
- **Contract parity (TS):** `pnpm --filter @ierp/api test:coverage` (includes `scm-contract.test.ts`); the
  new warm-start fixture is parsed by both vitest and pytest so a drift fails one side.
- **API / controls:** extend `tools/cutover/src/scm.ts` — batch-retrain persistence + plan-reads-forecast,
  the SCM-07 degradation ToE (positive + the single-bad-day negative), and the cross-tenant boundary on
  both new tables. The `scm` harness is in the `scm-mfg` shard (adding checks needs no branch-protection
  change).
- **Gates:** shared build → `pnpm -r typecheck` → `pnpm -r build` → api coverage → the CI ratchets
  (service-size: land accuracy logic as its own `scm-accuracy.service.ts`, never on a facade;
  `migrations-journaled` for D4's migration; `check-rcm-census` for the 302→303 bump; `tenant-idx` for both new
  tables' leading index).
- **Load / scale testing (note, not a CI gate):** D3's horizontal-scale claim is validated **outside** the
  functional suite — a load run against N replicas with `SCM_ENGINE_REDIS_URL` set, asserting cross-replica
  idempotency hits and that throughput scales roughly linearly with replica count. CI stays single-node
  (no Redis), so this is an ops/manual verification recorded in `docs/ops`, not a merge gate.

## 9. Operational notes / risks

- **Redis availability = fail-open, exactly like the rate limiter.** `SCM_ENGINE_REDIS_URL` unset or Redis
  unreachable ⇒ the engine reverts to its per-process `ResultCache` (no error, no request failure) — the
  `common/rate-limit-store.ts` L-8/L-12 contract. Redis is a *scale optimization*, never a correctness
  dependency; a Redis outage degrades to today's single-node behavior, not an outage.
- **Model-cache invalidation.** A stale warm-start silently degrading forecasts is the main D2 risk; the
  `fit_hash` over the training window + the D4 WAPE-degradation force-refit are the two independent guards.
  Cache entries are prunable with the existing run-retention job (`pruneOldRuns` precedent); a manual
  "invalidate model cache" admin action (per tenant / item) is a small planned addition for recipe changes.
- **Replica warm-up.** Prophet/cmdstan imports are warmed at build time (Dockerfile `RUN python -c "import
  prophet, pulp"`) and `/readyz` proves the solver + Prophet in-image before a replica takes traffic — so a
  new replica does not serve a cold, failing forecast. `MPLCONFIGDIR=/tmp/matplotlib` stays (non-root HOME).
- **Determinism under scale.** The `seeded_rng(request_id, ref)` invariant must survive warm-start and
  multi-replica routing (a request must replay identically on any replica); this is asserted by pytest, not
  assumed.
- **`docs/ops` / `deployment.md` updates (planned, at D3 delivery):** document the optional
  `forecast-engine` replica count + `SCM_ENGINE_REDIS_URL` wiring (engine + API share the Redis the
  realtime bus / rate limiter may already use), and the new `.env` vars. No branch-protection change unless
  a brand-new top-level CI job is added (a `cutover:` check inside the `scm` shard is gated already).
- **No money-path / GL impact.** Track D posts no GL entries and does not touch `createSale`/`buildSale` or
  any golden-master-pinned path; the plan lifecycle + procurement PR handoff are unchanged. Doc-sync per the
  policy: PN-34, the user manual SCM chapter, UAT cycle 18, and the RCM (SCM-07) move together in each PR.

## 10. Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.2 | 2026-07-23 | Supply-chain / Planning | **D2 delivered — warm-start / model registry.** `scm_model_cache` tenant table (**migration 0475**, canonical 0232-form RLS + leading `(tenant_id, branch_id, item_id)` index + `coalesce(branch_id,0)` unique) caches each series' serialized Prophet fit; `ScmModelCacheService` loads a fit within the refit cadence and ships it as an **optional** `warm_start:{params, fit_hash}` on `/v1/forecast`, and persists the returned optional `fitted_state`. The engine's `fit_hash` over the training window governs reuse — a match reuses the serialized fit (skipping BOTH the primary fit and the backtest refit), else it cold-fits. **Contract is additive with NO version bump** (`SCM_ENGINE_CONTRACT_VERSION` stays `'2'`; both fields optional so a rolling deploy never hard-breaks — corrects the §3 planning note that said it would bump). Two fail-safe staleness guards: `fit_hash` mismatch and `refit_cadence_days` (new additive `scm_settings` column, default 14, range 1–90, validated in `ScmExtractService.upsertSettings`); a warm hit carries `fit_wape` forward. Determinism preserved (warm reuse ≡ cold fit byte-for-byte); corrupt cache fails closed to a refit. **No new control** (SCM-07 belongs to D4). `scm` harness 57/57 (+4 D2) + engine pytest (reproducibility / refit-on-window-change / corrupt-cache fallback). PN-34 §7.16, manual ch.21, UAT §15 (UAT-SCM-061..063). D1/D3/D4 remain planned. |
| 0.1 | 2026-07-21 | Supply-chain / Planning | Initial plan for **Track D — Scale-out retraining & accuracy operations** (docs/55 §6, phases D1–D4): batch retrain off the request path on the BI scheduler; warm-start / model registry (`scm_model_cache`, optional `warm_start` contract field bumping `SCM_ENGINE_CONTRACT_VERSION`); horizontal scale via a shared fail-open Redis result cache reusing `rate-limit-store.ts`; accuracy monitoring (`scm_accuracy_history`, WAPE/bias drift alerts on the SSE bus + a `scm_forecast_accuracy` BI report type) with new detective control **SCM-07** (RCM 302→303). Migration **0460** (two 0232-form RLS tenant tables + leading indexes). **Planning only** — no code, contract, schema, or control change yet. |
