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

export const SCM_ENGINE_CONTRACT_VERSION = '1';

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

export const zSeriesInput = z.object({
  series_id: z.string().min(1), // opaque to the engine; the API maps it back to (branch, menu sku)
  history: z.array(zDemandPoint).min(1), // dense daily series, ascending, zeros filled on open days
  class_hint: z.enum(['auto', 'smooth', 'intermittent', 'lumpy', 'short']).default('auto'),
});
export type ScmSeriesInput = z.infer<typeof zSeriesInput>;

export const zForecastRequest = z.object({
  contract_version: z.literal(SCM_ENGINE_CONTRACT_VERSION),
  request_id: z.string().min(1), // idempotency + deterministic RNG seed (same request ⇒ same paths)
  horizon_days: z.number().int().min(1).max(56),
  scenario_count: z.number().int().min(10).max(100).default(50),
  quantiles: z.array(z.number().min(0).max(1)).default([0.1, 0.5, 0.9]),
  holidays: z.array(zHolidayEvent), // Thai national + tenant promo events — the API owns the calendar
  closures: z.array(zBizDay).default([]), // branch closed days, past (excluded from fit) + future (forced 0)
  payday_regressor: z.boolean().default(true), // Thai payday effect: month-end/1st–2nd/15th–17th
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
});
export type ScmForecastSeriesResult = z.infer<typeof zForecastSeriesResult>;

export const zEngineItemError = z.object({
  ref: z.string(), // the series_id or item_code the failure belongs to
  code: z.string(), // SERIES_TOO_SHORT | MODEL_ERROR | SOLVER_TIMEOUT | …
  message: z.string(),
});
export type ScmEngineItemError = z.infer<typeof zEngineItemError>;

export const zForecastResponse = z.object({
  contract_version: z.literal(SCM_ENGINE_CONTRACT_VERSION),
  request_id: z.string(),
  results: z.array(zForecastSeriesResult),
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

// Non-200 engine responses use the ERP error envelope. Codes: BAD_SIGNATURE (401),
// ENGINE_NOT_CONFIGURED (503), VALIDATION_ERROR / CONTRACT_VERSION_MISMATCH (422).
export const zEngineErrorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ScmEngineErrorEnvelope = z.infer<typeof zEngineErrorEnvelope>;
