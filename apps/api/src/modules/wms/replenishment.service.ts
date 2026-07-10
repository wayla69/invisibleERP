import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, and, asc, gte, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerInventory, branchStock, replenishmentSuggestions, branches, itemSupplier, vendors, custStockLog, stockMovements } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { ProcurementService } from '../procurement/procurement.service';
import { DemandForecastService } from '../demand-ml/demand-forecast.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;

// Branch-aware min-max replenishment with TRANSFER-BEFORE-BUY routing. suggest() detects a low (branch,item)
// from branch_stock and proposes a TRANSFER from a sibling branch that holds surplus first, then a BUY (PR) for
// the residual. Falls back to the legacy tenant-wide customer_inventory buy-only path when a tenant has no
// branch_stock yet (back-compat). Execution is split by duty (SoD): transfer leg = autoTransfer (warehouse
// custody), buy leg = autoPr (procurement → maker-checker PR).
@Injectable()
export class ReplenishmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly procurement: ProcurementService,
    // @Optional so partial harnesses that don't wire DemandMlModule can still construct this service.
    @Optional() private readonly demand?: DemandForecastService,
  ) {}

  private urgency(onHand: number, rop: number): string {
    if (onHand <= 0) return 'critical';
    if (onHand <= rop * 0.5) return 'warning';
    return 'ok';
  }

  // recompute Suggested rows from current stock (PR_Created/Transfer_Done/Dismissed rows are terminal, left intact)
  async suggest(user: JwtUser, _limit = 50) {
    const db = this.db;
    const tenantId = user.tenantId as number;
    // drop prior open suggestions for this tenant; rebuild from current state (idempotent)
    await db.delete(replenishmentSuggestions).where(and(eq(replenishmentSuggestions.tenantId, tenantId), eq(replenishmentSuggestions.status, 'Suggested')));

    const branchRows = await db.select().from(branchStock).where(eq(branchStock.tenantId, tenantId));
    const out: any[] = [];

    // ── Legacy tenant-wide path: no per-branch stock → buy-only suggestions from customer_inventory ──
    if (!branchRows.length) {
      const rows = await db.select().from(customerInventory).where(eq(customerInventory.tenantId, tenantId)).orderBy(asc(customerInventory.itemId));
      const candidates = rows.filter((r: any) => n(r.reorderPoint) > 0 && n(r.currentStock) <= n(r.reorderPoint));
      for (const r of candidates) {
        const onHand = n(r.currentStock), rop = n(r.reorderPoint), qty = n(r.reorderQty);
        if (qty <= 0) continue; // nothing to order
        const suggestionNo = await this.docNo.nextDaily('RPL');
        const urgency = this.urgency(onHand, rop);
        await db.insert(replenishmentSuggestions).values({ tenantId, suggestionNo, itemId: r.itemId!, onHand: String(onHand), reorderPoint: String(rop), suggestedQty: String(qty), urgency, status: 'Suggested', route: 'buy', transferQty: '0', buyQty: String(qty) });
        out.push({ suggestion_no: suggestionNo, item_id: r.itemId, on_hand: onHand, reorder_point: rop, suggested_qty: qty, urgency, route: 'buy', transfer_qty: 0, buy_qty: qty });
      }
      return { suggestions: out, count: out.length };
    }

    // ── Branch-aware transfer-before-buy ──
    // Mutable surplus pool per item: a branch whose on_hand > reorder_point can lend the excess.
    const surplusPool = new Map<string, { branchId: number; avail: number }[]>();
    for (const b of branchRows) {
      const excess = n(b.onHand) - n(b.reorderPoint);
      if (excess > 0) {
        const arr = surplusPool.get(b.itemId!) ?? [];
        arr.push({ branchId: Number(b.branchId), avail: excess });
        surplusPool.set(b.itemId!, arr);
      }
    }
    for (const arr of surplusPool.values()) arr.sort((a, b) => b.avail - a.avail); // largest lender first

    // Low rows: on_hand <= reorder_point. Worst-first (lowest on_hand) so the scarcest branch claims surplus first.
    const lowRows = branchRows
      .filter((b: any) => n(b.reorderPoint) > 0 && n(b.onHand) <= n(b.reorderPoint) && n(b.reorderQty) > 0)
      .sort((a: any, b: any) => n(a.onHand) - n(b.onHand));

    for (const low of lowRows) {
      const onHand = n(low.onHand), rop = n(low.reorderPoint);
      let need = n(low.reorderQty);
      const urgency = this.urgency(onHand, rop);
      // transfer leg(s): draw from sibling branches' surplus, largest-first
      const lenders = (surplusPool.get(low.itemId!) ?? []).filter((l) => l.branchId !== Number(low.branchId) && l.avail > 0);
      for (const lender of lenders) {
        if (need <= 0.0001) break;
        const take = round2(Math.min(need, lender.avail));
        if (take <= 0) continue;
        lender.avail -= take;
        need -= take;
        const suggestionNo = await this.docNo.nextDaily('RPL');
        await db.insert(replenishmentSuggestions).values({ tenantId, suggestionNo, itemId: low.itemId!, onHand: String(onHand), reorderPoint: String(rop), suggestedQty: String(take), urgency, status: 'Suggested', branchId: Number(low.branchId), route: 'transfer', fromBranchId: lender.branchId, transferQty: String(take), buyQty: '0' });
        out.push({ suggestion_no: suggestionNo, item_id: low.itemId, on_hand: onHand, reorder_point: rop, suggested_qty: take, urgency, branch_id: Number(low.branchId), from_branch_id: lender.branchId, route: 'transfer', transfer_qty: take, buy_qty: 0 });
      }
      // buy leg: residual the transfers couldn't cover
      if (need > 0.0001) {
        const buyQty = round2(need);
        const suggestionNo = await this.docNo.nextDaily('RPL');
        await db.insert(replenishmentSuggestions).values({ tenantId, suggestionNo, itemId: low.itemId!, onHand: String(onHand), reorderPoint: String(rop), suggestedQty: String(buyQty), urgency, status: 'Suggested', branchId: Number(low.branchId), route: 'buy', transferQty: '0', buyQty: String(buyQty) });
        out.push({ suggestion_no: suggestionNo, item_id: low.itemId, on_hand: onHand, reorder_point: rop, suggested_qty: buyQty, urgency, branch_id: Number(low.branchId), route: 'buy', transfer_qty: 0, buy_qty: buyQty });
      }
    }
    return { suggestions: out, count: out.length };
  }

  async list(user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId as number;
    const rows = await db.select().from(replenishmentSuggestions).where(eq(replenishmentSuggestions.tenantId, tenantId)).orderBy(asc(replenishmentSuggestions.itemId));
    // resolve branch + preferred-vendor display names (best-effort)
    const brs = await db.select().from(branches).where(eq(branches.tenantId, tenantId));
    const brName = new Map<number, string>(brs.map((b: any) => [Number(b.id), b.name ?? b.code]));
    const sup = await db.select().from(itemSupplier).where(and(eq(itemSupplier.tenantId, tenantId), eq(itemSupplier.preferred, true)));
    const vIds = [...new Set(sup.map((s: any) => Number(s.vendorId)).filter(Boolean))] as number[];
    const vrows = vIds.length ? await db.select().from(vendors).where(inArray(vendors.id, vIds)) : [];
    const vName = new Map<number, string>(vrows.map((v: any) => [Number(v.id), v.name]));
    const vendorByItem = new Map<string, string | null>(sup.map((s: any) => [String(s.itemId), vName.get(Number(s.vendorId)) ?? null]));
    return {
      suggestions: rows.map((r: any) => ({
        suggestion_no: r.suggestionNo, item_id: r.itemId, on_hand: n(r.onHand), reorder_point: n(r.reorderPoint),
        suggested_qty: n(r.suggestedQty), urgency: r.urgency, status: r.status, pr_no: r.prNo,
        route: r.route ?? 'buy', branch_id: r.branchId, branch_name: r.branchId != null ? (brName.get(Number(r.branchId)) ?? null) : null,
        from_branch_id: r.fromBranchId, from_branch_name: r.fromBranchId != null ? (brName.get(Number(r.fromBranchId)) ?? null) : null,
        transfer_qty: n(r.transferQty), buy_qty: n(r.buyQty),
        vendor: (r.route ?? 'buy') === 'buy' ? (vendorByItem.get(String(r.itemId)) ?? null) : null,
      })),
    };
  }

  // Execute the TRANSFER legs (warehouse custody duty): move branch_stock source→dest, post a TRF stock movement
  // + a tenant-scoped cust_stock_log entry for BOTH branches (the authoritative, branch-attributed audit trail,
  // since stock_movements has no tenant_id). Stamps the rows Transfer_Done. Atomic.
  async autoTransfer(dto: { item_ids?: string[] }, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId as number;
    const all = await db.select().from(replenishmentSuggestions)
      .where(and(eq(replenishmentSuggestions.tenantId, tenantId), eq(replenishmentSuggestions.status, 'Suggested'), eq(replenishmentSuggestions.route, 'transfer')));
    const picked = (dto.item_ids?.length ? all.filter((r: any) => dto.item_ids!.includes(r.itemId)) : all).filter((r: any) => n(r.transferQty) > 0);
    if (!picked.length) return { doc_no: null, transfers: 0 };

    const brs = await db.select().from(branches).where(eq(branches.tenantId, tenantId));
    const codeById = new Map<number, string>(brs.map((b: any) => [Number(b.id), b.code]));
    const docNo = this.docNo.nextStamped('TRF');

    return await db.transaction(async (tx: any) => {
      const now = new Date();
      let count = 0;
      const doneIds: number[] = [];
      for (const s of picked) {
        // source branch — lock + cap the move at what it actually holds (stock may have moved since suggest)
        const [src] = await tx.select().from(branchStock).where(and(eq(branchStock.tenantId, tenantId), eq(branchStock.branchId, Number(s.fromBranchId)), eq(branchStock.itemId, s.itemId))).for('update').limit(1);
        const qty = round2(Math.min(n(s.transferQty), Math.max(0, n(src?.onHand))));
        if (qty <= 0) continue; // source no longer has stock to lend — leave row Suggested for the next recompute
        const srcAfter = round2(n(src.onHand) - qty);
        await tx.update(branchStock).set({ onHand: String(srcAfter), lastUpdated: now }).where(eq(branchStock.id, src.id));
        // dest branch — lock or create
        let [dst] = await tx.select().from(branchStock).where(and(eq(branchStock.tenantId, tenantId), eq(branchStock.branchId, Number(s.branchId)), eq(branchStock.itemId, s.itemId))).for('update').limit(1);
        if (!dst) { [dst] = await tx.insert(branchStock).values({ tenantId, branchId: Number(s.branchId), itemId: s.itemId, itemDescription: src.itemDescription, uom: src.uom ?? null, onHand: '0' }).returning(); }
        const dstAfter = round2(n(dst.onHand) + qty);
        await tx.update(branchStock).set({ onHand: String(dstAfter), lastUpdated: now }).where(eq(branchStock.id, dst.id));
        // global audit movement
        await tx.insert(stockMovements).values({ tenantId, moveDate: now, docNo, moveType: 'Transfer', itemId: s.itemId, itemDescription: src.itemDescription, uom: src.uom ?? null, qty: String(qty), fromLocation: `BR:${codeById.get(Number(s.fromBranchId)) ?? s.fromBranchId}`, toLocation: `BR:${codeById.get(Number(s.branchId)) ?? s.branchId}`, refDoc: s.suggestionNo, remarks: 'Auto-replenish transfer', createdBy: user.username });
        // tenant-scoped, branch-attributed audit (both legs)
        await tx.insert(custStockLog).values({ tenantId, branchId: Number(s.fromBranchId), itemId: s.itemId, itemDescription: src.itemDescription, logDate: now, logType: 'Transfer-Out', qtyChange: String(-qty), balanceAfter: String(srcAfter), refDoc: docNo, createdBy: user.username });
        await tx.insert(custStockLog).values({ tenantId, branchId: Number(s.branchId), itemId: s.itemId, itemDescription: src.itemDescription, logDate: now, logType: 'Transfer-In', qtyChange: String(qty), balanceAfter: String(dstAfter), refDoc: docNo, createdBy: user.username });
        doneIds.push(Number(s.id));
        count++;
      }
      if (doneIds.length) await tx.update(replenishmentSuggestions).set({ status: 'Transfer_Done' }).where(inArray(replenishmentSuggestions.id, doneIds));
      return { doc_no: count ? docNo : null, transfers: count };
    });
  }

  // Execute the BUY legs (procurement duty): consolidate residual 'buy' rows into ONE PR via the maker-checker
  // procurement flow. Stamps them PR_Created. Legacy NULL-route rows are treated as buy (back-compat).
  async autoPr(dto: { item_ids?: string[] }, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId as number;
    const rows = await db.select().from(replenishmentSuggestions).where(and(eq(replenishmentSuggestions.tenantId, tenantId), eq(replenishmentSuggestions.status, 'Suggested')));
    const buyRows = rows.filter((r: any) => (r.route ?? 'buy') !== 'transfer');
    const picked = (dto.item_ids?.length ? buyRows.filter((r: any) => dto.item_ids!.includes(r.itemId)) : buyRows).filter((r: any) => n(r.buyQty ?? r.suggestedQty) > 0);
    if (!picked.length) return { pr_no: null, lines: 0 };
    const pr = await this.procurement.createPr({ items: picked.map((r: any) => ({ item_id: r.itemId, request_qty: n(r.buyQty ?? r.suggestedQty), reason: 'Auto-replenishment' })) } as any, user);
    await db.update(replenishmentSuggestions).set({ status: 'PR_Created', prNo: pr.pr_no }).where(inArray(replenishmentSuggestions.id, picked.map((r: any) => Number(r.id))));
    return { pr_no: pr.pr_no, lines: picked.length };
  }

  // Step 5 — demand-driven par-level recommendation (INV-12). For each (branch,item) it derives the average
  // daily usage from the trailing window of branch-tagged consumption (cust_stock_log Sale/Consume rows) and
  // recommends reorder_point = ceil(avg_daily × lead_time_days × SAFETY), flagging branches whose STATIC
  // reorder_point is below their actual run-rate buffer (under_buffered). Read-only; planners apply per row.
  private static readonly SAFETY = 1.25;
  async parRecommendations(user: JwtUser, opts?: { branchId?: number; windowDays?: number }) {
    const db = this.db;
    const tenantId = user.tenantId as number;
    const windowDays = Math.min(365, Math.max(1, opts?.windowDays ?? 30));
    const cutoff = new Date(Date.now() - windowDays * 86400 * 1000);
    const stock = await db.select().from(branchStock).where(
      opts?.branchId != null ? and(eq(branchStock.tenantId, tenantId), eq(branchStock.branchId, opts.branchId)) : eq(branchStock.tenantId, tenantId),
    );
    if (!stock.length) return { window_days: windowDays, recommendations: [], count: 0 };
    const logs = await db.select().from(custStockLog).where(and(eq(custStockLog.tenantId, tenantId), gte(custStockLog.logDate, cutoff)));
    // Σ usage per (branch,item): only real consumption (Sale/Consume) with a negative qty; EOD recounts and
    // reversals (returns) are excluded so demand isn't double-counted.
    const used = new Map<string, number>();
    for (const l of logs) {
      const q = n(l.qtyChange);
      if (q >= 0) continue;
      if (!['Sale', 'Consume'].includes(String(l.logType ?? ''))) continue;
      const k = `${l.branchId ?? ''}|${l.itemId}`;
      used.set(k, (used.get(k) ?? 0) + Math.abs(q));
    }
    const recs = stock.map((s: any) => {
      const totalUsed = used.get(`${s.branchId ?? ''}|${s.itemId}`) ?? 0;
      const avgDaily = round2(totalUsed / windowDays);
      const lead = Number(s.leadTimeDays ?? 3);
      const recommended = Math.ceil(avgDaily * lead * ReplenishmentService.SAFETY);
      const current = n(s.reorderPoint);
      return {
        branch_id: Number(s.branchId), item_id: s.itemId, item_description: s.itemDescription,
        on_hand: n(s.onHand), avg_daily_usage: avgDaily, lead_time_days: lead,
        current_reorder_point: current, recommended_reorder_point: recommended,
        gap: round2(recommended - current), under_buffered: recommended > current,
      };
    }).filter((r: any) => r.avg_daily_usage > 0 || r.current_reorder_point > 0)
      .sort((a: any, b: any) => b.gap - a.gap);
    return { window_days: windowDays, recommendations: recs, count: recs.length, under_buffered: recs.filter((r: any) => r.under_buffered).length };
  }

  // Apply a recommendation: write the demand-driven reorder_point onto the (branch,item) row (planner duty).
  async applyPar(user: JwtUser, branchId: number, itemId: string, opts?: { windowDays?: number }) {
    const db = this.db;
    const tenantId = user.tenantId as number;
    const rec = (await this.parRecommendations(user, { branchId, windowDays: opts?.windowDays })).recommendations.find((r: any) => r.item_id === itemId);
    if (!rec) return { applied: false, reason: 'NO_RECOMMENDATION' };
    await db.update(branchStock).set({ reorderPoint: String(rec.recommended_reorder_point), lastUpdated: new Date() })
      .where(and(eq(branchStock.tenantId, tenantId), eq(branchStock.branchId, branchId), eq(branchStock.itemId, itemId)));
    return { applied: true, branch_id: branchId, item_id: itemId, reorder_point: rec.recommended_reorder_point, previous: rec.current_reorder_point };
  }

  // Demand-ML order-quantity advisor (INV-13): for every item at or below its reorder point, uses the
  // demand-ML multi-model forecast (auto-selects the lowest-WAPE model) to derive a suggested order quantity =
  // Σ forecast[0..horizon-1]. Falls back to the static reorder_qty from master data when the ML service is
  // unavailable or the item has insufficient history (< 14 days). Read-only; advisory only — does not write to
  // replenishment_suggestions. The planner uses the ml_qty alongside the static suggestion to decide how much
  // to requisition. Horizon must be 7, 14, or 28 days (clamped to [7,28]).
  async demandForecast(user: JwtUser, opts?: { horizon?: number }) {
    const db = this.db;
    const tenantId = user.tenantId as number;
    const horizon = Math.min(28, Math.max(7, Math.round(opts?.horizon ?? 14)));

    // Determine candidates: items whose stock is at/below their reorder point
    const branchRows = await db.select().from(branchStock).where(eq(branchStock.tenantId, tenantId));
    const useBranch = branchRows.length > 0;
    const invRows = useBranch ? [] : await db.select().from(customerInventory).where(eq(customerInventory.tenantId, tenantId));

    const candidates: { itemId: string; onHand: number; rop: number; staticQty: number; branchId: number | null }[] = useBranch
      ? branchRows
          .filter((b: any) => n(b.reorderPoint) > 0 && n(b.onHand) <= n(b.reorderPoint) && n(b.reorderQty) > 0)
          .map((b: any) => ({ itemId: b.itemId as string, onHand: n(b.onHand), rop: n(b.reorderPoint), staticQty: n(b.reorderQty), branchId: Number(b.branchId) }))
      : invRows
          .filter((r: any) => n(r.reorderPoint) > 0 && n(r.currentStock) <= n(r.reorderPoint) && n(r.reorderQty) > 0)
          .map((r: any) => ({ itemId: r.itemId as string, onHand: n(r.currentStock), rop: n(r.reorderPoint), staticQty: n(r.reorderQty), branchId: null }));

    const items: any[] = [];
    for (const c of candidates) {
      let mlQty: number = c.staticQty;
      let mlAlgo: string | null = null;
      let mlWape: number | null = null;
      let mlSource: 'ml' | 'static_fallback' | 'service_unavailable' = 'service_unavailable';

      if (this.demand) {
        const fc = await this.demand.planForecast(c.itemId, horizon);
        if (fc) {
          mlQty = Math.ceil(fc.forecast.reduce((a, b) => a + b, 0));
          mlAlgo = fc.algorithm;
          mlWape = fc.wape;
          mlSource = 'ml';
        } else {
          mlSource = 'static_fallback'; // insufficient POS history
        }
      }

      items.push({
        item_id: c.itemId, on_hand: c.onHand, reorder_point: c.rop,
        static_qty: c.staticQty, ml_qty: mlQty,
        ml_algo: mlAlgo, ml_wape: mlWape, ml_source: mlSource,
        horizon_days: horizon,
        ...(c.branchId != null ? { branch_id: c.branchId } : {}),
      });
    }

    items.sort((a, b) => a.on_hand - b.on_hand); // most urgent first
    return {
      horizon_days: horizon,
      ml_available: !!this.demand,
      count: items.length,
      ml_count: items.filter((i) => i.ml_source === 'ml').length,
      items,
    };
  }
}
