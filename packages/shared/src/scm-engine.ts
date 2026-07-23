import { z } from 'zod';

// ── docs/54 · SCM planning ⇄ forecast-engine wire contract ────────────────────────────────────
// TypeScript (this file) is the SOURCE OF TRUTH; services/forecast-engine/app/contracts.py mirrors
// it with pydantic, and the JSON fixtures under services/forecast-engine/tests/fixtures are parsed
// by BOTH vitest (apps/api/test/scm-contract.test.ts) and pytest, so contract drift fails either CI.
//
// The engine is stateless pure-compute: every request is self-contained (histories, holidays,
// closures, stock by remaining shelf-life, costs) and carries NO tenant identifiers and NO PII —
// data extraction happens in the API under tenant RLS, and the API persists the results. Requests
// are chunked PER BRANCH (≤ 200 series / 300 items), which is why `closures` is a flat request-level
// list. Auth = HMAC-SHA256 over `${unixSeconds}.${rawBody}` (SCM_ENGINE_HEADERS below; the engine
// enforces a 300 s freshness window — same convention as common/webhook-auth.ts inbound webhooks).

export const SCM_ENGINE_CONTRACT_VERSION = '2'; // v2 (docs/56 A1): promo/price regressors + attribution

export const SCM_ENGINE_HEADERS = {
  timestamp: 'x-engine-timestamp', // unix SECONDS (not ISO — the inbound-webhook freshness convention)
  signature: 'x-engine-signature', // hex hmac-sha256; a 'sha256=' prefix is accepted
  idempotency: 'x-engine-idempotency', // stable per logical call across retries — engine result-cache key
  version: 'x-engine-version', // response only: engine build version (persisted on scm_plan_runs)
} as const;

const zBizDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/); // Asia/Bangkok BUSINESS day (bizYmd), never UTC

// ── /v1/forecast ──────────────────────────────────────────────────────────────────────────────

export const zDemandPoint = z.object({
  ds: zBizDay,
  y: z.number().min(0),
  // That day's sales were supply-capped (right-censored demand) — the engine excludes it from the
  // fit instead of learning phantom low demand. Optional: omitted = a normal observed day.
  stockout: z.boolean().optional(),
});
export type ScmDemandPoint = z.infer<typeof zDemandPoint>;

export const zHolidayEvent = z.object({
  name: z.string().min(1),
  ds: zBizDay,
  lower_window: z.number().int().min(-7).max(0).default(0),
  upper_window: z.number().int().min(0).max(7).default(0), // e.g. Songkran carries upper_window 2
  prior_scale: z.number().positive().optional(),
});
export type ScmHolidayEvent = z.infer<typeof zHolidayEvent>;

// docs/56 A1 — a governed promo/price signal for one (series, business day). Dense over history∪
// horizon; the API DERIVES these from approved promotions/price_rules/price_books under tenant RLS,
// never from client input (SCM-04). On future days they are the operator's planned calendar/price.
export const zSeriesRegressor = z.object({
  ds: zBizDay,
  promo_flag: z.boolean().default(false),
  discount_pct: z.number().min(0).max(1).optional(),
  price: z.number().min(0).optional(),
});
export type ScmSeriesRegressor = z.infer<typeof zSeriesRegressor>;

export const zSeriesInput = z.object({
  series_id: z.string().min(1), // opaque to the engine; the API maps it back to (branch, menu sku)
  history: z.array(zDemandPoint).min(1), // dense daily series, ascending, zeros filled on open days
  class_hint: z.enum(['auto', 'smooth', 'intermittent', 'lumpy', 'short']).default('auto'),
  regressors: z.array(zSeriesRegressor).optional(), // A1: dense over history∪horizon
  analog_of: z.array(z.string()).optional(), // A4 (reserved): donor series_ids for a zero-history sku
});
export type ScmSeriesInput = z.infer<typeof zSeriesInput>;

// docs/58 C2 — hierarchical reconciliation. The API declares an aggregation forest (leaves carry a
// series_id; aggregates have children); the engine makes the forecasts sum coherently up it. Additive
// and optional — absent ⇒ the engine is byte-identical to the pre-C2 (v2) behaviour.
export const zHierarchyNode = z.object({
  node_id: z.string().min(1), // opaque; the API maps it back to (level, ref)
  parent_id: z.string().nullable(), // null = a root (the total)
  series_id: z.string().optional(), // set ⇔ this node is a LEAF; must match a series[].series_id
});
export type ScmHierarchyNode = z.infer<typeof zHierarchyNode>;

export const zReconciliation = z.object({
  method: z.enum(['none', 'bottom_up', 'top_down_hist', 'mint']).default('none'),
  covariance: z.enum(['ols', 'wls_struct', 'wls_var', 'shrink']).default('wls_struct'), // MinT only (C3)
  nodes: z.array(zHierarchyNode).min(1),
  reconcile_paths: z.boolean().default(true), // reconcile the sample PATHS, not just the point forecast
});
export type ScmReconciliation = z.infer<typeof zReconciliation>;

export const zForecastRequest = z.object({
  contract_version: z.literal(SCM_ENGINE_CONTRACT_VERSION),
  request_id: z.string().min(1), // idempotency + deterministic RNG seed (same request ⇒ same paths)
  horizon_days: z.number().int().min(1).max(56),
  scenario_count: z.number().int().min(10).max(100).default(50),
  quantiles: z.array(z.number().min(0).max(1)).default([0.1, 0.5, 0.9]),
  holidays: z.array(zHolidayEvent), // Thai national + tenant promo events — the API owns the calendar
  closures: z.array(zBizDay).default([]), // branch closed days, past (excluded from fit) + future (forced 0)
  payday_regressor: z.boolean().default(true), // Thai payday effect: month-end/1st–2nd/15th–17th
  promo_regressor: z.boolean().default(true), // A1: fit/apply the promo regressor where series carry it
  price_regressor: z.boolean().default(true), // A1: fit the (log) price regressor where series carry it
  scenario: z.boolean().default(false), // A1: advisory what-if — never feeds an auto-convert plan (SCM-04)
  reconciliation: zReconciliation.optional(), // C2: make forecasts sum coherently up the hierarchy
  series: z.array(zSeriesInput).min(1).max(200), // SCM_ENGINE_MAX_SERIES chunking bound
});
export type ScmForecastRequest = z.infer<typeof zForecastRequest>;

export const zForecastSeriesResult = z.object({
  series_id: z.string(),
  model: z.enum(['prophet', 'croston_sba', 'bootstrap', 'baseline_dow']),
  points: z.array(
    z.object({
      ds: zBizDay,
      yhat: z.number().min(0),
      q: z.record(z.string(), z.number()), // quantile → value, keys are the request's quantiles as strings
    }),
  ),
  // K × H sample paths — the load-bearing output. BoM explosion must sum PATHS per scenario
  // (quantiles are not additive: P95 of a sum ≠ sum of P95s), and the summed ingredient paths feed
  // /v1/optimize as `demand_scenarios`. Point forecasts exist only for display.
  sample_paths: z.array(z.array(z.number())),
  accuracy: z.object({
    wape: z.number().nullable(), // rolling-origin holdout WAPE; null when history is too short
    cutoffs: z.number().int(),
  }),
  // docs/56 A1 — what shaped this forecast, so the plan surfaces promo attribution and a reviewer
  // can tie a moved quantity back to a governed input (SCM-04). Null on a v1 (pre-A1) response.
  attribution: z.object({
    promo_uplift_pct: z.number().nullable(), // fitted/applied lift on promo days vs baseline
    price_elasticity: z.number().nullable(), // ε used this run (A2; null in A1)
    elasticity_r2: z.number().nullable().optional(),
    elasticity_n_obs: z.number().int().nullable().optional(),
    regressors_used: z.array(z.enum(['promo', 'price', 'payday', 'analog', 'cross'])).default([]),
  }).optional(),
});
export type ScmForecastSeriesResult = z.infer<typeof zForecastSeriesResult>;

export const zEngineItemError = z.object({
  ref: z.string(), // the series_id or item_code the failure belongs to
  code: z.string(), // SERIES_TOO_SHORT | MODEL_ERROR | SOLVER_TIMEOUT | …
  message: z.string(),
});
export type ScmEngineItemError = z.infer<typeof zEngineItemError>;

// docs/58 C2 — one reconciled result per hierarchy node (leaves AND aggregates), same shape as a
// series result but keyed by node_id (no per-node model). Leaf `sample_paths` are what the API
// explodes; aggregate nodes give the planner a coherent multi-level view.
export const zReconciledNodeResult = zForecastSeriesResult
  .omit({ series_id: true, model: true })
  .extend({
    node_id: z.string(),
    level: z.number().int().min(0), // 0 = leaf, increasing toward the root
    method: z.enum(['bottom_up', 'top_down_hist', 'mint']),
  });
export type ScmReconciledNodeResult = z.infer<typeof zReconciledNodeResult>;

export const zForecastResponse = z.object({
  contract_version: z.literal(SCM_ENGINE_CONTRACT_VERSION),
  request_id: z.string(),
  results: z.array(zForecastSeriesResult),
  reconciled: z.array(zReconciledNodeResult).default([]), // C2: empty unless reconciliation was requested
  errors: z.array(zEngineItemError).default([]), // per-series failures never fail the whole batch
});
export type ScmForecastResponse = z.infer<typeof zForecastResponse>;

// ── /v1/optimize ──────────────────────────────────────────────────────────────────────────────

export const zOptimizeItem = z.object({
  item_code: z.string().min(1),
  demand_scenarios: z.array(z.array(z.number())), // K × H ingredient-unit paths (post-BoM-explosion)
  // Straight from the FEFO cost layers: qty on hand by days of sellable life remaining.
  // remaining_days 0 = expires today (not sellable); the engine treats it as immediate waste.
  current_inventory: z.array(
    z.object({ remaining_days: z.number().int().min(0), qty: z.number().min(0) }),
  ),
  in_transit: z.array(z.object({ arrival_ds: zBizDay, qty: z.number().min(0) })),
  // mean_days 0 is legitimate — a morning market run that arrives the same day.
  lead_time: z.object({ mean_days: z.number().min(0), std_days: z.number().min(0) }),
  shelf_life_days: z.number().int().min(1).max(365),
  review_period_days: z.number().int().min(1).default(1),
  unit_cost: z.number().min(0),
  unit_price: z.number().min(0), // for ingredients this is the stockout-value proxy, not a retail price
  salvage_value: z.number().min(0).default(0),
  disposal_cost: z.number().min(0).default(0),
  goodwill_cost: z.number().min(0).default(0),
  holding_cost_per_day: z.number().min(0).default(0),
  moq: z.number().min(0).default(0),
  pack_size: z.number().positive().default(1),
  fixed_order_cost: z.number().min(0).default(0),
  waste_rate_prior: z.number().min(0).max(1).optional(), // from waste_log calibration (reporting prior)
});
export type ScmOptimizeItem = z.infer<typeof zOptimizeItem>;

export const zOptimizeRequest = z.object({
  contract_version: z.literal(SCM_ENGINE_CONTRACT_VERSION),
  request_id: z.string().min(1),
  start_ds: zBizDay, // plan day 0 — the time anchor that maps in_transit arrival dates ↔ day offsets
  horizon_days: z.number().int().min(1).max(56),
  items: z.array(zOptimizeItem).min(1).max(300),
  joint: z
    .object({
      budget: z.number().positive().optional(), // Σ purchase cost over the horizon, THB
      storage_capacity: z.number().positive().optional(), // Σ on-hand units cap per day (all items)
    })
    .optional(),
  time_budget_ms: z.number().int().default(20_000),
});
export type ScmOptimizeRequest = z.infer<typeof zOptimizeRequest>;

export const zOptimizeItemPlan = z.object({
  item_code: z.string(),
  method: z.enum(['newsvendor', 'milp']), // engine auto-tiers: MILP only when shelf life or MOQ/pack/fixed-cost bind
  orders: z.array(
    z.object({ order_ds: zBizDay, arrival_ds: zBizDay, qty: z.number().min(0), packs: z.number().min(0) }),
  ),
  order_up_to: z.array(z.number()), // per horizon day — dynamic order-up-to level S*
  safety_stock: z.array(z.number()), // per horizon day — S* − E[demand over protection period]
  expected: z.object({
    // All five come from ONE greedy-FEFO simulator run over the full scenario set, so newsvendor
    // and MILP plans are comparable and the MILP has an independent oracle.
    fill_rate: z.number().min(0).max(1),
    lost_sales_units: z.number().min(0),
    waste_units: z.number().min(0),
    waste_cost: z.number(), // (unit_cost − salvage + disposal) × waste_units
    profit: z.number(),
  }),
  solver: z.object({ status: z.string(), gap: z.number().nullable(), ms: z.number().int() }),
});
export type ScmOptimizeItemPlan = z.infer<typeof zOptimizeItemPlan>;

export const zOptimizeResponse = z.object({
  contract_version: z.literal(SCM_ENGINE_CONTRACT_VERSION),
  request_id: z.string(),
  plans: z.array(zOptimizeItemPlan),
  errors: z.array(zEngineItemError).default([]),
});
export type ScmOptimizeResponse = z.infer<typeof zOptimizeResponse>;

// ── /v1/optimize-network (docs/57 Track B · B2) ─────────────────────────────────────────────────
// Two-echelon (supplier → DC/central-kitchen → branch) guaranteed-service MEIO base-stock with risk
// pooling at the DC. ADDITIVE to the v2 contract — a NEW route; /v1/forecast and /v1/optimize are
// unchanged and back-compatible, so no version bump. One item at a time across the whole network
// (as /v1/optimize is chunked per item): the payload is a topology + per-branch demand paths + this
// item's cost params. Carries NO tenant identifiers and NO PII — node/lane codes + quantities only;
// the API validates topology (NETWORK_NOT_DAG etc.) and extracts demand under RLS before calling.

export const zNetworkNode = z.object({
  node_id: z.string().min(1), // opaque; the API maps it back to a supply_nodes row
  kind: z.enum(['supplier', 'central_kitchen', 'dc', 'branch']),
  echelon: z.number().int().min(0).max(2), // 0 supplier · 1 DC · 2 branch (leaf)
  service_time_out_days: z.number().min(0).optional(), // branch (end customer) = 0; DC = decision
  holding_cost_per_day: z.number().min(0).default(0), // per-unit holding at this node
  current_inventory: z
    .array(z.object({ remaining_days: z.number().int().min(0), qty: z.number().min(0) }))
    .default([]),
  in_transit: z.array(z.object({ arrival_ds: zBizDay, qty: z.number().min(0) })).default([]),
});
export type ScmNetworkNode = z.infer<typeof zNetworkNode>;

export const zNetworkLane = z.object({
  from_node: z.string().min(1),
  to_node: z.string().min(1),
  lead_time: z.object({ mean_days: z.number().min(0), std_days: z.number().min(0) }),
  unit_cost: z.number().min(0).default(0),
  moq: z.number().min(0).default(0),
  pack_size: z.number().positive().default(1),
  fixed_order_cost: z.number().min(0).default(0),
});
export type ScmNetworkLane = z.infer<typeof zNetworkLane>;

export const zDemandPath = z.object({
  node_id: z.string().min(1), // a leaf/branch node — must match a nodes[].node_id with echelon 2
  demand_scenarios: z.array(z.array(z.number())), // K × H post-BoM-explosion paths (scenario-consistent)
});
export type ScmDemandPath = z.infer<typeof zDemandPath>;

export const zNetworkAllocationPolicy = z.object({
  method: z.enum(['proportional', 'fair_share', 'priority']).default('proportional'),
  priorities: z.record(z.string(), z.number()).optional(), // node_id → priority (higher served first)
});
export type ScmNetworkAllocationPolicy = z.infer<typeof zNetworkAllocationPolicy>;

export const zOptimizeNetworkRequest = z.object({
  contract_version: z.literal(SCM_ENGINE_CONTRACT_VERSION),
  request_id: z.string().min(1),
  start_ds: zBizDay,
  horizon_days: z.number().int().min(1).max(56),
  item_code: z.string().min(1),
  shelf_life_days: z.number().int().min(1).max(365),
  review_period_days: z.number().int().min(1).default(1),
  unit_price: z.number().min(0), // stockout-value proxy for ingredients
  unit_cost: z.number().min(0).default(0),
  salvage_value: z.number().min(0).default(0),
  disposal_cost: z.number().min(0).default(0),
  goodwill_cost: z.number().min(0).default(0),
  service_level: z.number().min(0.5).max(0.999).default(0.95), // end-customer target
  nodes: z.array(zNetworkNode).min(1),
  lanes: z.array(zNetworkLane).min(1),
  demand_paths: z.array(zDemandPath).min(1),
  allocation: zNetworkAllocationPolicy.default({ method: 'proportional' }),
  time_budget_ms: z.number().int().default(20_000),
});
export type ScmOptimizeNetworkRequest = z.infer<typeof zOptimizeNetworkRequest>;

export const zNetworkNodePlan = z.object({
  node_id: z.string(),
  echelon: z.number().int(),
  service_time_out_days: z.number(), // the GSM decision at this node
  base_stock: z.array(z.number()), // per horizon day — ECHELON base-stock (own + all downstream)
  installation_base_stock: z.array(z.number()), // per horizon day — installation (own) base-stock
  safety_stock: z.array(z.number()), // per horizon day
  orders: z.array(
    z.object({
      order_ds: zBizDay,
      arrival_ds: zBizDay,
      from_node: z.string(),
      qty: z.number().min(0),
      packs: z.number().min(0),
    }),
  ),
  expected: z.object({
    fill_rate: z.number().min(0).max(1),
    lost_sales_units: z.number().min(0),
    waste_units: z.number().min(0),
    waste_cost: z.number(),
    profit: z.number(),
  }),
});
export type ScmNetworkNodePlan = z.infer<typeof zNetworkNodePlan>;

export const zNetworkAllocationLine = z.object({
  ds: zBizDay,
  from_node: z.string(),
  to_node: z.string(),
  requested: z.number().min(0),
  allocated: z.number().min(0),
  shortfall: z.number().min(0),
});
export type ScmNetworkAllocationLine = z.infer<typeof zNetworkAllocationLine>;

export const zOptimizeNetworkResponse = z.object({
  contract_version: z.literal(SCM_ENGINE_CONTRACT_VERSION),
  request_id: z.string(),
  node_plans: z.array(zNetworkNodePlan),
  allocations: z.array(zNetworkAllocationLine).default([]), // emitted only on projected DC shortage
  pooling: z.object({
    independent_safety_units: z.number().min(0), // Σ_i z·σ_i·√P (each branch buffers alone)
    pooled_safety_units: z.number().min(0), // z·σ_DC·√P (buffer pooled at the DC)
    pooling_benefit_pct: z.number(), // (independent − pooled)/independent · 100; ≥ 0, 0 only at ρ≡1
  }),
  errors: z.array(zEngineItemError).default([]),
});
export type ScmOptimizeNetworkResponse = z.infer<typeof zOptimizeNetworkResponse>;

// New engine item/error codes (B2): NETWORK_NOT_DAG, ECHELON_DEPTH_EXCEEDED, LANE_ENDPOINTS_INVALID,
// UNREACHABLE_BRANCH, NEGATIVE_NET_LEAD_TIME — the API rejects malformed topology before calling out.

// Non-200 engine responses use the ERP error envelope. Codes: BAD_SIGNATURE (401),
// ENGINE_NOT_CONFIGURED (503), VALIDATION_ERROR / CONTRACT_VERSION_MISMATCH (422).
export const zEngineErrorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ScmEngineErrorEnvelope = z.infer<typeof zEngineErrorEnvelope>;
