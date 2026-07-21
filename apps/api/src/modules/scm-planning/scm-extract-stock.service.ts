import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import {
  branchStock, goodsReceipts, grItems, invBalances, invCostLayers, itemSupplier, items, poItems,
  purchaseOrders, scmItemPolicies, vendors, wasteLog,
} from '../../database/schema';
import { n, ymd } from '../../database/queries';
import { addDaysYmd } from '../demand-ml/forecast-algorithms';
import type { ItemParams, ScmSettingsView, StockPosition } from './scm-planning.types';

// docs/54 — the SUPPLY side of extraction: stock by remaining shelf life, in-transit purchase
// orders, empirical lead times, spoilage priors, and the resolved per-item planning parameters.
// Split out of ScmExtractService (which owns the DEMAND side) to keep both under the service-size
// ratchet; ScmExtractService builds one of these in its constructor and delegates.
export class ScmStockExtractService {
  constructor(private readonly db: DrizzleDb) {}

  async stockPositions(
    tenantId: number | null,
    itemIds: string[],
    branchIds: (number | null)[],
  ): Promise<StockPosition[]> {
    if (!itemIds.length) return [];
    const today = ymd();

    const layers = await this.db.select({
      itemId: invCostLayers.itemId,
      expiryDate: invCostLayers.expiryDate,
      remainingQty: invCostLayers.remainingQty,
      unitCost: invCostLayers.unitCost,
    }).from(invCostLayers).where(and(
      tenantId != null ? eq(invCostLayers.tenantId, tenantId) : sql`true`,
      inArray(invCostLayers.itemId, itemIds),
      sql`${invCostLayers.remainingQty} > 0`,
    ));

    const balances = await this.db.select({
      itemId: invBalances.itemId,
      onHandQty: invBalances.onHandQty,
      avgCost: invBalances.avgCost,
    }).from(invBalances).where(and(
      tenantId != null ? eq(invBalances.tenantId, tenantId) : sql`true`,
      inArray(invBalances.itemId, itemIds),
    ));

    const branchRows = await this.db.select({
      branchId: branchStock.branchId,
      itemId: branchStock.itemId,
      onHand: branchStock.onHand,
    }).from(branchStock).where(and(
      tenantId != null ? eq(branchStock.tenantId, tenantId) : sql`true`,
      inArray(branchStock.itemId, itemIds),
    ));

    const layerMix = new Map<string, { remaining_days: number; qty: number }[]>();
    const layerTotal = new Map<string, number>();
    for (const l of layers) {
      const qty = n(l.remainingQty);
      if (qty <= 0) continue;
      const days = l.expiryDate
        ? Math.max(0, Math.round((Date.parse(`${l.expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000))
        : 3650; // no expiry recorded ⇒ effectively non-perishable
      const arr = layerMix.get(l.itemId) ?? [];
      arr.push({ remaining_days: days, qty });
      layerMix.set(l.itemId, arr);
      layerTotal.set(l.itemId, (layerTotal.get(l.itemId) ?? 0) + qty);
    }

    const tenantOnHand = new Map(balances.map((b) => [b.itemId, n(b.onHandQty)]));
    const cost = new Map(balances.map((b) => [b.itemId, n(b.avgCost)]));
    const byBranch = new Map<string, number>();
    for (const b of branchRows) {
      if (!b.itemId) continue;
      byBranch.set(`${b.branchId ?? ''}|${b.itemId}`, n(b.onHand));
    }

    const inTransit = await this.inTransit(tenantId, itemIds);
    const out: StockPosition[] = [];
    for (const branchId of branchIds) {
      for (const itemId of itemIds) {
        const branchQty = byBranch.get(`${branchId ?? ''}|${itemId}`);
        // Branch stock when tracked; otherwise the tenant balance stands in for the single-site case.
        const onHand = branchQty ?? (branchIds.length === 1 ? (tenantOnHand.get(itemId) ?? 0) : 0);
        const mix = layerMix.get(itemId) ?? [];
        const total = layerTotal.get(itemId) ?? 0;
        const scaled = total > 0 && onHand > 0
          ? mix.map((l) => ({ remaining_days: l.remaining_days, qty: (l.qty / total) * onHand }))
          : (onHand > 0 ? [{ remaining_days: 3650, qty: onHand }] : []);
        out.push({
          branchId, itemId, onHand, avgCost: cost.get(itemId) ?? 0,
          layers: scaled,
          // In-transit is tenant-level (a PO is not branch-addressed); only the single planning unit
          // that owns replenishment should count it, else N branches each claim the same delivery.
          inTransit: branchId === (branchIds[0] ?? null) ? (inTransit.get(itemId) ?? []) : [],
        });
      }
    }
    return out;
  }

  /** Open PO quantity still to arrive, dated by the line schedule then the PO's expected date. */
  private async inTransit(tenantId: number | null, itemIds: string[]) {
    const rows = await this.db.select({
      itemId: poItems.itemId,
      orderQty: poItems.orderQty,
      receivedQty: poItems.receivedQty,
      expectedDate: purchaseOrders.expectedDate,
      poDate: purchaseOrders.poDate,
      status: purchaseOrders.status,
    })
      .from(poItems)
      .innerJoin(purchaseOrders, eq(poItems.poId, purchaseOrders.id))
      .where(and(
        tenantId != null ? eq(poItems.tenantId, tenantId) : sql`true`,
        inArray(poItems.itemId, itemIds),
        eq(poItems.status, 'Open'),
        // Committed but not yet fully received. 'Received' stays in scope because a PARTIAL receipt
        // flips the header while the line still owes the balance (po_status has no 'Partial').
        inArray(purchaseOrders.status, ['Approved', 'Received']),
      ));

    const today = ymd();
    const out = new Map<string, { arrival_ds: string; qty: number }[]>();
    for (const r of rows) {
      if (!r.itemId) continue;
      const remaining = n(r.orderQty) - n(r.receivedQty);
      if (remaining <= 0) continue;
      // An overdue PO is not "never" — treat it as landing today rather than dropping it.
      const eta = r.expectedDate && r.expectedDate >= today ? r.expectedDate : today;
      const arr = out.get(r.itemId) ?? [];
      arr.push({ arrival_ds: eta, qty: remaining });
      out.set(r.itemId, arr);
    }
    return out;
  }

  /** Empirical lead time per item: GR date − PO date over recent receipts (mean + sample stdev). */
  private async leadTimeStats(tenantId: number | null, itemIds: string[]) {
    const since = addDaysYmd(ymd(), -180);
    const rows = await this.db.select({
      itemId: grItems.itemId,
      grDate: goodsReceipts.grDate,
      poDate: purchaseOrders.poDate,
    })
      .from(grItems)
      .innerJoin(goodsReceipts, eq(grItems.grId, goodsReceipts.id))
      .innerJoin(purchaseOrders, eq(goodsReceipts.poNo, purchaseOrders.poNo))
      .where(and(
        tenantId != null ? eq(grItems.tenantId, tenantId) : sql`true`,
        inArray(grItems.itemId, itemIds),
        gte(goodsReceipts.grDate, since),
      ));

    const samples = new Map<string, number[]>();
    for (const r of rows) {
      if (!r.itemId || !r.grDate || !r.poDate) continue;
      const days = (Date.parse(`${r.grDate}T00:00:00Z`) - Date.parse(`${r.poDate}T00:00:00Z`)) / 86_400_000;
      if (!Number.isFinite(days) || days < 0 || days > 120) continue;
      const arr = samples.get(r.itemId) ?? [];
      arr.push(days);
      samples.set(r.itemId, arr);
    }

    const out = new Map<string, { mean: number; std: number }>();
    for (const [itemId, arr] of samples) {
      if (arr.length < 3) continue; // too few observations to claim a distribution
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1);
      out.set(itemId, { mean, std: Math.sqrt(variance) });
    }
    return out;
  }

  /** Observed expiry/spoilage rate per item — calibrates the optimizer's waste prior. */
  private async wastePriors(tenantId: number | null, itemIds: string[]) {
    const since = addDaysYmd(ymd(), -180);
    const rows = await this.db.select({
      itemId: wasteLog.itemId,
      qty: sql<string>`coalesce(sum(${wasteLog.qty}), 0)`,
    }).from(wasteLog).where(and(
      tenantId != null ? eq(wasteLog.tenantId, tenantId) : sql`true`,
      inArray(wasteLog.itemId, itemIds),
      sql`${wasteLog.reasonCode} in ('expiry', 'spoilage')`,
      gte(sql`${wasteLog.createdAt}::date`, since),
    )).groupBy(wasteLog.itemId);
    return new Map(rows.map((r) => [r.itemId, n(r.qty)]));
  }

  /** Resolve planning params: policy override → item master → settings default. */
  async itemParams(
    tenantId: number | null,
    itemIds: string[],
    settings: ScmSettingsView,
    branchId: number | null = null,
  ): Promise<Map<string, ItemParams>> {
    const out = new Map<string, ItemParams>();
    if (!itemIds.length) return out;

    const [masters, policies, leadStats, waste, prices, suppliers] = await Promise.all([
      this.db.select().from(items).where(inArray(items.itemId, itemIds)),
      this.db.select().from(scmItemPolicies).where(and(
        tenantId != null ? eq(scmItemPolicies.tenantId, tenantId) : sql`true`,
        inArray(scmItemPolicies.itemId, itemIds),
      )),
      this.leadTimeStats(tenantId, itemIds),
      this.wastePriors(tenantId, itemIds),
      this.db.select({ itemId: invBalances.itemId, avgCost: invBalances.avgCost })
        .from(invBalances).where(and(
          tenantId != null ? eq(invBalances.tenantId, tenantId) : sql`true`,
          inArray(invBalances.itemId, itemIds),
        )),
      this.db.select({
        itemId: itemSupplier.itemId, vendorId: itemSupplier.vendorId,
        leadTimeDays: itemSupplier.leadTimeDays, preferred: itemSupplier.preferred,
      }).from(itemSupplier).where(and(
        tenantId != null ? eq(itemSupplier.tenantId, tenantId) : sql`true`,
        inArray(itemSupplier.itemId, itemIds),
      )),
    ]);

    const vendorLeadTimes = new Map<number, number>();
    const vendorIds = [...new Set(suppliers.map((s) => s.vendorId).filter((v): v is number => v != null))];
    if (vendorIds.length) {
      const vs = await this.db.select({ id: vendors.id, leadTimeDays: vendors.leadTimeDays })
        .from(vendors).where(inArray(vendors.id, vendorIds));
      for (const v of vs) vendorLeadTimes.set(v.id, Number(v.leadTimeDays ?? 3));
    }

    const cost = new Map(prices.map((p) => [p.itemId, n(p.avgCost)]));
    // Branch-specific policy wins over the tenant-wide (NULL branch) row for the same item.
    const policyFor = (itemId: string) =>
      policies.find((p) => p.itemId === itemId && p.branchId === branchId)
      ?? policies.find((p) => p.itemId === itemId && p.branchId == null);
    const supplierFor = (itemId: string) =>
      suppliers.find((s) => s.itemId === itemId && s.preferred)
      ?? suppliers.find((s) => s.itemId === itemId);

    for (const m of masters) {
      const p = policyFor(m.itemId);
      if (p && p.planningEnabled === false) continue;
      const sup = supplierFor(m.itemId);
      const stats = leadStats.get(m.itemId);
      const leadMean = p?.leadTimeDays != null ? n(p.leadTimeDays)
        : stats?.mean ?? (sup?.leadTimeDays != null ? Number(sup.leadTimeDays)
          : (sup?.vendorId != null ? vendorLeadTimes.get(sup.vendorId) : undefined) ?? n(m.leadTimeDays));
      const unitCost = cost.get(m.itemId) || n(m.unitPrice);
      const shelfLife = p?.shelfLifeDays ?? m.shelfLifeDays ?? null;
      out.set(m.itemId, {
        itemId: m.itemId,
        description: m.itemDescription ?? null,
        uom: m.uom ?? m.baseUom ?? null,
        shelfLifeDays: shelfLife,
        leadTimeMean: Math.max(0, leadMean),
        leadTimeStd: stats?.std ?? 0,
        minOrderQty: p?.minOrderQty != null ? n(p.minOrderQty) : n(m.minOrderQty),
        orderMultiple: Math.max(p?.orderMultiple != null ? n(p.orderMultiple) : n(m.orderMultiple), 0),
        fixedOrderCost: n(m.orderCost),
        // items.holdingCost is per unit/YEAR (the EOQ 'H'); the optimizer charges per day.
        holdingCostPerDay: n(m.holdingCost) / 365,
        unitCost,
        // Ingredients have no retail price — the stockout penalty stands in as their value.
        unitPrice: n(m.unitPrice) || unitCost * 1.3,
        goodwillCost: p?.stockoutCostPerUnit != null ? n(p.stockoutCostPerUnit) : unitCost * 0.5,
        disposalCost: p?.wasteCostPerUnit != null ? n(p.wasteCostPerUnit) : 0,
        salvageValue: 0,
        serviceLevel: p?.serviceLevel != null ? n(p.serviceLevel) : settings.service_level,
        maxStockQty: p?.maxStockQty != null ? n(p.maxStockQty) : (n(m.maxStock) || null),
        vendorId: sup?.vendorId ?? null,
        wasteRatePrior: waste.get(m.itemId) != null ? Math.min(1, waste.get(m.itemId)! / 1000) : null,
      });
    }
    return out;
  }

  /** Median observed shelf life per item (GR expiry − GR date) — powers the suggest endpoint. */
  async suggestShelfLife(tenantId: number | null) {
    const rows = await this.db.select({
      itemId: grItems.itemId,
      expiryDate: grItems.expiryDate,
      grDate: goodsReceipts.grDate,
    })
      .from(grItems)
      .innerJoin(goodsReceipts, eq(grItems.grId, goodsReceipts.id))
      .where(and(
        tenantId != null ? eq(grItems.tenantId, tenantId) : sql`true`,
        sql`${grItems.expiryDate} is not null`,
      ));

    const byItem = new Map<string, number[]>();
    for (const r of rows) {
      if (!r.itemId || !r.expiryDate || !r.grDate) continue;
      const days = (Date.parse(`${r.expiryDate}T00:00:00Z`) - Date.parse(`${r.grDate}T00:00:00Z`)) / 86_400_000;
      if (!Number.isFinite(days) || days <= 0 || days > 3650) continue;
      const arr = byItem.get(r.itemId) ?? [];
      arr.push(days);
      byItem.set(r.itemId, arr);
    }

    const out: { item_id: string; suggested_days: number; samples: number; current_days: number | null }[] = [];
    const ids = [...byItem.keys()];
    const masters = ids.length
      ? await this.db.select({ itemId: items.itemId, shelfLifeDays: items.shelfLifeDays })
        .from(items).where(inArray(items.itemId, ids))
      : [];
    const current = new Map(masters.map((m) => [m.itemId, m.shelfLifeDays ?? null]));
    for (const [itemId, arr] of byItem) {
      arr.sort((a, b) => a - b);
      const median = arr[Math.floor(arr.length / 2)]!;
      out.push({
        item_id: itemId, suggested_days: Math.round(median), samples: arr.length,
        current_days: current.get(itemId) ?? null,
      });
    }
    return out.sort((a, b) => b.samples - a.samples);
  }
}
