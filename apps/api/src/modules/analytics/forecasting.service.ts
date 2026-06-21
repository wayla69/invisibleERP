import { Inject, Injectable } from '@nestjs/common';
import { sql, eq, and, ne, gte, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosItems, custPosSales, purchaseOrders, poItems, goodsReceipts, stockSnapshots } from '../../database/schema';
import { ymd } from '../../database/queries';

// ค่าคงที่ port จาก analytics/forecasting.py (ห้ามเปลี่ยน — parity)
const LOOKBACK = 60, SAFETY = 1.5, LEAD_FALLBACK = 7.0, CANDIDATE_LIMIT = 200;

export interface Prediction {
  item_id: string; item_name: string; uom: string; current_stock: number;
  avg_daily_sales: number; stdev_daily: number; lead_time_days: number;
  days_of_stock: number | null; predicted_stockout_date: string | null;
  reorder_point: number; urgency: 'critical' | 'warning' | 'ok'; confidence: 'high' | 'medium' | 'low';
  data_days?: number; message?: string;
}

@Injectable()
export class ForecastingService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async dailySales(itemId: string, days = LOOKBACK): Promise<number[]> {
    const db = this.db as any;
    const cutoff = ymd(new Date(Date.now() - days * 86400_000));
    const rows: { d: string; q: string }[] = await db.select({
      d: custPosSales.saleDate, q: sql<string>`coalesce(sum(${custPosItems.qty}),0)`,
    }).from(custPosItems).innerJoin(custPosSales, eq(custPosItems.saleId, custPosSales.id))
      .where(and(eq(custPosItems.itemId, itemId), ne(custPosSales.status, 'Voided'), gte(custPosSales.saleDate, cutoff)))
      .groupBy(custPosSales.saleDate).orderBy(custPosSales.saleDate);
    if (!rows.length) return [];
    // dense series จากวันแรกที่มียอดขาย → วันนี้ (เติม 0) — parity: ความยาวขึ้นกับ first-sale
    const byDay = new Map(rows.map((r) => [r.d, Number(r.q)]));
    const start = new Date(rows[0].d);
    const today = new Date(ymd());
    const series: number[] = [];
    for (let t = new Date(start); t <= today; t.setUTCDate(t.getUTCDate() + 1)) {
      series.push(byDay.get(t.toISOString().slice(0, 10)) ?? 0);
    }
    return series;
  }

  private async leadTimeDays(itemId: string): Promise<number> {
    const db = this.db as any;
    const rows: { lt: number }[] = await db.select({
      lt: sql<number>`(${goodsReceipts.grDate}::date - ${purchaseOrders.poDate}::date)`,
    }).from(poItems)
      .innerJoin(purchaseOrders, eq(poItems.poId, purchaseOrders.id))
      .innerJoin(goodsReceipts, eq(goodsReceipts.poNo, purchaseOrders.poNo))
      .where(and(eq(poItems.itemId, itemId), sql`${purchaseOrders.status}::text in ('Received','Closed')`, sql`${goodsReceipts.grDate}::date > ${purchaseOrders.poDate}::date`))
      .limit(10);
    const lts = rows.map((r) => Number(r.lt)).filter((x) => x > 0);
    return lts.length ? round1(mean(lts)) : LEAD_FALLBACK;
  }

  private async currentStock(itemId: string): Promise<{ qty: number; uom: string; name: string }> {
    const db = this.db as any;
    const [r] = await db.select({ q: stockSnapshots.avQty, uom: stockSnapshots.uom, name: stockSnapshots.itemDescription })
      .from(stockSnapshots).where(eq(stockSnapshots.itemId, itemId)).orderBy(desc(stockSnapshots.generateDate)).limit(1);
    return { qty: Number(r?.q ?? 0), uom: r?.uom ?? 'unit', name: r?.name ?? itemId };
  }

  async predictStockout(itemId: string): Promise<Prediction> {
    const [series, leadTime, cur] = await Promise.all([this.dailySales(itemId), this.leadTimeDays(itemId), this.currentStock(itemId)]);
    if (!series.length || series.every((x) => x === 0)) {
      return { item_id: itemId, item_name: cur.name, uom: cur.uom, current_stock: round2(cur.qty), avg_daily_sales: 0, stdev_daily: 0, lead_time_days: leadTime, days_of_stock: null, predicted_stockout_date: null, reorder_point: 0, urgency: 'ok', confidence: 'low', message: 'ไม่มีข้อมูลยอดขาย' };
    }
    const recent = series.length >= 30 ? series.slice(-30) : series;
    const avg = mean(recent);
    const sd = recent.length > 1 ? stdev(recent) : 0;
    const safety = sd * SAFETY;
    const reorderPoint = round2(avg * leadTime + safety);
    const daysLeft = avg > 0 ? cur.qty / avg : null;
    const predictedDate = daysLeft != null ? ymd(new Date(Date.now() + daysLeft * 86400_000)) : null;
    let urgency: Prediction['urgency'] = 'ok';
    if (daysLeft != null) urgency = daysLeft <= leadTime ? 'critical' : daysLeft <= leadTime * 2 ? 'warning' : 'ok';
    const confidence: Prediction['confidence'] = series.length >= 30 ? 'high' : series.length >= 14 ? 'medium' : 'low';
    return {
      item_id: itemId, item_name: cur.name, uom: cur.uom, current_stock: round2(cur.qty),
      avg_daily_sales: round2(avg), stdev_daily: round2(sd), lead_time_days: leadTime,
      days_of_stock: daysLeft != null ? round1(daysLeft) : null, predicted_stockout_date: predictedDate,
      reorder_point: reorderPoint, urgency, confidence, data_days: series.length,
    };
  }

  async getReplenishmentList(limit = 50): Promise<Prediction[]> {
    const db = this.db as any;
    const cutoff = ymd(new Date(Date.now() - LOOKBACK * 86400_000));
    const candidates: { id: string }[] = await db.selectDistinct({ id: custPosItems.itemId })
      .from(custPosItems).innerJoin(custPosSales, eq(custPosItems.saleId, custPosSales.id))
      .where(and(ne(custPosSales.status, 'Voided'), gte(custPosSales.saleDate, cutoff))).limit(CANDIDATE_LIMIT);
    const preds: Prediction[] = [];
    for (const c of candidates) {
      const p = await this.predictStockout(c.id);
      if (p.urgency === 'critical' || p.urgency === 'warning') preds.push(p);
    }
    const order = { critical: 0, warning: 1, ok: 2 };
    preds.sort((a, b) => order[a.urgency] - order[b.urgency] || (a.days_of_stock ?? 999) - (b.days_of_stock ?? 999));
    return preds.slice(0, limit);
  }
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
function stdev(a: number[]) { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
const round2 = (x: number) => Math.round(x * 100) / 100;
const round1 = (x: number) => Math.round(x * 10) / 10;
