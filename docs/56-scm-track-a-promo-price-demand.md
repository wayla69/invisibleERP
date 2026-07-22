# 56 · Track A — Promotion & price-effect demand modeling

**Status: DRAFT v0.2 · 2026-07-22** · *v0.2: **A1 implemented** — engine contract **v1→v2** (per-series `regressors:[{ds,promo_flag,discount_pct,price}]`, `promo_regressor`/`price_regressor`/`scenario` flags, `attribution` output; zod `packages/shared/src/scm-engine.ts` + pydantic `contracts.py` + shared fixtures moved together). Engine `forecasting.py` gains a promo/price Prophet `add_regressor` (generalizing `is_payday`) + a capped multiplicative uplift term for the Croston/bootstrap/baseline paths (`U_MAX`), and returns `attribution`. `ScmPromoExtractService` derives the promo/discount regressors **server-side** from the tenant's approved `promotions` under RLS (never the request body); `ScmRunService.runWithEngine` threads them (production runs pin `scenario=false`) and persists attribution onto `scm_demand_forecasts` (migration **0462**: `promo_uplift_pct`/`price_elasticity`/`regressors_used`). New control **SCM-04** (promo-forecast governance). Engine pytest (promo monotonic-lift, determinism, `U_MAX` cap, byte-identical without regressors); `scm` harness promo cases (governed→attribution, no-promo→baseline, tenant-scoped). A2–A4 remain planned.* · Owner: Supply-chain / Planning · Depends on **docs/54** (delivered:
`services/forecast-engine` + `modules/scm-planning`) and **docs/55 §3** (SCM depth roadmap, Track A A1–A4).
Related: docs/52/53 (pricing / promotions / price-book), PN-34, docs/46 (module boundaries).

Forecasts today respond to **calendar** signal only — weekly/yearly seasonality, Thai holidays, the payday
regressor. They are blind to the two levers a restaurant/retail operator actually pulls: **promotions** and
**price**. A 30%-off weekend or a menu re-price shifts demand by more than any holiday, yet the planner keeps
ordering to the un-promoted baseline, so a promo stocks out on day one and its hangover over-orders the week
after. Track A makes demand a function of promo and price, not just the calendar — **entirely on the docs/54
spine**: the engine gains external regressors, the contract gains the price/promo inputs to carry them, and a
new estimates cache holds per-item elasticities. Nothing here is a new money path and no plan auto-executes.

This is **planning only** — no code, contract, control, or doc-sync change lands with this file.

---

## 1. Problem & approach

### 1.1 What is missing, precisely

The existing forecasters (`services/forecast-engine/app/forecasting.py`) fit Prophet with one custom
regressor — `is_payday` — and route intermittent/lumpy series to Croston–SBA / bootstrap, which have **no**
regressor mechanism at all. A promotion is therefore invisible three ways: Prophet never sees it (no
regressor column), Croston multiplies a flat rate, and the bootstrap resamples historical days that
themselves contain un-attributed promo spikes — so past promos leak into the "baseline" as noise while a
*known future* promo is ignored. Track A closes all three.

### 1.2 The modeling method (per phase)

**A1 — external regressors (generalizes the payday regressor).** Prophet already carries the pattern
(`m.add_regressor("is_payday")` in `_fit_prophet`, with the value supplied for both the fit frame and the
future frame). A1 adds the same treatment for `promo_flag`, `discount_pct` and (log-)`price`: each is a
column present in the history frame **and** the horizon frame, and Prophet estimates a coefficient that
lifts (or, for a price rise, suppresses) demand on the days the regressor is on. The regressor value on
future days is the **known, governed** promo calendar and the **planned** price — the operator's own decision,
not a guess. For the non-Prophet paths a multiplicative **uplift term** is applied to each sample path:

```
uplift[t] = clamp( 1 + β_promo · promo_flag[t] + ε · Δlog_price[t] , 0 , U_MAX )
path[k][t] *= uplift[t]
```

where `β_promo` is a shrunken promo-lift prior (per item where history affords it, else a category/global
prior) and `ε` is the own-price elasticity of A2 (0 until estimated). Croston's rate and the bootstrap's
resample pool stay the un-promoted baseline; the uplift is applied *after* sampling so intermittency structure
is preserved. `U_MAX` caps a single day's lift so a fat-fingered 99%-off can't produce an absurd path
(belt-and-suspenders to the API's own clamp).

**A2 — own-price elasticity (log-log).** Per item, regress `log(y)` on `log(price)` over the history where
price varied, with day-of-week / holiday / promo controls partialled out:
`log(y_t) = a + ε·log(price_t) + controls_t + η_t`. The slope `ε` (expected negative) is the constant
elasticity of a log-log demand curve, so a price scenario re-scales demand by `(price_new / price_ref)^ε`.
This is the classic identification: **without price variation in history, ε is not identifiable** — the
estimator reports `n_obs` / `r²` / price-variance and the engine **suppresses** (`ε := 0`, promo uplift only)
below a variance/`r²` floor rather than emitting a spurious slope (see §9). Estimates are cached in
`scm_price_elasticity` and feed the existing advisory scenario tool ("what if we drop price 10% at BKK01?").

**A3 — category-scoped cannibalization / halo.** Promoting X moves its neighbours: a substitute loses sales
(cannibalization, negative cross-elasticity), a complement gains (halo, positive). The full cross-product is
O(items²) and mostly noise, so the substitution matrix is **scoped to `item_categories`** — cross terms are
estimated only between items sharing a category (menu section / product family). A promo on X adjusts sibling
baselines by `Δlog(y_sibling) = ε_cross(X→sibling) · promo_intensity(X)` before those siblings are forecast.
Cross-elasticities live in `scm_cross_elasticity`, symmetric-by-default and pruned to significant pairs.

**A4 — attribute-based analog cold-start.** A new SKU has no history, so it cannot be fit — but it is rarely
*unlike everything*. A4 selects "like-items": same category plus nearest attributes (price band, unit,
tags/`item` attributes), pools their **de-baselined promo-response and seasonal shape**, and applies it to
the new SKU scaled by an expected-baseline seed (planner input or category median). The cold-start forecast
is explicitly flagged `analog` in the series result so a reviewer sees it is borrowed, not observed.

### 1.3 What this is NOT

Not demand *sensing* (no web/social signal), not a promo-optimization/markdown engine (Track A predicts the
effect of a decided promo; it does not choose the promo), and not a change to how promos are *created* or
priced — those governed surfaces (docs/52 `price_rules`/`price_books` maker-checker, `promotions`) are the
**source** of the regressor signal, read-only, never written by this track.

---

## 2. Engine contract deltas (`packages/shared/src/scm-engine.ts` ⇄ `contracts.py`)

TypeScript stays the source of truth; the pydantic mirror and the shared JSON fixtures move in lockstep
(a drift fails one side's CI — `apps/api/test/scm-contract.test.ts` + `tests/test_contract_fixtures.py`).

### 2.1 Version bump

`SCM_ENGINE_CONTRACT_VERSION` **`'1'` → `'2'`** (planned). The new fields are additive and pydantic strips
unknowns, so shape-compat holds — but the regressors change forecaster **behaviour**, and an API on `'2'`
must not silently receive un-regressed forecasts from an old `'1'` engine. Because `contract_version` is a
`z.literal`, the bump makes the two deploy lockstep: a stale engine answers a `'2'` request with
`CONTRACT_VERSION_MISMATCH` (422) and the API stays in its in-process fallback rather than shipping a wrong
plan. Both `zForecastRequest`/`zForecastResponse` literals and `contracts.py` `CONTRACT_VERSION` move together;
`SCM_ENGINE_HEADERS` are unchanged.

### 2.2 `/v1/forecast` request — per-series regressors (planned)

```ts
export const zSeriesRegressor = z.object({
  ds: zBizDay,                                   // aligns to a history day OR a horizon day
  promo_flag: z.boolean().default(false),        // a governed promo is active on this (branch,item,day)
  discount_pct: z.number().min(0).max(1).optional(), // effective discount depth, 0..1
  price: z.number().min(0).optional(),           // effective/planned unit price that day (elasticity input)
});

// zSeriesInput gains:
regressors: z.array(zSeriesRegressor).optional(), // dense over history∪horizon; gaps carry-forward baseline
analog_of: z.array(z.string()).optional(),        // A4: donor series_ids for a zero-history sku

// zForecastRequest gains (mirrors payday_regressor):
promo_regressor: z.boolean().default(true),
price_regressor: z.boolean().default(true),
scenario: z.boolean().default(false),             // true = advisory what-if (never feeds an auto-convert plan)
```

Rule (enforced API-side, §5): `regressors[].price`/`promo_flag` on **future** days are the operator's
governed calendar + planned price; on **past** days they reconstruct what was actually charged/promoted. The
engine treats them as data — it never fabricates them.

### 2.3 `/v1/forecast` response — attribution (planned)

```ts
// zForecastSeriesResult gains:
attribution: z.object({
  promo_uplift_pct: z.number().nullable(),   // fitted lift on promo days vs baseline, for plan surfacing
  price_elasticity: z.number().nullable(),   // ε used this run (null when unidentifiable / suppressed)
  elasticity_r2: z.number().nullable(),
  elasticity_n_obs: z.number().int().nullable(),
  regressors_used: z.array(z.enum(['promo', 'price', 'payday', 'analog', 'cross'])),
}).optional(),
```

This is what lets the plan **surface promo attribution** ("this line's +40% is the weekend 25%-off, not a
trend") without the API re-deriving it. `sample_paths` stay the load-bearing output; BoM explosion still sums
paths per scenario.

### 2.4 Pydantic mirror + fixtures

`contracts.py` gains `SeriesRegressor` and the `SeriesInput.regressors` / `ForecastRequest.promo_regressor` /
`ForecastSeriesResult.attribution` fields with identical bounds and defaults. **Parity rule:** every new field
is exercised by a shared fixture under `services/forecast-engine/tests/fixtures/` that both suites parse, so a
zod/pydantic divergence (a renamed key, a missing default, a bound mismatch) fails either CI — the docs/54 P1
guarantee, extended.

---

## 3. Data model / extraction

### 3.1 Extracting the promo calendar + price history (under tenant RLS)

All extraction stays in the API under the caller's RLS context (the engine never sees tenant data). A new
bounded helper `ScmPromoExtractService` (see §4) reads, per `(branch, item, business day)` over the lookback
window:

| Signal | Source table(s) | Notes |
|---|---|---|
| Promo active + depth | `promotions` (+ `promotion_items` junction, `category`) | date-ranged, `active`; `discount_pct`/`discount_amt` → normalized `discount_pct` |
| Promo actually applied | `promo_redemptions` (`applied_at`, `discount_amount`, `sale_no`) | the **audit truth** that a promo fired at checkout — used to validate the calendar signal |
| Rule-based discounts | `price_rules` (`type` percent/amount/fixed/bogo/qty_break, `valid_from/to`, `status='Active'`) | only **approved/active** rules (the G6 maker-checker gate) count |
| Effective / planned price | `price_book_entries`→`price_books` (approved), `price_list`, else observed line price on `cust_pos_items` | resolution order mirrors the sale path; fall back to realized price = revenue/qty |

The promo flag on a day is `true` only when a **governed** promo/rule/book applies to that item on that day;
`promo_redemptions` cross-checks it so a calendar row that never fired is down-weighted (data-quality signal,
§9). Business-day bucketing uses the same fixed-offset `bizDayExpr()` literal-inlining discipline as
`scm-extract.service.ts` (never a named TZ, never a bound placeholder shared across SELECT/GROUP BY → 42803).
Extraction respects the same channel partition (retail leg excludes dine-in/split; restaurant leg reads the
kitchen tables) so promo days align to the same demand the docs/54 extractor produces.

### 3.2 New estimates cache — `scm_price_elasticity` / `scm_cross_elasticity` (planned)

Elasticities are expensive to fit and stable week to week, so they are **cached estimates**, refreshed on the
nightly cadence, not recomputed per run. Two tenant-scoped tables (migration **next free `04NN`** — re-derive
the number, `idx`, and `when` from the live `_journal.json` tail at implementation per the mantra-#10 rule;
journaled with a strictly-increasing `when`):

```
scm_price_elasticity(
  id, tenant_id NOT NULL, item_id, branch_id NULL,        -- branch_id NULL = tenant-wide estimate
  elasticity numeric, r2 numeric, n_obs int, price_var numeric,
  method text, identifiable boolean, promo_uplift_pct numeric,
  estimated_at timestamptz, run_id )                       -- provenance: which run produced it
scm_cross_elasticity(
  id, tenant_id NOT NULL, item_id, related_item_id, category text,
  cross_elasticity numeric, r2 numeric, n_obs int, kind text,  -- 'substitute' | 'complement'
  estimated_at timestamptz )
```

Both carry:
- the **canonical 0232-form RLS loop** (copy `0232`'s org-clause body verbatim — never the plain
  `0081`/`0121` form — or cross-account org sharing silently regresses), enabling `tenant_isolation`;
- a **leading `(tenant_id, …)` index** (`idx_scm_price_elasticity_tenant` on `(tenant_id, item_id, branch_id)`;
  `idx_scm_cross_elasticity_tenant` on `(tenant_id, item_id, related_item_id)`) or the `cutover:tenant-idx`
  gate fails;
- `GRANT`s for `app_user` in the migration's `DO $$ … $$` block (mirror `0234`/`0247`).

These are the **only** new tables Track A needs; A1 is otherwise contract-only, and A2–A4 read/write only these
caches plus the existing pricing/promotion tables (read-only).

---

## 4. API / module design

New logic lands in **bounded sub-services** of `modules/scm-planning`, never appended to a facade (the
`check-service-size` ratchet caps module files at 600 LOC; the docs/54 module's largest file is already 380).

1. **`ScmPromoExtractService`** (new, db-only, built positionally in the facade ctor body like
   `ScmStockExtractService`) — owns §3.1: assembles the per-`(branch,item,day)` regressor rows for history and
   the horizon, resolving promo/price from the governed tables. Exposes `regressorsFor(series, horizon)` →
   `ScmSeriesRegressor[]` and `promoCalendar(tenantId, window)`.
2. **`ScmElasticityService`** (new, db-only) — reads/writes the two cache tables, applies the identifiability
   floor, and answers `elasticity(itemId, branchId)` / `crossFor(itemId)` for the run assembler and the
   scenario tool. Estimation itself runs in the **engine** (returned in `attribution`) and is *persisted* here,
   keeping heavy compute out of Node.
3. **`ScmExtractService.extractAll`** gains a `regressors` field on `ExtractedTenantData` (populated by the
   promo extractor); it is threaded into the per-series forecast request in `ScmRunService.runWithEngine`
   exactly where `payday_regressor` is set today.
4. **`ScmRunService`** — after each forecast batch, persist `attribution` (uplift, ε, r², n_obs) onto
   `scm_demand_forecasts` (add columns) and upsert `scm_price_elasticity`. The optimize half is unchanged —
   promo/price shape the **demand paths**, and the existing perishable optimizer consumes them as-is.
5. **Scenario tool** — the existing advisory `/api/scm-planning/scenario` endpoint gains a `price`/`promo`
   override that sets future `regressors` and `scenario:true`. Its output is **advisory only**: flagged in the
   response and structurally barred from becoming an auto-converted order plan (§5).

No new engine **route** is required — A1–A4 all ride `/v1/forecast`. Inter-service auth, chunking (≤200
series), and the fallback-when-unconfigured posture are inherited unchanged.

---

## 5. Controls — RCM **SCM-04** (promo-forecast governance, preventive)

**Risk.** A forecast — and therefore an order quantity, and therefore committed spend — can be inflated by a
**fabricated or ungoverned promo signal**: a planner claims a big promo that was never approved, or feeds a
hypothetical rock-bottom price into the model, and the engine dutifully forecasts a spike that becomes a large
Draft order a hurried approver rubber-stamps. Price elasticity compounds it — a spurious steep slope turns a
tiny modelled price cut into a huge demand lift.

**Control (assertion).** Promo/price forecast inputs are **auditable and governed**, and a forecast cannot be
silently inflated by fabricated promo signals:

1. **Server-derived, not client-supplied.** The `promo_flag`/`discount_pct`/`price` regressors on a *production*
   run are derived by `ScmPromoExtractService` from the **approved** promotions / `price_rules` (status=Active,
   the G6 maker-checker gate) / `price_books` and validated against `promo_redemptions` — never accepted from
   the run request body. A run cannot assert a promo that does not exist in the governed tables.
2. **Advisory what-ifs are quarantined.** A scenario run (`scenario:true`, hypothetical price/promo) is flagged
   throughout and is **structurally barred** from the auto-convert path — only a plan from a non-scenario run
   can reach PendingApproval → Approved → PR (SCM-01 maker-checker still applies on top).
3. **Provenance persisted.** Each forecast persists its `attribution` (uplift %, ε, r², n_obs, `regressors_used`)
   and the run's `requestDigest` already records the exact regressor payload, so a reviewer can re-derive why a
   quantity moved and tie every promo input back to an approved source.
4. **Unidentifiable elasticity is suppressed, not guessed** (identifiability floor, §9) and the engine's `U_MAX`
   day-cap plus the API's existing qty clamp bound any residual lift.

**Doc-sync obligation** (at implementation, per CLAUDE.md): add SCM-04 via `build_rcm.py`
`add("SCM-04", "Inventory & COGS", "Application", …, "Prev", …)`, **regenerate** the xlsx
(`python3 compliance/build_rcm.py`; do not hand-edit the binary), then bump the tagged census spans
(`<!-- rcm-total -->` / `-implemented`) across `CONTROL_STATUS_HONEST.md`, `COSO_ICFR_Audit_Readiness_Plan.md`,
`iso27001-gap-analysis.md`, `soc2-readiness.md` and confirm with `node tools/ci/check-rcm-census.mjs` (the
add moves the count by +1 from the current total; re-derive the exact numbers against live `main`). SCM-04
is added **inside the existing coverage** — no new RCM job or branch-protection check. A2–A4 introduce no new
control (they refine the SCM-04-governed inputs); if A2 elasticity later warrants its own detective row it is
a separate add.

---

## 6. Phases

| Phase | Scope | Deliverables | Size | Control |
|---|---|---|---|---|
| **A1** | **Promo/price regressors.** Extract the governed promo calendar + price/discount as external regressors on `/v1/forecast`; Prophet `add_regressor` (generalizes payday); Croston/bootstrap uplift term; plan surfaces promo attribution. | Contract v2 (`regressors`, `promo_regressor`, `attribution`) + pydantic mirror + shared fixtures; `ScmPromoExtractService`; run threads regressors + persists attribution; `.env` unchanged; pytest regressor-effect properties; `scm` harness promo cases; **SCM-04** + RCM/census; PN-34, UAT, user manual. | **S** | **SCM-04** |
| **A2** | **Own-price elasticity.** Engine estimates log-log ε per item from history with an identifiability floor; cached; feeds the advisory scenario tool. | `scm_price_elasticity` (RLS + idx + journaled migration); `ScmElasticityService`; engine estimator + `attribution.price_elasticity`; scenario `price` override; pytest identifiability tests; harness scenario case. | **M** | — |
| **A3** | **Cannibalization / halo.** Category-scoped cross-elasticity matrix; promoting X adjusts siblings before forecast. | `scm_cross_elasticity` (RLS + idx + journaled); engine cross-term; category scoping via `item_categories`; pytest sign/scoping tests; harness sibling case. | **L** | — |
| **A4** | **Cold-start / new items.** Attribute-based analog forecasting for zero-history SKUs. | `analog_of` contract field; donor selection (category + attributes); borrowed promo/seasonal shape scaled to a baseline seed; `analog` flag; pytest analog tests; harness new-item case. | **M** | — |

Each phase is 1–2 doc-synced PRs. A1 is engine+contract-only (lowest risk, immediate win) and ships in
roadmap **Wave 1**; A2/A3 in Wave 2; A4 in Wave 5 (docs/55 §7 sequencing).

---

## 7. UAT (extend cycle 18)

New cases append to the docs/54 SCM cycle (UAT-SCM-001..042); traceability matrix + expected error codes kept
in sync (mirror the exact codes the harness asserts).

| Case | Type | Scenario → expected |
|---|---|---|
| **UAT-SCM-043** | Positive | A smooth series with a governed weekend promo in the horizon → the promo-day forecast is materially above the un-promoted baseline; `attribution.promo_uplift_pct` is populated and the plan line shows the promo reason. |
| **UAT-SCM-044** | Positive | A2: an item whose history has real price variation → a negative `price_elasticity` with `identifiable=true`; a −10% price scenario raises the forecast by ≈ `(0.9)^ε`. |
| **UAT-SCM-045** | Negative / control | A **fabricated** promo supplied on a production run request (no matching approved promotion/rule) → the input is **ignored** (server-derived only); the forecast equals the no-promo baseline. Assert no uplift and provenance shows `regressors_used` without `promo`. |
| **UAT-SCM-046** | Negative / control | A **scenario** what-if with a hypothetical price → forecast is flagged advisory and an attempt to submit/convert it → `SCENARIO_NOT_CONVERTIBLE` (planned). |
| **UAT-SCM-047** | Negative / control | An item with **no price variation** in history → elasticity `identifiable=false`, `price_elasticity=null`; a price scenario produces **no** demand change (suppressed, not a guessed slope). |
| **UAT-SCM-048** | Negative / control | A promo `discount_pct` of 0.99 → the day path is capped at `U_MAX` and the resulting order line is clamped (SCM-04 belt-and-suspenders); `detail.clamped` records it. |
| **UAT-SCM-049** | Positive | A3: promoting item X lifts its complement / cannibalizes its substitute **within the same category only**; an out-of-category item is unaffected. |
| **UAT-SCM-050** | Cross-tenant boundary | Tenant A runs a plan; assert its regressor extraction and `scm_price_elasticity` rows are **RLS-scoped** — Tenant B's session reading A's estimates by id returns 0 rows / 404, and A's run never reads B's promotions. |

---

## 8. Verification

- **Engine (pytest soundness properties — the docs/54 §3.5 flavour, asserted as tests not prose):**
  - a promo-flagged horizon day yields a strictly higher mean than the same series with `promo_regressor=false`
    (monotone regressor effect);
  - with `ε<0`, a higher future `price` yields a lower forecast, and the ratio matches `(p₂/p₁)^ε` in the
    log-log limit;
  - elasticity is **suppressed to 0** below the price-variance / `r²` floor (identifiability property);
  - determinism holds — same `request_id` + regressors ⇒ byte-identical paths (the seeded-RNG guarantee);
  - a category-scoped cross term moves siblings and leaves out-of-category items exactly unchanged;
  - an `analog_of` cold-start borrows shape and is flagged `analog`.
  Run: `cd services/forecast-engine && pip install -e ".[dev]" && pytest`.
- **Contract parity (TS + pydantic):** `pnpm --filter @ierp/api test:coverage` includes `scm-contract.test.ts`
  reading the new shared fixtures; the pydantic side parses the same files.
- **API / controls:** extend `tools/cutover/src/scm.ts` — positive (regressor uplift, attribution persisted),
  negative/control (fabricated promo ignored; scenario not convertible; unidentifiable ε suppressed), and the
  cross-tenant boundary (UAT-SCM-050). Build `@ierp/shared` before the harness (it imports the dist).
- **Gates:** shared build → `pnpm -r typecheck` → `pnpm -r build` → api coverage → the CI ratchets
  (`check-service-size`, `check-ts-debt`, `tenant-idx`, `migrations-journaled` + `check-rcm-census`). A1 touches
  no web file (attribution renders inside the existing `/demand` islands with no new `'use client'`), so the
  use-client ratchet stays flat; the new tables are the only `tenant-idx`/journal surface.

---

## 9. Operational notes / risks

- **Promo-signal data quality.** The calendar (`promotions`/`price_rules`) is what was *planned*;
  `promo_redemptions` is what *fired*. Where they disagree the model trusts the redemption truth and
  down-weights the un-fired calendar row — otherwise a promo that was configured but switched off teaches a
  phantom uplift. The `branch_null_share`-style visibility principle applies: report the promo-coverage rate
  per run so a tenant with sparse promo tagging sees *why* uplift is muted rather than silently getting none.
- **Overfitting.** Restaurant promos are infrequent, so a per-item promo coefficient can chase a handful of
  days. Mitigations: shrink `β_promo` toward a category/global prior, cap `U_MAX`, and prefer Prophet's
  regularized regressor (a `prior_scale`) over an unpenalized fit. Attribution's `n_obs` surfaces how much the
  estimate leans on thin data.
- **Elasticity identifiability.** ε is only estimable where price actually moved; menus that never re-price
  give a degenerate regression. The engine reports `identifiable`/`r²`/`n_obs`/`price_var` and **suppresses**
  (ε:=0) below the floor — a correct "we don't know" beats a fabricated slope, and it is the load-bearing SCM-04
  defense against a scenario-driven over-order.
- **Endogeneity.** Promos are run *because* demand is expected high (or low), biasing naive ε and β. Track A
  keeps it honest by controlling for calendar/holiday/payday and by validating against redemptions; a fuller
  causal treatment (instrumenting price) is explicitly out of scope for A2 and noted as a future refinement.
- **Cannibalization sparsity (A3).** Category scoping keeps the matrix small and interpretable, but cross terms
  are noisier than own-price; only pairs above a significance threshold are stored, and the rest default to 0
  (independent) — the conservative choice.
- **Contract lockstep (A1).** The v2 bump means the engine and both API services must deploy together; until
  the engine is on v2 the API stays in its safe in-process fallback (no promo modelling, but never a wrong
  promo-inflated plan).

---

## 10. Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.4 | 2026-07-22 | Supply-chain / Planning | **A3 implemented — cannibalization & halo (cross-price elasticity).** `ScmCrossElasticityService` estimates γ_{a,b}=∂log(demand_a)/∂log(price_b) **API-side** (the API holds all series' demand + governed prices) by log-log OLS with the **same identifiability floor** as A2 (γ=null when not identified), **CATEGORY-SCOPED** to `item_categories` siblings only — never the full cross-product (`MAX_CATEGORY_ITEMS` bound). A run persists credible pairs to `scm_cross_elasticity` (migration **0466**, canonical RLS + tenant-leading index); `GET /api/scm-planning/cross-elasticity`. The advisory scenario tool composes own + cross: `demand_i × (price_multiplier)^(ε_i + Σ_{j∈scenario, same cat} γ_{i,j})` — γ>0 substitutes offset a price cut's own-lift, γ<0 complements reinforce it. **No contract change** (API-side), **no new control**. apps/api **vitest +7** (recover substitute/complement / flat-price null / few-obs null / weak-fit null / clamp / drop-empty) proves the estimator; `scm` harness **+3** (read / scenario folds sibling γ category-scoped / cross-tenant) proves the wiring. Doc-sync: docs/55, PN-34 §7.14, manual ch.21 §7, UAT cycle 18 §13. **Track A demand-shaping levers complete (promo/own-price/cross-price); A4 cold-start is a later wave.** |
| 0.3 | 2026-07-22 | Supply-chain / Planning | **A2 implemented — own-price elasticity.** `ScmPromoExtractService` now emits a governed **effective price** per day (base × (1−discount)) so a promotion's price cut becomes the identifying price variation (server-derived, never client input). Engine `forecasting.py` `estimate_elasticity` — an OLS **log-log** slope of demand on price over the observed history (stockout days excluded) with an **identifiability floor** (min paired obs / min log-price variance / min r²; |ε| clamped) → returns ε=null when not identified, reported in `attribution` (`price_elasticity`/`elasticity_r2`/`elasticity_n_obs`). API: `scm_price_elasticity` (migration **0464**, canonical RLS + tenant-leading index) + `ScmElasticityService` (upsert on run, cached lookup) + `GET /api/scm-planning/elasticity`; the advisory scenario tool gains `price_multiplier` applying `demand × (price)^ε` (unit response when no ε on file). **No contract version change** (the v2 attribution fields already existed); **no new control** (a forecast-quality input). Engine pytest +7 (recovery / not-identified / floor / clamp / stockout-excluded); `scm` harness +4 (persist / attribution / scenario-applies / cross-tenant). Doc-sync: docs/55, PN-34 §7.13, manual ch.21, UAT cycle 18 §12. A3 (cannibalization) next. |
| 0.2 | 2026-07-22 | Supply-chain / Planning | **A1 implemented.** Engine contract **v2** (per-series promo/price `regressors`, `promo_regressor`/`price_regressor`/`scenario` flags, `attribution` output) mirrored in zod + pydantic + shared fixtures; engine `forecasting.py` promo/price Prophet `add_regressor` generalizing `is_payday` + a `U_MAX`-capped Croston/bootstrap/baseline uplift term + attribution; `ScmPromoExtractService` (server-derived promo/discount regressors from approved `promotions` under RLS — never client input); `ScmRunService` threads them (`scenario=false` on production runs) and persists attribution onto `scm_demand_forecasts` (migration **0462**). Control **SCM-04** (promo-forecast governance; `build_rcm.py`, xlsx regenerated, census 302→303/299→300). Engine pytest + `scm` harness promo cases (governed→attribution, no-promo→baseline, tenant-scoped). Doc-sync: docs/55, PN-34, manual ch.21, UAT cycle 18. |
| 0.1 | 2026-07-21 | Supply-chain / Planning | Initial plan for **Track A — Promotion & price-effect demand modeling** (docs/55 §3, phases A1–A4): external promo/price regressors generalizing the payday regressor (Prophet `add_regressor` + a Croston/bootstrap uplift term), log-log own-price elasticity with an identifiability floor, category-scoped cannibalization/halo, and attribute-based analog cold-start. Contract deltas (per-series `regressors:[{ds,promo_flag,discount_pct,price}]`, `promo_regressor`/`scenario` flags, `attribution` output, `SCM_ENGINE_CONTRACT_VERSION` 1→2 with the shared-fixture parity rule), the `scm_price_elasticity`/`scm_cross_elasticity` estimate caches (0232-form RLS + tenant-leading index + journaled migration), a bounded `ScmPromoExtractService`/`ScmElasticityService` design, new control **SCM-04** (promo-forecast governance), extended UAT cycle 18, and engine/harness/gate verification. **Planning only — no code, contract, or control change yet.** |
