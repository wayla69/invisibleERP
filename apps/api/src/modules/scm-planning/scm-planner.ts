import type { DemandForecastService } from '../demand-ml/demand-forecast.service';
import { ymd } from '../../database/queries';
import { addDaysYmd } from '../demand-ml/forecast-algorithms';
import type {
  BranchPlanDraft, DenseSeries, ExtractedTenantData, ItemParams, RecipeEdge, StockPosition,
  SuggestedLine,
} from './scm-planning.types';

// docs/54 — BoM explosion + the in-process fallback planner.
//
// Explosion (§3.3) is the ONE place menu-level demand becomes ingredient demand, and it must be
// applied per SCENARIO, never to quantiles: P95 of a sum ≠ sum of P95s, and per-path summation is
// what preserves the correlation that makes a Songkran spike lift every dish at once. The engine
// returns K×H paths precisely so this function can be a linear map over them.

/** Sum menu sample paths into ingredient sample paths for one branch. Returns itemId → K×H. */
export function explodePaths(
  menuPaths: Map<string, number[][]>, // menu sku → K×H
  recipes: RecipeEdge[],
  wantedItems: Set<string>,
): Map<string, number[][]> {
  const bySku = new Map<string, RecipeEdge[]>();
  for (const e of recipes) {
    if (!wantedItems.has(e.ingredientItemId)) continue;
    const arr = bySku.get(e.menuSku) ?? [];
    arr.push(e);
    bySku.set(e.menuSku, arr);
  }

  const out = new Map<string, number[][]>();
  for (const [sku, paths] of menuPaths) {
    const edges = bySku.get(sku);
    if (!edges?.length || !paths.length) continue;
    for (const edge of edges) {
      const acc = out.get(edge.ingredientItemId);
      if (!acc) {
        out.set(edge.ingredientItemId, paths.map((row) => row.map((v) => v * edge.grossQtyPerUnit)));
        continue;
      }
      // Same scenario index ω across menu items — that is the correlation-preserving step.
      for (let w = 0; w < Math.min(acc.length, paths.length); w++) {
        const src = paths[w]!;
        const dst = acc[w]!;
        for (let t = 0; t < Math.min(dst.length, src.length); t++) {
          dst[t] = dst[t]! + src[t]! * edge.grossQtyPerUnit;
        }
      }
    }
  }
  return out;
}

/** Deterministic point-forecast explosion (fallback path — no scenarios available). */
export function explodePoints(
  menuPoints: Map<string, number[]>,
  recipes: RecipeEdge[],
  wantedItems: Set<string>,
): Map<string, number[]> {
  const asPaths = new Map<string, number[][]>();
  for (const [sku, values] of menuPoints) asPaths.set(sku, [values]);
  const exploded = explodePaths(asPaths, recipes, wantedItems);
  return new Map([...exploded].map(([item, paths]) => [item, paths[0] ?? []]));
}

const roundToPack = (raw: number, p: ItemParams): number => {
  if (raw <= 1e-9) return 0;
  let qty = raw;
  if (p.orderMultiple > 0) qty = Math.ceil(qty / p.orderMultiple - 1e-9) * p.orderMultiple;
  if (p.minOrderQty > 0) qty = Math.max(qty, p.minOrderQty);
  return Math.round(qty * 1000) / 1000;
};

/** Normal-approximation z for a service level — fallback only (the engine uses empirical quantiles). */
const zFor = (serviceLevel: number): number => {
  const table: [number, number][] = [
    [0.5, 0], [0.8, 0.84], [0.85, 1.04], [0.9, 1.28], [0.95, 1.65], [0.975, 1.96], [0.99, 2.33],
  ];
  let z = 1.65;
  for (const [p, v] of table) if (serviceLevel >= p) z = v;
  return z;
};

/**
 * In-process fallback planner — used when the engine is unconfigured or unreachable.
 *
 * demand-ml's planForecast is tenant-wide and retail-only, so its LEVEL would systematically
 * under-count dine-in-heavy ingredients. We therefore use it only for the SHAPE (which algorithm,
 * what daily profile) and rescale it to each branch's share of the FULL union series this module
 * extracted — then cap the order by shelf life, which is the perishable guard the MILP does properly.
 */
export class ScmFallbackPlanner {
  constructor(private readonly demandMl?: DemandForecastService) {}

  async plan(
    tenantId: number | null,
    data: ExtractedTenantData,
    branchIds: (number | null)[],
  ): Promise<{ drafts: BranchPlanDraft[]; forecasts: Map<string, number[]>; method: string }> {
    const horizon = data.settings.horizon_days;
    const drafts: BranchPlanDraft[] = [];
    const forecasts = new Map<string, number[]>();
    let method = 'fallback:dow';

    // Recent per-(branch, sku) daily means from the union series (this module's own extraction).
    const recent = new Map<string, number>();
    const skuTotals = new Map<string, number>();
    for (const s of data.series) {
      const tail = s.values.slice(-28);
      const open = tail.filter((_v, i) => !s.closedDays.includes(addDaysYmd(s.startDate, s.values.length - tail.length + i)));
      const mean = open.length ? open.reduce((a, b) => a + b, 0) / open.length : 0;
      recent.set(`${s.branchId ?? ''}|${s.itemId}`, mean);
      skuTotals.set(s.itemId, (skuTotals.get(s.itemId) ?? 0) + mean);
    }

    // Ask demand-ml for the tenant-level shape per menu sku; scale it by each branch's share.
    const shapes = new Map<string, number[]>();
    if (this.demandMl) {
      for (const sku of new Set(data.series.map((s) => s.itemId))) {
        const res = await this.demandMl.planForecast(sku, horizon, tenantId).catch(() => null);
        if (res?.forecast?.length) {
          shapes.set(sku, res.forecast);
          method = `fallback:${res.algorithm}`;
        }
      }
    }

    for (const branchId of branchIds) {
      const menuPoints = new Map<string, number[]>();
      for (const s of data.series.filter((x) => x.branchId === branchId)) {
        const share = (skuTotals.get(s.itemId) ?? 0) > 0
          ? (recent.get(`${branchId ?? ''}|${s.itemId}`) ?? 0) / skuTotals.get(s.itemId)!
          : 1 / Math.max(1, branchIds.length);
        const shape = shapes.get(s.itemId);
        const daily = recent.get(`${branchId ?? ''}|${s.itemId}`) ?? 0;
        const closedAhead = new Set(data.settings.closed_weekdays);
        const today = ymd();
        const series = shape
          ? shape.map((v) => v * share)
          : Array.from({ length: horizon }, () => daily);
        // Force closed days to zero — the branch cannot sell on them.
        const zeroed = series.map((v, i) => {
          const day = addDaysYmd(today, i + 1);
          const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
          const closed = closedAhead.has(dow)
            || data.settings.closures.some((c) => c.date === day && (c.branch_id == null || c.branch_id === branchId));
          return closed ? 0 : Math.max(0, v);
        });
        menuPoints.set(s.itemId, zeroed);
      }

      const wanted = new Set(data.ingredientIds);
      const ingredientDemand = explodePoints(menuPoints, data.recipes, wanted);
      const lines: SuggestedLine[] = [];

      for (const [itemId, daily] of ingredientDemand) {
        const p = data.params.get(itemId);
        if (!p) continue;
        forecasts.set(`${branchId ?? ''}|${itemId}`, daily);
        const pos = data.stock.find((s) => s.branchId === branchId && s.itemId === itemId);
        const onHand = pos?.onHand ?? 0;
        const inTransitQty = (pos?.inTransit ?? []).reduce((a, b) => a + b.qty, 0);

        // Cover the protection period (lead time + one review), with normal-approximation safety.
        const protection = Math.max(1, Math.ceil(p.leadTimeMean) + 1);
        const window = daily.slice(0, Math.min(protection, daily.length));
        const meanDaily = daily.length ? daily.reduce((a, b) => a + b, 0) / daily.length : 0;
        const need = window.reduce((a, b) => a + b, 0);
        const variance = window.length > 1
          ? window.reduce((a, b) => a + (b - meanDaily) ** 2, 0) / (window.length - 1)
          : meanDaily;
        const safety = zFor(p.serviceLevel) * Math.sqrt(Math.max(variance, 0) * Math.max(window.length, 1));
        let target = need + safety;

        // Shelf-life cap: never buy more than the item can be sold within its own life.
        const clamps: string[] = [];
        if (p.shelfLifeDays != null && meanDaily > 0) {
          const cap = p.shelfLifeDays * meanDaily;
          if (target > cap) { target = cap; clamps.push('shelf_life'); }
        }
        if (p.maxStockQty != null && target > p.maxStockQty) {
          target = p.maxStockQty;
          clamps.push('max_stock');
        }

        const qty = roundToPack(Math.max(0, target - onHand - inTransitQty), p);
        if (qty <= 0) continue;
        const expiring = (pos?.layers ?? [])
          .filter((l) => l.remaining_days <= Math.ceil(p.leadTimeMean) + 1)
          .reduce((a, b) => a + b.qty, 0);
        lines.push({
          itemId, qty, reason: 'par_fallback', unitCost: p.unitCost, vendorId: p.vendorId,
          onHand, expiring, inTransit: inTransitQty,
          coverageDays: meanDaily > 0 ? (onHand + inTransitQty + qty) / meanDaily : null,
          stockoutRiskPct: null,
          detail: {
            method, mean_daily: Math.round(meanDaily * 1000) / 1000,
            protection_days: protection, safety_stock: Math.round(safety * 1000) / 1000,
            clamped: clamps.length ? clamps : undefined,
            note: 'in-process fallback — the external engine was unavailable or disabled',
          },
        });
      }
      if (lines.length) {
        drafts.push({ branchId, lines, expected: { fill_rate: null, waste_cost: null, stockout_cost: null } });
      }
    }
    return { drafts, forecasts, method };
  }
}

/** Shared helpers the facade uses for both engine and fallback plans. */
export const planHelpers = {
  roundToPack,
  /** Guard against a buggy/compromised engine planting absurd quantities into a Draft plan. */
  clampQty(qty: number, p: ItemParams): { qty: number; clamped: boolean } {
    if (!Number.isFinite(qty) || qty < 0) return { qty: 0, clamped: true };
    const ceiling = p.maxStockQty != null ? p.maxStockQty * 2 : Number.POSITIVE_INFINITY;
    if (qty > ceiling) return { qty: ceiling, clamped: true };
    return { qty, clamped: false };
  },
  seriesFor(series: DenseSeries[], branchId: number | null) {
    return series.filter((s) => s.branchId === branchId);
  },
  stockFor(stock: StockPosition[], branchId: number | null, itemId: string) {
    return stock.find((s) => s.branchId === branchId && s.itemId === itemId);
  },
  /** Mean over all values of a K×H sample-path grid (docs/58 C2 coherence check). */
  meanOfPaths(paths: number[][]): number {
    let sum = 0;
    let n = 0;
    for (const row of paths) for (const v of row) { sum += v; n++; }
    return n > 0 ? sum / n : 0;
  },
};
