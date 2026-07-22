import { BadRequestException } from '@nestjs/common';
import { and, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import {
  branches, custPosItems, custPosSales, dineInOrderItems, dineInOrders, menuRecipeLines,
  menuRecipes, scmSettings,
} from '../../database/schema';
import { n, ymd } from '../../database/queries';
import { addDaysYmd, TH_FIXED_HOLIDAYS } from '../demand-ml/forecast-algorithms';
import type { JwtUser } from '../../common/decorators';
import { ScmStockExtractService } from './scm-extract-stock.service';
import { ScmPromoExtractService } from './scm-promo-extract.service';
import type {
  DenseSeries, ExtractedTenantData, RecipeEdge, ScmSettingsView,
} from './scm-planning.types';

// docs/54 — pulls everything the planner needs out of the ERP, under the caller's RLS context.
// Plain class built positionally in the facade's ctor body (repo convention for db-only helpers).
//
// THE LOAD-BEARING RULE (§4.3): dine-in checkout writes EVERY non-voided order line — including the
// ฿0 buffet lines — into cust_pos_items (DineInSaleService.buildSale). A naive UNION of the POS and
// restaurant tables therefore DOUBLE-COUNTS every dine-in dish. Demand is partitioned by CHANNEL:
// the retail leg excludes dine-in/split sales, and the restaurant leg reads the kitchen tables
// directly (which also captures open orders that have not checked out yet).
//
// The partition keys off payment_method 'Dine-in'/'Split' — the literals DineInSaleService.buildSale
// writes. They appear inline in the SQL below and in scm-spike.service.ts; the `scm` harness pins the
// rule end-to-end, so a checkout refactor that renames them fails CI rather than silently doubling.

// Business day for a dine-in line: fixed-offset arithmetic, never a named timezone and never the
// server's local ::date — see common/bizdate.ts. BUSINESS_TZ_OFFSET_MIN is the single source (420).
const tzOffsetMin = (): number => {
  const raw = Number(process.env.BUSINESS_TZ_OFFSET_MIN ?? 420);
  return Number.isFinite(raw) ? Math.trunc(raw) : 420;
};

// The offset is inlined as a LITERAL, not interpolated. Drizzle binds an interpolated value as a
// parameter, and the SAME fragment used in both SELECT and GROUP BY is emitted with DIFFERENT
// placeholders ($1 vs $4) — which Postgres does not recognise as the same expression, so the query
// dies with 42803 "must appear in the GROUP BY clause". sql.raw is safe here precisely because the
// value is a validated integer from server env, never user input.
const bizDayExpr = () => sql<string>`to_char((coalesce(${dineInOrderItems.servedAt}, ${dineInOrderItems.firedAt}, ${dineInOrderItems.createdAt}) + make_interval(mins => ${sql.raw(String(tzOffsetMin()))})), 'YYYY-MM-DD')`;

const SETTINGS_DEFAULTS: ScmSettingsView = {
  horizon_days: 14, service_level: 0.95, sample_paths: 50, lookback_days: 400,
  closed_weekdays: [], closures: [], dine_in_branch_id: null,
  spike_ewma_alpha: 0.2, spike_z_threshold: 3, spike_cusum_k: 0.5, spike_cusum_h: 4,
  spike_min_qty: 5, spike_cooldown_hours: 48, auto_replan: false, engine_enabled: true,
};

const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export class ScmExtractService {
  private readonly stock: ScmStockExtractService;
  private readonly promo: ScmPromoExtractService;

  constructor(private readonly db: DrizzleDb) {
    this.stock = new ScmStockExtractService(db);
    this.promo = new ScmPromoExtractService(db);
  }

  // ── settings ────────────────────────────────────────────────────────────────
  // Tenant row, else the NULL-tenant system row, else code defaults. Never RLS+limit(1) alone —
  // an Admin/HQ request bypasses RLS and would otherwise read a foreign tenant's row (EXP-12 pattern).
  async settings(tenantId: number | null): Promise<ScmSettingsView> {
    const [row] = tenantId != null
      ? await this.db.select().from(scmSettings).where(eq(scmSettings.tenantId, tenantId)).limit(1)
      : await this.db.select().from(scmSettings).where(isNull(scmSettings.tenantId)).limit(1);
    if (!row) return { ...SETTINGS_DEFAULTS };
    return {
      horizon_days: Number(row.horizonDays), service_level: n(row.serviceLevel),
      sample_paths: Number(row.samplePaths), lookback_days: Number(row.lookbackDays),
      closed_weekdays: asArray<number>(row.closedWeekdays),
      closures: asArray<{ date: string; branch_id?: number | null; reason?: string }>(row.closures),
      dine_in_branch_id: row.dineInBranchId ?? null,
      spike_ewma_alpha: n(row.spikeEwmaAlpha), spike_z_threshold: n(row.spikeZThreshold),
      spike_cusum_k: n(row.spikeCusumK), spike_cusum_h: n(row.spikeCusumH),
      spike_min_qty: n(row.spikeMinQty), spike_cooldown_hours: Number(row.spikeCooldownHours),
      auto_replan: !!row.autoReplan, engine_enabled: !!row.engineEnabled,
    };
  }

  async upsertSettings(dto: Record<string, unknown>, user: JwtUser): Promise<ScmSettingsView> {
    const cur = await this.settings(user.tenantId ?? null);
    const num = (key: string, lo: number, hi: number, fallback: number) => {
      const v = dto[key];
      if (v == null) return fallback;
      const x = Number(v);
      if (!Number.isFinite(x) || x < lo || x > hi) {
        throw new BadRequestException({
          code: 'BAD_SETTING', message: `${key} must be between ${lo} and ${hi}`,
          messageTh: `ค่า ${key} ต้องอยู่ระหว่าง ${lo} ถึง ${hi}`,
        });
      }
      return x;
    };
    const vals = {
      horizonDays: Math.round(num('horizon_days', 1, 56, cur.horizon_days)),
      serviceLevel: String(num('service_level', 0.5, 0.9999, cur.service_level)),
      samplePaths: Math.round(num('sample_paths', 10, 100, cur.sample_paths)),
      lookbackDays: Math.round(num('lookback_days', 28, 1095, cur.lookback_days)),
      closedWeekdays: dto.closed_weekdays ?? cur.closed_weekdays,
      closures: dto.closures ?? cur.closures,
      dineInBranchId: dto.dine_in_branch_id === undefined
        ? cur.dine_in_branch_id : (dto.dine_in_branch_id as number | null),
      spikeEwmaAlpha: String(num('spike_ewma_alpha', 0.01, 0.9, cur.spike_ewma_alpha)),
      spikeZThreshold: String(num('spike_z_threshold', 1, 10, cur.spike_z_threshold)),
      spikeCusumK: String(num('spike_cusum_k', 0, 5, cur.spike_cusum_k)),
      spikeCusumH: String(num('spike_cusum_h', 1, 20, cur.spike_cusum_h)),
      spikeMinQty: String(num('spike_min_qty', 0, 1e6, cur.spike_min_qty)),
      spikeCooldownHours: Math.round(num('spike_cooldown_hours', 1, 720, cur.spike_cooldown_hours)),
      autoReplan: dto.auto_replan === undefined ? cur.auto_replan : !!dto.auto_replan,
      engineEnabled: dto.engine_enabled === undefined ? cur.engine_enabled : !!dto.engine_enabled,
      updatedBy: user.username, updatedAt: new Date(),
    };
    const [existing] = user.tenantId != null
      ? await this.db.select().from(scmSettings).where(eq(scmSettings.tenantId, user.tenantId)).limit(1)
      : await this.db.select().from(scmSettings).where(isNull(scmSettings.tenantId)).limit(1);
    if (existing) await this.db.update(scmSettings).set(vals).where(eq(scmSettings.id, existing.id));
    else await this.db.insert(scmSettings).values({ tenantId: user.tenantId ?? null, ...vals });
    return this.settings(user.tenantId ?? null);
  }

  // ── demand history ──────────────────────────────────────────────────────────

  /** Retail leg — POS sales EXCLUDING dine-in/split (those are counted from the kitchen tables). */
  private async retailDemand(tenantId: number | null, fromYmd: string) {
    const rows: { branch: number | null; item: string | null; d: string; q: string }[] =
      await this.db.select({
        branch: custPosSales.branchId,
        item: custPosItems.itemId,
        d: sql<string>`${custPosSales.saleDate}`,
        q: sql<string>`coalesce(sum(${custPosItems.qty}), 0)`,
      })
        .from(custPosItems)
        .innerJoin(custPosSales, eq(custPosItems.saleId, custPosSales.id))
        .where(and(
          tenantId != null ? eq(custPosSales.tenantId, tenantId) : sql`true`,
          ne(custPosSales.status, 'Voided'),
          gte(custPosSales.saleDate, fromYmd),
          // The partition: anything rung as a dine-in/split settlement is the restaurant leg's.
          sql`coalesce(${custPosSales.paymentMethod}, 'Cash') not in ('Dine-in', 'Split')`,
        ))
        .groupBy(custPosSales.branchId, custPosItems.itemId, custPosSales.saleDate);
    return rows;
  }

  /**
   * Restaurant leg — kitchen truth: every non-voided dine-in line, buffet (฿0) included, dated on
   * the business day it was served/fired. dine_in_orders has NO branch column, so everything is
   * attributed to settings.dine_in_branch_id (else the NULL-branch unit).
   */
  private async dineInDemand(tenantId: number | null, fromYmd: string, branchId: number | null) {
    const day = bizDayExpr();
    const rows: { item: string | null; d: string; q: string }[] = await this.db.select({
      item: dineInOrderItems.itemId,
      d: day,
      q: sql<string>`coalesce(sum(${dineInOrderItems.qty}), 0)`,
    })
      .from(dineInOrderItems)
      .innerJoin(dineInOrders, eq(dineInOrderItems.orderId, dineInOrders.id))
      .where(and(
        tenantId != null ? eq(dineInOrderItems.tenantId, tenantId) : sql`true`,
        isNull(dineInOrderItems.voidedAt),
        ne(dineInOrderItems.kdsStatus, 'voided'),
        sql`${day} >= ${fromYmd}`,
      ))
      .groupBy(dineInOrderItems.itemId, day);
    return rows.map((r) => ({ branch: branchId, item: r.item, d: r.d, q: r.q }));
  }

  /** Dense per-(branch, menu sku) daily series. Only skus that have a recipe or menu row count. */
  async menuDailySeries(
    tenantId: number | null,
    settings: ScmSettingsView,
    knownSkus: Set<string>,
  ): Promise<{ series: DenseSeries[]; branchNullShare: number }> {
    const today = ymd();
    const from = addDaysYmd(today, -Math.max(28, settings.lookback_days));
    const [retail, dineIn] = await Promise.all([
      this.retailDemand(tenantId, from),
      this.dineInDemand(tenantId, from, settings.dine_in_branch_id),
    ]);

    const byKey = new Map<string, Map<string, number>>();
    let total = 0;
    let untagged = 0;
    for (const r of [...retail, ...dineIn]) {
      if (!r.item || !knownSkus.has(r.item)) continue; // charge refs / synthetic lines are not demand
      const qty = Number(r.q);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const key = `${r.branch ?? ''}|${r.item}`;
      const days = byKey.get(key) ?? new Map<string, number>();
      days.set(r.d, (days.get(r.d) ?? 0) + qty);
      byKey.set(key, days);
      total += qty;
      if (r.branch == null) untagged += qty;
    }

    const series: DenseSeries[] = [];
    for (const [key, days] of byKey) {
      const [branchRaw, itemId] = key.split('|');
      const branchId = branchRaw ? Number(branchRaw) : null;
      const sorted = [...days.keys()].sort();
      const start = sorted[0]!;
      const closed = this.closedDays(settings, branchId, start, today);
      const values: number[] = [];
      for (let d = start; d <= today; d = addDaysYmd(d, 1)) values.push(days.get(d) ?? 0);
      if (values.length < 14) continue; // too short to plan on — the fallback par logic covers it
      series.push({ branchId, itemId: itemId!, startDate: start, values, closedDays: closed });
    }
    return { series, branchNullShare: total > 0 ? untagged / total : 0 };
  }

  /** Business days the branch was shut — excluded from the fit, forced to 0 in the forecast. */
  private closedDays(s: ScmSettingsView, branchId: number | null, from: string, to: string): string[] {
    const out = new Set<string>();
    for (const c of s.closures) {
      if (c.branch_id == null || c.branch_id === branchId) out.add(c.date);
    }
    if (s.closed_weekdays.length) {
      for (let d = from; d <= to; d = addDaysYmd(d, 1)) {
        if (s.closed_weekdays.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) out.add(d);
      }
    }
    return [...out].sort();
  }

  /** Future closures for the horizon (the engine forces those days to zero demand). */
  futureClosures(s: ScmSettingsView, branchId: number | null, horizon: number): string[] {
    const today = ymd();
    return this.closedDays(s, branchId, today, addDaysYmd(today, horizon + 1));
  }

  /** Thai fixed-date public holidays expanded across the window (docs/54: the API owns the calendar). */
  holidays(fromYmd: string, toYmd: string): { name: string; ds: string }[] {
    const out: { name: string; ds: string }[] = [];
    for (let d = fromYmd; d <= toYmd; d = addDaysYmd(d, 1)) {
      if (TH_FIXED_HOLIDAYS.has(d.slice(5))) out.push({ name: `th_${d.slice(5)}`, ds: d });
    }
    return out;
  }

  // ── recipes ─────────────────────────────────────────────────────────────────

  /** Flattened menu→ingredient edges. gross = qtyPer / (yield − waste) / yieldQty. */
  async recipeMatrix(tenantId: number | null): Promise<RecipeEdge[]> {
    const rows = await this.db.select({
      sku: menuRecipes.sku,
      yieldQty: menuRecipes.yieldQty,
      ingredientItemId: menuRecipeLines.ingredientItemId,
      ingredientDescription: menuRecipeLines.ingredientDescription,
      uom: menuRecipeLines.uom,
      qtyPer: menuRecipeLines.qtyPer,
      yieldFactor: menuRecipeLines.yieldFactor,
      wasteFactor: menuRecipeLines.wasteFactor,
    })
      .from(menuRecipeLines)
      .innerJoin(menuRecipes, eq(menuRecipeLines.recipeId, menuRecipes.id))
      .where(and(
        tenantId != null ? eq(menuRecipes.tenantId, tenantId) : sql`true`,
        eq(menuRecipes.active, true),
      ));

    const edges: RecipeEdge[] = [];
    for (const r of rows) {
      const net = n(r.yieldFactor) - n(r.wasteFactor);
      const yieldQty = n(r.yieldQty) || 1;
      if (net <= 0) continue; // a 100%-waste line would divide by zero — skip, don't crash the run
      edges.push({
        menuSku: r.sku,
        ingredientItemId: r.ingredientItemId,
        ingredientDescription: r.ingredientDescription ?? null,
        uom: r.uom ?? null,
        grossQtyPerUnit: n(r.qtyPer) / net / yieldQty,
      });
    }
    return edges;
  }

  // ── supply side (delegated) ─────────────────────────────────────────────────
  // Stock / in-transit / lead times / item params live in ScmStockExtractService so neither half
  // grows into a god service; these thin delegators keep the facade's call sites unchanged.

  stockPositions(tenantId: number | null, itemIds: string[], branchIds: (number | null)[]) {
    return this.stock.stockPositions(tenantId, itemIds, branchIds);
  }

  itemParams(
    tenantId: number | null,
    itemIds: string[],
    settings: ScmSettingsView,
    branchId: number | null = null,
  ) {
    return this.stock.itemParams(tenantId, itemIds, settings, branchId);
  }

  suggestShelfLife(tenantId: number | null) {
    return this.stock.suggestShelfLife(tenantId);
  }

  /** Branch ids that actually sell — the planning units for this tenant. */
  async branchIds(tenantId: number | null, settings: ScmSettingsView): Promise<(number | null)[]> {
    const rows = await this.db.select({ id: branches.id })
      .from(branches)
      .where(and(
        tenantId != null ? eq(branches.tenantId, tenantId) : sql`true`,
        eq(branches.active, true),
      ));
    const ids: (number | null)[] = rows.map((r) => r.id);
    // The untagged unit is real whenever sales can land without a branch (dine-in with no mapping).
    if (settings.dine_in_branch_id == null || !ids.length) ids.push(null);
    return ids;
  }

  /** Menu skus that are genuinely dish demand (they have a recipe) — charge refs never qualify. */
  knownSkus(recipes: RecipeEdge[]): Set<string> {
    return new Set(recipes.map((r) => r.menuSku));
  }

  /** One-shot extraction for a planning run. */
  async extractAll(
    tenantId: number | null,
    opts: { branchIds?: (number | null)[]; itemIds?: string[] } = {},
  ): Promise<ExtractedTenantData> {
    const settings = await this.settings(tenantId);
    const recipes = await this.recipeMatrix(tenantId);
    const skus = this.knownSkus(recipes);
    const { series, branchNullShare } = await this.menuDailySeries(tenantId, settings, skus);

    const allBranches = opts.branchIds ?? await this.branchIds(tenantId, settings);
    const scoped = series.filter((s) => allBranches.some((b) => b === s.branchId));

    let ingredientIds = [...new Set(recipes.map((r) => r.ingredientItemId))];
    if (opts.itemIds?.length) {
      const wanted = new Set(opts.itemIds);
      ingredientIds = ingredientIds.filter((i) => wanted.has(i));
    }

    const [params, stock] = await Promise.all([
      this.itemParams(tenantId, ingredientIds, settings),
      this.stockPositions(tenantId, ingredientIds, allBranches),
    ]);

    const today = ymd();

    // docs/56 A1 — governed promo regressors for the menu skus actually being forecast, over the
    // history∪horizon window. Server-derived (SCM-04); empty ⇒ pre-A1 baseline behaviour.
    const forecastSkus = [...new Set(scoped.map((s) => s.itemId))];
    const windowStart = scoped.reduce((min, s) => (s.startDate < min ? s.startDate : min), today);
    const regressors = await this.promo.regressorsFor(
      tenantId, forecastSkus, windowStart, addDaysYmd(today, settings.horizon_days + 1),
    );
    const promoCoverage = forecastSkus.length
      ? forecastSkus.filter((sku) => (regressors.get(sku)?.length ?? 0) > 0).length / forecastSkus.length
      : 0;

    return {
      settings,
      branchIds: allBranches,
      series: scoped,
      recipes,
      stock,
      params,
      holidays: this.holidays(addDaysYmd(today, -settings.lookback_days), addDaysYmd(today, settings.horizon_days + 1)),
      ingredientIds: ingredientIds.filter((i) => params.has(i)),
      branchNullShare,
      regressors,
      promoCoverage,
    };
  }
}
