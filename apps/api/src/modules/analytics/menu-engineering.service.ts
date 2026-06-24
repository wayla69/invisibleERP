import { Inject, Injectable } from '@nestjs/common';
import { and, gte, lte, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, custPosItems, payments, posOverrides } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import { bizParts, bizYmdDash } from '../../common/bizdate';
import { FoodCostService } from '../menu/food-cost.service';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const r1 = (x: number) => Math.round((Number(x) || 0) * 10) / 10;
const r4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// Kasavana–Smith menu-engineering popularity rule: an item is "high popularity" when its menu-mix share
// is at least 70% of an equal share (1/N). The classic threshold that beats a naive "top sellers" list.
const POP_RULE = 0.7;

// Daypart buckets on the business clock (Asia/Bangkok). Hour h (0–23) → segment.
function daypartOf(h: number): { key: string; label_th: string } {
  if (h >= 6 && h <= 10) return { key: 'breakfast', label_th: 'เช้า' };
  if (h >= 11 && h <= 14) return { key: 'lunch', label_th: 'กลางวัน' };
  if (h >= 15 && h <= 17) return { key: 'afternoon', label_th: 'บ่าย' };
  if (h >= 18 && h <= 22) return { key: 'dinner', label_th: 'เย็น' };
  return { key: 'late', label_th: 'ดึก' }; // 23–05
}
const DAYPART_ORDER = ['breakfast', 'lunch', 'afternoon', 'dinner', 'late'];

// Restaurant management analytics that go beyond a daily-sales export: the menu-engineering matrix,
// daypart/hour demand, and void/discount (shrinkage) analytics — all from sales already in the DB.
@Injectable()
export class MenuEngineeringService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly foodCost: FoodCostService,
  ) {}

  // ── Menu-engineering matrix: popularity (mix-share, 70% rule) × profitability (unit contribution
  //    margin vs menu average) → Star / Plowhorse / Puzzle / Dog, with an action per quadrant. ──
  async menuEngineering(user: JwtUser, opts?: { from?: string; to?: string }) {
    const db = this.db as any;
    const to = opts?.to ?? ymd();
    const from = opts?.from ?? to;

    // sold qty + net revenue per menu item over the window (completed sales only)
    const rows = await db
      .select({
        itemId: custPosItems.itemId,
        description: custPosItems.itemDescription,
        qty: sql<string>`coalesce(sum(${custPosItems.qty}),0)`,
        revenue: sql<string>`coalesce(sum(${custPosItems.amount}),0)`,
      })
      .from(custPosItems)
      .innerJoin(custPosSales, eq(custPosItems.saleId, custPosSales.id))
      .where(and(gte(custPosSales.saleDate, from), lte(custPosSales.saleDate, to), sql`${custPosSales.status}::text = 'Completed'`))
      .groupBy(custPosItems.itemId, custPosItems.itemDescription);

    // per-sku cost/margin from the recipe-based food-cost layer (single source of truth)
    const margins = await this.foodCost.menuMargins(user);
    const costBySku = new Map<string, { name: string; cost: number }>(margins.items.map((m: any) => [m.sku, { name: m.name, cost: m.cost }]));

    const sold = rows.map((r: any) => {
      const m = costBySku.get(r.itemId);
      const qty = n(r.qty);
      const revenue = r2(n(r.revenue));
      const avgPrice = qty > 0 ? r2(revenue / qty) : 0;
      const costed = !!m && (m.cost > 0 || margins.items.find((i: any) => i.sku === r.itemId)?.costed);
      const unitCost = m ? m.cost : null;
      const unitMargin = unitCost != null ? r2(avgPrice - unitCost) : null;
      const contribution = unitMargin != null ? r2(unitMargin * qty) : null;
      return { item_id: r.itemId, name: m?.name ?? r.description ?? r.itemId, qty, revenue, avg_price: avgPrice, unit_cost: unitCost, unit_margin: unitMargin, contribution, costed: !!costed };
    });

    const costed = sold.filter((s: any) => s.costed && s.qty > 0);
    const totalQty = costed.reduce((a: number, s: any) => a + s.qty, 0);
    const numItems = costed.length;
    const popThreshold = numItems > 0 ? (1 / numItems) * POP_RULE : 0; // 70% rule
    const avgUnitMargin = numItems > 0 ? costed.reduce((a: number, s: any) => a + (s.unit_margin ?? 0), 0) / numItems : 0;

    const ACTION: Record<string, { quadrant: string; quadrant_th: string; action: string; action_th: string }> = {
      star: { quadrant: 'Star', quadrant_th: 'ดาวเด่น', action: 'Keep & feature prominently; protect quality and price.', action_th: 'คงไว้และโปรโมต รักษาคุณภาพและราคา' },
      plowhorse: { quadrant: 'Plowhorse', quadrant_th: 'ม้างาน', action: 'Popular but low-margin: raise price modestly or cut recipe cost.', action_th: 'ขายดีแต่กำไรต่ำ: ขึ้นราคาเล็กน้อยหรือลดต้นทุนสูตร' },
      puzzle: { quadrant: 'Puzzle', quadrant_th: 'ปริศนา', action: 'High-margin but slow: reposition on the menu, rename, or promote.', action_th: 'กำไรดีแต่ขายช้า: จัดวางเมนูใหม่ เปลี่ยนชื่อ หรือโปรโมต' },
      dog: { quadrant: 'Dog', quadrant_th: 'สุนัข', action: 'Low popularity and low margin: consider removing or reworking.', action_th: 'ขายช้าและกำไรต่ำ: พิจารณาตัดออกหรือปรับสูตร' },
    };

    const items = costed
      .map((s: any) => {
        const share = totalQty > 0 ? r4(s.qty / totalQty) : 0;
        const highPop = share >= popThreshold;
        const highProfit = (s.unit_margin ?? 0) >= avgUnitMargin;
        const key = highPop && highProfit ? 'star' : highPop && !highProfit ? 'plowhorse' : !highPop && highProfit ? 'puzzle' : 'dog';
        return { ...s, mix_share: share, high_popularity: highPop, high_profitability: highProfit, ...ACTION[key] };
      })
      .sort((a: any, b: any) => (b.contribution ?? 0) - (a.contribution ?? 0));

    const countBy = (q: string) => items.filter((i: any) => i.quadrant === q).length;
    return {
      from, to,
      thresholds: { popularity_rule_pct: POP_RULE * 100, popularity_share_threshold: r4(popThreshold), avg_unit_margin: r2(avgUnitMargin) },
      summary: {
        items: items.length,
        units_sold: totalQty,
        total_contribution: r2(items.reduce((a: number, i: any) => a + (i.contribution ?? 0), 0)),
        stars: countBy('Star'), plowhorses: countBy('Plowhorse'), puzzles: countBy('Puzzle'), dogs: countBy('Dog'),
        uncosted: sold.filter((s: any) => !s.costed).length,
      },
      items,
      uncosted_items: sold.filter((s: any) => !s.costed).map((s: any) => ({ item_id: s.item_id, name: s.name, qty: s.qty, revenue: s.revenue })),
    };
  }

  // ── Daypart / hour-of-day demand from captured tenders, bucketed on the business clock (Asia/Bangkok),
  //    so a sale at 01:00 Bangkok is "late", never shifted by the server's UTC clock. ──
  async daypart(_user: JwtUser, opts?: { from?: string; to?: string }) {
    const db = this.db as any;
    const to = opts?.to ?? ymd();
    const from = opts?.from ?? to;
    // loose UTC pre-filter (±1 day) to bound the scan; exact day membership is decided on the business clock below
    const loFrom = shiftDays(from, -1);
    const hiTo = shiftDays(to, 2);
    const rows = await db
      .select({ amount: payments.amount, createdAt: payments.createdAt, capturedAt: payments.capturedAt })
      .from(payments)
      .where(and(sql`${payments.status}::text IN ('Captured','Settled')`, sql`${payments.createdAt} >= ${loFrom}`, sql`${payments.createdAt} < ${hiTo}`));

    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, revenue: 0, txns: 0 }));
    const byPart = new Map<string, { revenue: number; txns: number }>();
    for (const row of rows) {
      const when = new Date(row.capturedAt ?? row.createdAt);
      if (bizYmdDash(when) < from || bizYmdDash(when) > to) continue; // exact business-day window
      const h = bizParts(when).h;
      const amt = n(row.amount);
      byHour[h].revenue = r2(byHour[h].revenue + amt);
      byHour[h].txns += 1;
      const dp = daypartOf(h).key;
      const e = byPart.get(dp) ?? { revenue: 0, txns: 0 };
      e.revenue = r2(e.revenue + amt); e.txns += 1;
      byPart.set(dp, e);
    }

    const by_hour = byHour.map((b) => ({ ...b, avg_ticket: b.txns > 0 ? r2(b.revenue / b.txns) : 0 }));
    const by_daypart = DAYPART_ORDER.map((key) => {
      const e = byPart.get(key) ?? { revenue: 0, txns: 0 };
      const sample = daypartOf(key === 'late' ? 23 : key === 'breakfast' ? 6 : key === 'lunch' ? 11 : key === 'afternoon' ? 15 : 18);
      return { daypart: key, label_th: sample.label_th, revenue: r2(e.revenue), txns: e.txns, avg_ticket: e.txns > 0 ? r2(e.revenue / e.txns) : 0 };
    });
    const peakHour = by_hour.reduce((best, b) => (b.revenue > best.revenue ? b : best), by_hour[0]);
    const peakPart = by_daypart.reduce((best, b) => (b.revenue > best.revenue ? b : best), by_daypart[0]);
    const totalRevenue = r2(by_hour.reduce((a, b) => a + b.revenue, 0));
    const totalTxns = by_hour.reduce((a, b) => a + b.txns, 0);
    return {
      from, to,
      summary: { revenue: totalRevenue, txns: totalTxns, avg_ticket: totalTxns > 0 ? r2(totalRevenue / totalTxns) : 0, peak_hour: peakPart.txns ? peakHour.hour : null, peak_daypart: peakPart.txns ? peakPart.daypart : null },
      by_hour,
      by_daypart,
    };
  }

  // ── Void / discount (shrinkage & abuse) analytics from the manager-override audit. Surfaces who is
  //    voiding/discounting, why (reason codes), and the void rate vs total sales — a loss-prevention view. ──
  async voidsDiscounts(_user: JwtUser, opts?: { from?: string; to?: string }) {
    const db = this.db as any;
    const to = opts?.to ?? ymd();
    const from = opts?.from ?? to;
    const loFrom = shiftDays(from, -1);
    const hiTo = shiftDays(to, 2);
    const rows = await db
      .select({ action: posOverrides.action, reasonCode: posOverrides.reasonCode, amount: posOverrides.amount, requestedBy: posOverrides.requestedBy, approvedBy: posOverrides.approvedBy, createdAt: posOverrides.createdAt })
      .from(posOverrides)
      .where(and(sql`${posOverrides.createdAt} >= ${loFrom}`, sql`${posOverrides.createdAt} < ${hiTo}`));

    const inWindow = rows.filter((r: any) => { const d = bizYmdDash(new Date(r.createdAt)); return d >= from && d <= to; });

    const byAction = new Map<string, { count: number; amount: number }>();
    const byReason = new Map<string, { count: number; amount: number }>();
    const byActor = new Map<string, { count: number; amount: number }>();
    for (const r of inWindow) {
      const amt = n(r.amount);
      const a = byAction.get(r.action) ?? { count: 0, amount: 0 }; a.count++; a.amount = r2(a.amount + amt); byAction.set(r.action, a);
      const rk = r.reasonCode || '(none)';
      const rc = byReason.get(rk) ?? { count: 0, amount: 0 }; rc.count++; rc.amount = r2(rc.amount + amt); byReason.set(rk, rc);
      const ak = r.requestedBy || '(unknown)';
      const ac = byActor.get(ak) ?? { count: 0, amount: 0 }; ac.count++; ac.amount = r2(ac.amount + amt); byActor.set(ak, ac);
    }

    // sales count in the window for a void rate (voided overrides ÷ completed sales)
    const [salesCnt] = await db.select({ c: sql<string>`count(*)` }).from(custPosSales).where(and(gte(custPosSales.saleDate, from), lte(custPosSales.saleDate, to)));
    const salesCount = Number(salesCnt?.c ?? 0);
    const voids = byAction.get('void')?.count ?? 0;

    const mapOut = (m: Map<string, { count: number; amount: number }>, key: string) =>
      [...m.entries()].map(([k, v]) => ({ [key]: k, count: v.count, amount: v.amount })).sort((a: any, b: any) => b.amount - a.amount);

    return {
      from, to,
      summary: {
        events: inWindow.length,
        total_amount: r2(inWindow.reduce((a: number, r: any) => a + n(r.amount), 0)),
        sales_count: salesCount,
        void_count: voids,
        void_rate_pct: salesCount > 0 ? r1((voids / salesCount) * 100) : 0,
        discount_amount: byAction.get('discount')?.amount ?? 0,
      },
      by_action: mapOut(byAction, 'action'),
      by_reason: mapOut(byReason, 'reason_code'),
      by_actor: mapOut(byActor, 'requested_by'),
    };
  }
}

// add/subtract whole days from a YYYY-MM-DD string (UTC-noon anchor avoids DST/edge drift)
function shiftDays(ymdStr: string, days: number): string {
  const d = new Date(`${ymdStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
