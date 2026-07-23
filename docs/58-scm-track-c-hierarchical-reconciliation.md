# 58 · Track C — Hierarchical forecast reconciliation

**Status: DRAFT v0.4 · 2026-07-23** · *v0.4: **C3 + C4 implemented (engine capability)** — `reconcile.py` now implements real **`mint`** (minimum-trace, §1.3): it builds the summing matrix `S` from the forest, estimates the base-error covariance `W` per the request `covariance` enum (`ols`=I, `wls_struct`=diag(S·1) — the no-history cold-start default, `wls_var`=diag(per-node predictive variance), `shrink`=Schäfer–Strimmer toward the diagonal, invertible when n_obs<m), computes `G=(SᵀW⁻¹S)⁻¹SᵀW⁻¹` and the oblique projector `P=S·G`, and **C4** applies `P` per scenario/day to the base sample paths (clip-at-0 + renormalize each root subtree to its reconciled total). MinT differs from bottom-up only when the aggregate nodes carry INDEPENDENT base forecasts, so `service.run_forecast` now forecasts each aggregate node's summed leaf history independently (same base pipeline, per-node seed, no per-series regressors) and hands them to `reconcile` as `agg_base_by_node`. pytest asserts coherence, the projection identity on a coherent input, that MinT moves off bottom-up AND toward the truth at the aggregate, the closed-form `G` projector, shrink invertibility when n_obs<m, and coherence across all four covariances. **No wire change** (the `method`/`covariance` enums already carry `mint` + the four covariances from C2 — contract stays v2), no migration, no new control. The engine capability is complete and pytest-proven; the production API keeps sending `bottom_up` (the in-process/stub engines do BU/TD only) — flipping the nightly plan to `mint` is a deferred, measured policy step (covariance selected from series depth per §1.3; aggregate-forecast latency validated at fleet scale) that needs only a one-line method change, not more engine work.* · *v0.3: **C2 implemented** — the `reconciliation` request input (`zHierarchyNode` + `zReconciliation{method, covariance, nodes, reconcile_paths}`) and the `reconciled` per-node output added to the (already-v2) contract, additive, no version re-bump (shared `scm-engine.ts` + pydantic `contracts.py` + shared fixtures). Engine `reconcile.py` builds the summing forest and implements **bottom_up** + **top_down_hist** over the SAMPLE PATHS (coherent scenario-by-scenario; MinT falls back to bottom_up until C3), wired into `run_forecast`; pytest asserts coherence (parent == Σ children), the projection identity, determinism, non-negativity, and malformed-hierarchy rejection. `ScmRunService.runWithEngine` sends a bottom-up TOTAL-over-menu-series forest and explodes the RECONCILED leaf paths with a coherence trust-boundary (degrade to base on violation). No new control / no migration. `scm` harness proves the reconciliation flows coherently end to end. C3 (MinT) / C4 (probabilistic paths depth) remain planned.* · *v0.2: **C1 implemented** — `scm_forecast_hierarchy` table (migration 0461, 0232-form RLS + leading `(tenant_id, axis)` index, journaled), `ScmHierarchyService` (declare / list / delete + the `forest()` assembler that synthesizes from `branches` / `item_categories` when undefined), and `GET/PUT/DELETE /api/scm-planning/hierarchy(/forest)` gated to `scm_plan`/`exec`; `scm` harness C1 cases (synthesize, declare with computed levels, cyclic-forest rejection, cross-tenant isolation). No engine/contract change (that lands with C2). C2–C4 remain planned.* · Owner: Supply-chain / Planning · Depends on **docs/54**
(delivered — `services/forecast-engine` + `modules/scm-planning`) and **docs/55 §5** (SCM depth
roadmap, Track C phases C1–C4). Related: docs/46 (module boundaries), PN-34, UAT cycle 18.

Make the per-(branch, item) forecasts of docs/54 **sum coherently** up the aggregation structures the
ERP already carries — item→category→total and branch→region→company — and keep that coherence for the
*probabilistic* output, not just the point forecast, so the downstream perishable optimizer still
receives internally consistent scenarios. The engine stays the stateless pure-compute microservice;
the ERP stays the system of record; this track adds a **reconciliation step** between forecasting and
optimization and one small piece of governed hierarchy master data.

---

## 1. Problem & approach

### 1.1 Why coherence matters

docs/54 forecasts each `(branch, menu sku)` series independently. Independent forecasts are
**incoherent**: the sum of the branch-level P50s does not equal a directly-forecast company-level P50,
category roll-ups disagree with their member items, and a regional buyer negotiating a bulk contract
reads a total that no branch plan actually implies. Three concrete failures on the current spine:

1. **Planning vs. reporting divergence** — the `/demand` branch tab shows per-branch bands; a manager
   asking "what is the chain forecasting for pork belly next week?" gets a number that is the *sum of
   independent means* (fine) but a *sum of independent P90s that overstates the tail* (§3.3 of docs/54
   already warns that quantiles are not additive). There is today no coherent multi-level view.
2. **Signal lives at different levels than noise** — a category or regional aggregate is smoother and
   easier to forecast accurately than a sparse single-branch SKU; a top-heavy holiday signal
   (Songkran) is best estimated at the total and pushed down. Independent forecasts throw that
   cross-level information away.
3. **The optimizer must stay coherent too** — if we reconcile only the point forecast but hand the
   optimizer the *un*-reconciled sample paths, the order plans no longer reconcile against the totals
   the planner approved. Coherence has to survive all the way to `demand_scenarios`.

### 1.2 The three reconciliation families

Let the hierarchy have `n` bottom-level (leaf) series and `m` total nodes across all levels. Stack the
level-indexed base forecasts into a vector **ŷ** ∈ ℝᵐ. The **summing matrix** S ∈ {0,1}ᵐˣⁿ encodes the
aggregation: each row is a node, each column a leaf, `S[i,j] = 1` iff leaf `j` sums into node `i`
(bottom rows of S are the identity block). A forecast is **coherent** iff it lies in the column space
of S — i.e. it equals `S · b` for some bottom-level vector **b**.

| Method | Reconciliation `G` (ỹ = S·G·ŷ) | Property |
|---|---|---|
| **Bottom-up (BU)** | `G = [0 ∣ Iₙ]` — take the leaves, discard aggregates, re-sum | Trivially coherent; ignores the more-accurate aggregates |
| **Top-down (TD) by proportions** | `G` spreads the top node down by historical shares `pⱼ` | Coherent; captures top signal; shares are static/fragile |
| **Optimal — MinT** | `G = (Sᵀ W⁻¹ S)⁻¹ Sᵀ W⁻¹` (§1.3) | Coherent AND minimum-variance; uses every level |

BU and TD are the *cheap coherence win* (docs/55 C2): ship them first, high value, low risk. MinT
(docs/55 C3) is the optimal generalization.

### 1.3 MinT — minimum-trace reconciliation (Hyndman et al.)

The reconciled forecast is a linear projection of the base forecast onto the coherent subspace:

```
ỹ = S · G · ŷ ,        G = (Sᵀ W⁻¹ S)⁻¹ Sᵀ W⁻¹
```

where **W** is the covariance of the *base-forecast errors* (`W = Cov(y − ŷ)`). MinT is the G that
minimizes the trace of the reconciled-error covariance (hence "minimum trace") among all coherent,
unbiased linear reconciliations. `P := S·G` is an oblique projector onto `col(S)`: `P·S = S`, so
`P·(S·b) = S·b` — an already-coherent input is left untouched (a soundness property we assert as a
test, §8). BU (`W = I` restricted) and OLS (`W = I`, "MinT(ols)") are special cases, so one code path
covers all three.

**Covariance estimation with a shrinkage estimator.** The full sample `W` is `m × m` and, with sparse
restaurant history, singular and ill-conditioned. We use the **Schäfer–Strimmer shrinkage** toward a
diagonal target `D = diag(Ŵ_sample)`:

```
Ŵ = λ·D + (1 − λ)·Ŵ_sample ,   λ ∈ [0,1] chosen by the SS closed form
```

which is well-conditioned and invertible even when `n_obs < m`. Two cheaper diagonal variants are also
offered and are often the sweet spot for us: **`wls_var`** (`W = D` from residual variances — MinT
diagonal) and **`wls_struct`** (`W = diag(S·1)`, variances proportional to the number of leaves under
each node — needs *no* residual history, so it is the safe cold-start default). The estimator is a
per-request enum; the API picks it from series depth.

### 1.4 Coherent probabilistic reconciliation — reconcile the paths, not the quantiles

docs/54's load-bearing output is the **K×H sample paths**, and §3.3 there forbids summing quantiles.
The same rule applies here: we reconcile the *sample paths*. Because `P = S·G` is linear, applying it
to each base sample path draws a reconciled path that is coherent **by construction** (`P` maps into
`col(S)`, so the reconciled leaf paths sum exactly to their reconciled aggregates, scenario by
scenario). Concretely, for each scenario ω and horizon day t we project the base draw across the
hierarchy:

```
ỹ[ω, t, :] = P · ŷ[ω, t, :]          (P = S·G, applied per scenario, per day)
```

This is the "coherent probabilistic reconciliation" of docs/55 C4: the reconciled leaf paths are what
flow into BoM explosion and then `/v1/optimize` as `demand_scenarios`, so the whole cross-branch /
cross-category correlation the optimizer needs is preserved *and* coherent. (A projected path can go
slightly negative under aggressive reconciliation; we clip at 0 and re-normalize the leaves to the
reconciled aggregate — a documented, tested post-step, §8.) Point forecasts and quantiles in the
response are then re-derived from the reconciled paths, never reconciled directly.

### 1.5 What this is NOT

Not a new forecaster — the base models (Prophet / Croston–SBA / bootstrap / DOW baseline) are
unchanged; reconciliation is a **post-processing bounded step** over their output. Not a new money
path, not a GL change, not a maker-checker change: the reconciled forecast feeds the *same* Draft →
approve → PR-handoff lifecycle docs/54 built.

---

## 2. Engine contract deltas

TypeScript (`packages/shared/src/scm-engine.ts`) stays the source of truth; pydantic
(`services/forecast-engine/app/contracts.py`) mirrors it; the shared JSON fixtures are parsed by both
vitest (`apps/api/test/scm-contract.test.ts`) and pytest, so any drift fails one side's CI.

### 2.1 New forecast-request input — the hierarchy (planned)

Additive, optional. Absent ⇒ the engine behaves **byte-identically** to docs/54 (no reconciliation),
which keeps the fixture-parity contract and lets an older engine ignore the field (zod strips unknown
keys; pydantic ignores them):

```ts
export const zHierarchyNode = z.object({
  node_id: z.string().min(1),            // opaque; API maps back to (level, ref)
  parent_id: z.string().nullable(),      // null = a root (the total)
  series_id: z.string().optional(),      // set ⇔ this node is a LEAF; must match a series[].series_id
});
export const zReconciliation = z.object({
  method: z.enum(['none', 'bottom_up', 'top_down_hist', 'mint']).default('none'),
  covariance: z.enum(['ols', 'wls_struct', 'wls_var', 'shrink']).default('wls_struct'),
  nodes: z.array(zHierarchyNode).min(1),
  reconcile_paths: z.boolean().default(true),  // §1.4 — reconcile sample paths, not just points
});
// zForecastRequest gains:  reconciliation: zReconciliation.optional(),
```

Structural rules the engine validates (`VALIDATION_ERROR` / a per-node `EngineItemError`): every
`series_id` referenced by a leaf node exists in `series[]`; the node set is a forest (no cycles, each
non-root `parent_id` resolves); leaves are exactly the childless nodes. The summing matrix S is built
from this forest.

### 2.2 New forecast-response output — reconciled per level (planned)

Base per-series results are unchanged (back-compat). A new top-level `reconciled` block carries a
result **per hierarchy node** (leaves *and* aggregates), same shape as `zForecastSeriesResult` but keyed
by `node_id`, including reconciled `sample_paths` when `reconcile_paths` was set:

```ts
export const zReconciledNodeResult = zForecastSeriesResult
  .omit({ series_id: true, model: true })
  .extend({
    node_id: z.string(),
    level: z.number().int().min(0),        // 0 = leaf; increases toward the root
    method: z.enum(['bottom_up', 'top_down_hist', 'mint']),
  });
// zForecastResponse gains:  reconciled: z.array(zReconciledNodeResult).default([]),
```

The API persists leaf `reconciled` paths as the demand it explodes; aggregate-node results are stored
for the planner's coherent multi-level view and for the coherence-invariant harness check (§5).

### 2.3 Contract version + fixture parity

This is a **wire-shape change**, so bump `SCM_ENGINE_CONTRACT_VERSION` `'1' → '2'` on **both** sides
(and `CONTRACT_VERSION` in `contracts.py`) in the same PR. Per docs/55 §2 cross-cutting rule 2, the zod
and pydantic sides move together. Add shared fixtures under
`services/forecast-engine/tests/fixtures/` — at minimum a two-level and a three-level hierarchy request
+ its reconciled response — so both suites round-trip the new blocks. The engine continues to accept a
request with **no** `reconciliation` field as a v2 request (the field is optional), so the API can roll
forward before every series opts in.

---

## 3. Data model

### 3.1 Reuse what exists

- **item→category→total** is already modeled: `item_categories` (`posting-setup.ts`, tenant-scoped,
  0232-form RLS) gives every item a category via the item→category link, and "total" is the tenant.
  No new table is needed for the item axis — the API reads the existing category assignment.
- **branch→…→company**: `branches` (`branch.ts`) is **flat within a tenant** — it has `is_hq` but **no
  region/parent column**. So the branch axis has only two native levels (branch, tenant total). A
  *region* tier (branch→region→company), which docs/55 C1 calls for, has no home today.

### 3.2 `scm_forecast_hierarchy` — the one new table (planned)

Rather than widen `branches` (which many modules read) or overload `item_categories`, Track C declares
aggregation structures in a dedicated, planning-owned mapping table — governed master data, one row per
node, self-referencing parent (the `projects.parentId` / crm territory precedent):

```
scm_forecast_hierarchy
  id             bigserial pk
  tenant_id      bigint  → tenants(id)          -- RLS scope (0232 canonical loop)
  axis           text    not null               -- 'branch' | 'item'
  node_code      text    not null               -- natural key per (tenant, axis)
  name / name_th text
  parent_id      bigint  → scm_forecast_hierarchy(id)  -- null = a root (the total)
  level          int     not null default 0      -- 0 = leaf, increasing toward root (denormalized)
  ref_kind       text                            -- 'branch' | 'item_category' | 'group'
  ref_id         text                            -- branches.id / item_categories.code for a leaf/mid node
  active         boolean not null default true
  created_at / updated_at
  UNIQUE (tenant_id, axis, node_code)
  INDEX idx_scm_forecast_hierarchy_tenant (tenant_id, axis)   -- leading (tenant_id,…) per tenant-idx gate
```

This lets a tenant map `branch → region → company` (region rows are `ref_kind='group'`) and, when they
want something other than the posting categories, an arbitrary item roll-up — **without** forcing every
tenant to define one (absent ⇒ Track C stays off, docs/54 behavior). Where a tenant is happy with the
native structure the API *synthesizes* the forest from `branches` + `item_categories` and never writes a
row.

### 3.3 Migration, RLS, journal

One journaled migration, **next free number 0460** (`idx 434`, `when 2023820000399` — re-derive from
the live `_journal.json` tail after any main merge, per CLAUDE.md mantra #10; the current tail is
`0459_scm_planning` / idx 433 / when …398):

- `apps/api/drizzle/0460_scm_forecast_hierarchy.sql` creates the table, appends the **canonical
  0232-form RLS loop** (the org-clause body — never the plain `0081`/`0002` form) so cross-account org
  sharing holds, and the `DO $$ … GRANT … $$` block granting `app_user`.
- The leading `(tenant_id, axis)` index satisfies the `cutover:tenant-idx` gate (a `tenant_id` column
  with no leading-tenant index fails it).
- Append the matching `meta/_journal.json` entry (sequential `idx`, strictly-increasing `when`) or the
  `migrations-journaled` gate fails and prod `drizzle-kit migrate` skips it.

No other module writes this table, so there is no cross-writer NULL-`tenant_id` fan-out to sweep (the
2026-07-10 `stock_movements` class of breakage does not apply).

---

## 4. API / module design

Bounded context (docs/55 §2 rule 1): the reconciliation orchestration is small and forecast-adjacent, so
it lands as a **sub-service inside `modules/scm-planning`** (e.g. `scm-hierarchy.service.ts`) built
positionally in the facade ctor body like the existing `scm-extract` / `scm-run` split — never appended
to a facade that the `check-service-size` ratchet would then flag.

**Flow (extends the docs/54 `ScmRunService.executePlanRun` pipeline):**

1. **Assemble the hierarchy (extract).** `scm-hierarchy.service.ts` builds the node forest for the run:
   read `scm_forecast_hierarchy` if the tenant defined one, else synthesize it from `branches` +
   `item_categories`. Emit the `reconciliation.nodes` payload, tagging each leaf with its docs/54
   `series_id`. Historical proportions for TD, and the residual history MinT's shrinkage needs, come from
   the already-extracted dense series — no new query path.
2. **Forecast + reconcile (engine, one bounded step).** The forecast request now carries
   `reconciliation`; the engine forecasts the leaves as before, builds S from the forest, computes G per
   the chosen method/covariance, and returns the `reconciled` block (§2.2). When `SCM_ENGINE_URL` is
   unset, the **in-process fallback** applies BU/TD only (pure linear algebra, no Prophet/PuLP) so the
   opt-in-with-graceful-degradation posture (docs/54 §2.3) holds; MinT requires the Python engine.
3. **Explode reconciled leaf paths.** BoM explosion (`explodePaths`) consumes the **reconciled** leaf
   `sample_paths` instead of the raw ones — summing paths per scenario, exactly as today — so the
   ingredient scenarios that reach `/v1/optimize` as `demand_scenarios` are coherent end-to-end.
4. **Optimize + persist unchanged.** `/v1/optimize`, the FEFO/newsvendor/MILP tiers, clamping, and the
   Draft → maker-checker → PR-handoff lifecycle are all untouched — they receive coherent scenarios and
   never learn reconciliation happened.

**Trust boundary** (docs/54 §6): the API zod-validates the `reconciled` block and, before persisting,
asserts the coherence invariant on the returned aggregates (leaf sums ≈ parent, within a float
tolerance); a violation marks the run's reconciliation degraded and falls back to BU (which is coherent
by construction) rather than persisting an incoherent forecast.

---

## 5. Controls

**No new preventive RCM control.** Per docs/55 §5, Track C's phases carry **no** `New control` — and
that is deliberate, not an omission: reconciliation is a **forecast-quality property**, not a new
authority, money movement, or segregation boundary. The existing SCM controls already govern the
surface Track C touches — **SCM-01/02/03** (docs/54: run integrity, maker-checker plan approval, engine
output clamping) still apply unchanged, because the reconciled forecast flows through the *same* run and
approval path. Adding a preventive control here would be control theater. **This track adds `build_rcm.py`
`add(...)` calls: none; the RCM total and the `check-rcm-census` tagged spans are unchanged.**

**The coherence invariant (pinned by the harness, not the RCM).** What Track C *does* guarantee is
tested as a hard invariant in `tools/cutover/src/scm.ts` and the engine pytest suite: after
reconciliation, **every parent node's forecast equals the sum of its children's** (points and, when
`reconcile_paths`, scenario-by-scenario paths) within tolerance, and an already-coherent input is
unchanged. This is a correctness assertion on the math, sitting alongside docs/54's optimizer soundness
properties — it protects the *forecast*, not a *control objective*.

**Optional future detective control (explicitly not in scope).** *If* a later audit wants a monitored
control around it, the natural shape is a **detective coherence-audit**: a scheduled check that sampled
production forecasts reconcile within tolerance and raises an ops alert on sustained drift — analogous
to SCM-07 (D4 forecast-accuracy monitoring). It would be a *new* number allocated at that time; it must
**not** reuse SCM-04/05/06/07, which docs/55 already assigns to Tracks A/B/D. Flagged here as a
possibility only; this plan proposes **no** RCM change.

---

## 6. Phases (C1–C4)

Mirrors docs/55 §5; each phase is ~1–2 doc-synced PRs. C1→C2 is the cheap coherence win and ships first
(docs/55 §7 Wave 1); C3→C4 land with the optimal reconciliation wave.

| Phase | Scope & key deliverables | New control | Size |
|---|---|---|---|
| **C1** | **Hierarchy definition.** `scm_forecast_hierarchy` table + migration 0460 (0232 RLS, leading index, journaled); synthesize-from-`branches`+`item_categories` when undefined; `scm-hierarchy.service.ts` assembler; settings/API to declare a structure. No engine change yet. | — | **S** |
| **C2** | **Bottom-up / top-down.** Contract `reconciliation` input + `reconciled` output (contract v2 bump, fixtures); engine + in-process fallback implement `bottom_up` and `top_down_hist`; reconciled leaf paths flow into explosion; planner multi-level view. | — | **S** |
| **C3** ✅ | **Optimal reconciliation (MinT).** Engine adds `mint` with `ols` / `wls_struct` / `wls_var` / `shrink` covariance (Schäfer–Strimmer). Aggregate nodes are forecast INDEPENDENTLY in `run_forecast` (summed leaf history) — the signal that makes MinT ≠ BU; `W` is estimated from the base forecasts' predictive dispersion (the same sample paths §1.4 reconciles — no separate residual backtest / new query path, per §3). pytest proves MinT moves off BU and nearer the truth at the aggregate on a synthetic hierarchy, plus the closed-form projector + shrink invertibility. | — | **M** |
| **C4** ✅ | **Coherent probabilistic paths.** `reconcile_paths` projects the sample paths through `P=S·G` per scenario/day (clip-at-0 + renormalize each root subtree to its reconciled total); reconciled leaf paths flow into explosion → `/v1/optimize` (via the same seam C2 built); path-coherence pytest asserts every parent = Σ children scenario-by-scenario. | — | **M** |

Delivered in full, Track C makes the planner's numbers reconcile across item→category→total and
branch→region→company, points and scenarios alike — the "coherent totals" line of the docs/55 roadmap.

---

## 7. UAT (extend cycle 18)

Add cases to the existing SCM cycle 18 (docs/54 seeded UAT-SCM-001..042); keep the traceability matrix
and expected error codes in sync:

- **UAT-SCM-043 (positive, C2).** Define a two-level branch hierarchy, run a plan with
  `method='bottom_up'`; assert the company-node forecast returned equals the sum of the branch-node
  forecasts (the **coherence assertion**) and the branch plans are unchanged vs. no reconciliation.
- **UAT-SCM-044 (positive, C3).** With ≥ backtest-min history, `method='mint', covariance='shrink'`;
  assert reconciliation succeeds, aggregates are coherent, and reported backtest error at the aggregate
  node is ≤ the base (un-reconciled) aggregate error.
- **UAT-SCM-045 (positive, C4).** `reconcile_paths=true`; assert reconciled leaf sample paths sum to the
  parent path scenario-by-scenario (within tolerance) and that these are the paths the order plan was
  optimized against.
- **UAT-SCM-046 (negative/control).** A hierarchy referencing a non-existent `series_id`, or a cycle in
  `parent_id`, is rejected (`VALIDATION_ERROR` / per-node error) and the run degrades to BU rather than
  persisting an incoherent forecast.
- **UAT-SCM-047 (cross-tenant boundary).** Tenant A cannot read or reference Tenant B's
  `scm_forecast_hierarchy` rows (`ref_id` pointing at B's branch/category); a list returns exactly 0 of
  B's nodes and a mutation against B's node id returns a 403/404 — the mandatory multi-tenant boundary
  case.

Doc-sync (CLAUDE.md policy): PN-34 gains a reconciliation section; the user manual chapter 21 (SCM) gets
a body walkthrough for declaring a hierarchy and reading the coherent multi-level view; UAT cycle 18 +
traceability updated; the plan-doc (this file) and docs/55 §5 status rows bumped as phases land.

---

## 8. Verification

**Engine pytest — soundness properties (as in docs/54 §3.5, asserted as tests not prose):**

- **Coherence.** For BU, TD, and MinT, every parent node's reconciled forecast equals the sum of its
  children (points and, for C4, per-scenario paths) within a float tolerance.
- **Projection identity.** `P·S = S` — feeding an already-coherent forecast through reconciliation
  returns it unchanged (no spurious adjustment).
- **MinT accuracy.** On a synthetic hierarchy with known error covariance, MinT's backtest WAPE at the
  aggregate levels is **≤** the base (independent) forecast's — the whole justification for the method.
- **Covariance robustness.** `shrink` produces an invertible, well-conditioned `Ŵ` when `n_obs < m`
  (the sparse-history case) where the raw sample covariance is singular; `wls_struct` needs no residual
  history at all (cold-start default).
- **Probabilistic-path coherence + non-negativity.** Reconciled paths are coherent scenario-by-scenario
  and the clip-and-renormalize post-step leaves them non-negative and still summing to the reconciled
  aggregate.
- **Determinism.** Same request ⇒ identical reconciled output (the per-series seed convention is
  unchanged; reconciliation is a deterministic linear map).

**Contract parity (TS + Python):** `pnpm --filter @ierp/api test:coverage` (includes
`scm-contract.test.ts`) and `pytest` both round-trip the new hierarchy/`reconciled` fixtures; the v2
version bump is asserted on both sides.

**API / controls:** extend `tools/cutover/src/scm.ts` — positive (coherence invariant end-to-end
through extract → engine|fallback → explosion), negative/control (malformed hierarchy degrades to BU),
and the cross-tenant boundary case (UAT-SCM-047).

**CI gates (run locally before pushing):** shared build → `pnpm -r typecheck` → `pnpm -r build` → api
coverage → the ratchets. Track C touches a new sub-service (keep it under the 600-LOC
`check-service-size` cap — it is a fresh file, so the baseline stays empty), no new `'use client'` file,
no ledger-boundary read, and adds a journaled migration with a leading tenant index (`tenant-idx` +
`migrations-journaled` gates). No RCM/`check-rcm-census` change by construction (§5).

---

## 9. Operational notes / risks

- **Covariance estimation with sparse history.** Restaurant SKU-level series are intermittent; the raw
  `m × m` sample covariance is routinely singular. Shrinkage (Schäfer–Strimmer) is the mitigation, but
  when even the diagonal is noisy the API should prefer `wls_struct` (structural variances, no residual
  history) or fall back to BU. The covariance choice is data-driven per run, and the harness pins that a
  degenerate-history request still returns a *coherent* (if not optimal) forecast.
- **Compute cost of MinT at scale.** `G = (Sᵀ W⁻¹ S)⁻¹ Sᵀ W⁻¹` inverts an `n × n` (bottom-level) system
  per hierarchy. For a 33-branch chain across a few hundred items this is small, but a
  full item × branch cross-hierarchy grows quadratically in leaves. Mitigations: reconcile per axis
  (branch and item separately) rather than the full cross-product; cache `G` while S and the covariance
  estimate are stable (they change slowly); and, at genuinely large catalogs, push reconciliation onto
  the scheduled batch retrain — **forward-ref to Track D** (docs/55 §6: D1 batch retrain, D3 horizontal
  scale), which is the mandated home for heavy compute as A/B/C raise the load.
- **Opt-in and back-compat.** With no `reconciliation` field the engine is byte-identical to docs/54;
  with a hierarchy defined but the external engine unconfigured, only BU/TD run in-process. No prod
  behavior changes until a tenant declares a structure and turns it on.
- **Reconciliation is advisory to accuracy, mandatory to coherence.** MinT usually *improves* accuracy
  but is not guaranteed to on every series; the invariant we hard-pin is *coherence*, and the accuracy
  claim is verified only on the synthetic backtest, reported (not asserted) on live runs.

---

## 10. Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.4 | 2026-07-23 | Supply-chain / Planning | **C3 + C4 implemented (engine capability).** `reconcile.py` gains real **`mint`**: `_summing_matrix` builds S from the forest, `_estimate_W` estimates the base-error covariance per the `covariance` enum (`ols`=I, `wls_struct`=diag(S·1), `wls_var`=diag(per-node predictive variance), `shrink`=Schäfer–Strimmer toward the diagonal via the closed-form λ*), `_mint_G` computes `G=(SᵀW⁻¹S)⁻¹SᵀW⁻¹` (solve-based, pinv fallback), and `_mint_bottom` applies `P=S·G` per scenario/day (**C4**) with clip-at-0 + per-root-subtree renormalization. MinT ≠ BU only with INDEPENDENT aggregate forecasts, so `service.run_forecast` adds `_forecast_aggregates` — it forecasts each aggregate node's summed leaf history with the base pipeline (per-node seed, no per-series promo/price regressor) and passes them as `agg_base_by_node`; `reconcile.aggregate_specs` exposes the non-leaf nodes + their descendant series to it. W is estimated from the base forecasts' predictive dispersion (the same sample paths §1.4 reconciles — no separate residual backtest / new query path, per §3). `test_reconcile.py` rewritten: MinT coherence + method reported, projection identity on a coherent input, moves-off-BU-and-toward-truth at the aggregate, closed-form `G` projector (`P·S=S`), shrink invertibility when n_obs<m (13-node/3-scenario forest), and all four covariances coherent — 14 reconcile tests, full engine suite 101 passed. **No wire change** (enums already carry `mint` + the covariances — contract stays v2), no migration, no new control, no RCM/census change. The production API keeps `bottom_up` (in-process/stub engines do BU/TD only); the MinT flip is a deferred one-line policy step. Docs: docs/55, PN-34 §7.9, manual ch.21, UAT cycle 18 (UAT-SCM-044/045). |
| 0.3 | 2026-07-22 | Supply-chain / Planning | **C2 implemented.** Additive contract (no version re-bump): `zHierarchyNode` + `zReconciliation` request input and `zReconciledNodeResult` + `reconciled[]` response, mirrored in pydantic + shared fixtures (a 2-level hierarchy round-tripped by both suites). Engine `reconcile.py` — summing forest S, **bottom_up** + **top_down_hist** over the sample paths (coherent per scenario; clip+renormalize; MinT→bottom_up until C3), wired into `run_forecast`; 6 pytest soundness properties (coherence, projection identity, determinism, non-negativity, TD keeps the total, malformed→reject). `ScmRunService.runWithEngine` sends a bottom-up forest (TOTAL over the branch menu series) and explodes the reconciled leaf paths with a coherence trust-boundary that degrades to the base forecast on violation; `planHelpers.meanOfPaths`. `scm` harness +1 C2 check (a coherent reconciliation flows end to end, plans unaffected). No new control, no RCM/census change, no migration. Docs: docs/55, PN-34, manual ch.21, UAT cycle 18 (UAT-SCM-048). |
| 0.2 | 2026-07-22 | Supply-chain / Planning | **C1 implemented.** `scm_forecast_hierarchy` mapping table (migration **0461**, idx 435 — the plan's assumed 0460 was taken by `marketing_intel_snapshots`; re-derived per mantra #10 — canonical 0232-form RLS loop + leading `(tenant_id, axis)` index, journaled with strictly-increasing `when`), plus the `ScmForecastHierarchyRow` type. New `ScmHierarchyService` sub-service (db-only, built positionally in the `ScmPlanningService` ctor): `list` / `declare` (bulk-replace an axis, forest-validates unique codes / resolvable parents / no cycle, computes `level`) / `remove` (combined id+tenant check) and the **`forest(tenant, axis)` assembler** — a tenant's declared structure, else a synthesized 2-level forest (TOTAL root + one leaf per active branch, or per `item_categories` row). Endpoints `GET /api/scm-planning/hierarchy`, `GET …/hierarchy/forest`, `PUT …/hierarchy`, `DELETE …/hierarchy/:id` (class gate `scm_plan`/`exec`). `scm` harness gains C1 cases (synthesized forest, declare branch→region→company with computed levels, `SCM_HIERARCHY_INVALID` on a cycle, cross-tenant isolation). No engine/contract/RCM change (Track C adds no control; the coherence invariant lands with C2). Docs synced: PN-34 §7.9, manual ch.21, UAT cycle 18 (UAT-SCM-043/044). |
| 0.1 | 2026-07-21 | Supply-chain / Planning | Initial plan for Track C — hierarchical forecast reconciliation (docs/55 §5, phases C1–C4): reuse `item_categories` + a new `scm_forecast_hierarchy` mapping table for the branch→region→company axis; additive `reconciliation` forecast-request input + reconciled per-node output (contract **v2** bump, fixture parity); bottom-up / top-down / optimal **MinT** with a shrinkage covariance estimator; coherent probabilistic reconciliation of the sample paths so the optimizer receives coherent scenarios; **no new preventive RCM control** (a forecast-quality property, per docs/55) with a coherence *invariant* pinned by the `scm` harness and an optional future detective coherence-audit noted but not proposed. **Planning only — no code, contract, control, or schema change yet.** |
