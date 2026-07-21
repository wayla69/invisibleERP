// docs/54 — shared types + job identifiers for the SCM planning module.
// Pure types and consts only (no DI, no imports from sibling services) so any file in the module can
// import this without creating a cycle. Wire types for the Python engine come from @ierp/shared.

export const SCM_NIGHTLY_JOB = 'scm_nightly_plan';
export const SCM_REPLAN_JOB = 'scm_replan';

export const PLAN_STATUS = {
  draft: 'Draft',
  pending: 'PendingApproval',
  approved: 'Approved',
  rejected: 'Rejected',
  converted: 'Converted',
  cancelled: 'Cancelled',
} as const;

// The scheduler creates nightly runs, so a plan's `created_by` can be a system string. Maker-checker
// binds to the human who SUBMITTED it (see ScmPlanningService.approvePlan) — never to this.
export const SYSTEM_ACTOR = 'system:scheduler';

export interface ScmSettingsView {
  horizon_days: number;
  service_level: number;
  sample_paths: number;
  lookback_days: number;
  closed_weekdays: number[]; // 0=Sun..6=Sat, business TZ
  closures: { date: string; branch_id?: number | null; reason?: string }[];
  dine_in_branch_id: number | null;
  spike_ewma_alpha: number;
  spike_z_threshold: number;
  spike_cusum_k: number;
  spike_cusum_h: number;
  spike_min_qty: number;
  spike_cooldown_hours: number;
  auto_replan: boolean;
  engine_enabled: boolean;
}

/** A planning unit: one branch of one tenant. branchId null = the untagged/HQ unit. */
export interface SeriesKey {
  branchId: number | null;
  itemId: string;
}

/** Dense daily series (0-filled on open days) for one (branch, menu sku). */
export interface DenseSeries extends SeriesKey {
  startDate: string; // business day of values[0]
  values: number[];
  closedDays: string[]; // business days inside the window the branch was shut
}

/** One flattened recipe edge: how much of an ingredient one unit of a menu sku consumes. */
export interface RecipeEdge {
  menuSku: string;
  ingredientItemId: string;
  ingredientDescription: string | null;
  uom: string | null;
  grossQtyPerUnit: number; // qtyPer / (yieldFactor − wasteFactor) / yieldQty
}

/** Current stock for one (branch, item), bucketed by remaining sellable life. */
export interface StockPosition extends SeriesKey {
  onHand: number;
  avgCost: number;
  /** remaining_days → qty. Straight from the FEFO cost layers; index 0 = already dead stock. */
  layers: { remaining_days: number; qty: number }[];
  inTransit: { arrival_ds: string; qty: number }[];
}

/** Resolved planning parameters for one item (policy override → item master → settings default). */
export interface ItemParams {
  itemId: string;
  description: string | null;
  uom: string | null;
  shelfLifeDays: number | null;
  leadTimeMean: number;
  leadTimeStd: number;
  minOrderQty: number;
  orderMultiple: number;
  fixedOrderCost: number;
  holdingCostPerDay: number;
  unitCost: number;
  unitPrice: number;
  goodwillCost: number;
  disposalCost: number;
  salvageValue: number;
  serviceLevel: number;
  maxStockQty: number | null;
  vendorId: number | null;
  wasteRatePrior: number | null;
}

export interface ExtractedTenantData {
  settings: ScmSettingsView;
  branchIds: (number | null)[];
  series: DenseSeries[]; // menu-level, per branch
  recipes: RecipeEdge[];
  stock: StockPosition[];
  params: Map<string, ItemParams>; // itemId → resolved params
  holidays: { name: string; ds: string }[];
  ingredientIds: string[];
  branchNullShare: number; // fraction of demand that landed in the untagged unit (config warning)
}

export interface PlanRunResult {
  run_id: number;
  run_no: string;
  engine: 'external' | 'fallback';
  status: string;
  plans: number;
  lines: number;
  series: number;
  skipped?: boolean;
}

/** One optimizer suggestion, before it becomes a plan line. */
export interface SuggestedLine {
  itemId: string;
  qty: number;
  reason: 'optimize' | 'par_fallback' | 'spike';
  unitCost: number;
  vendorId: number | null;
  onHand: number;
  expiring: number;
  inTransit: number;
  coverageDays: number | null;
  stockoutRiskPct: number | null;
  detail: Record<string, unknown>;
}

export interface BranchPlanDraft {
  branchId: number | null;
  lines: SuggestedLine[];
  expected: {
    fill_rate: number | null;
    waste_cost: number | null;
    stockout_cost: number | null;
  };
}
