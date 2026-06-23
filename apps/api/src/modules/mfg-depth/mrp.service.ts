import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { bomMaster, bomMasterLines, stockSnapshots, items, routings, routingOperations } from '../../database/schema';
import { latestSnapshotDate, n } from '../../database/queries';
import { ProcurementService } from '../procurement/procurement.service';
import type { JwtUser } from '../../common/decorators';

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const MAX_BOM_DEPTH = 25; // guard against circular BOMs

export interface DemandLine { item_id: string; qty: number; need_by?: string }
export interface MrpRunDto { demand: DemandLine[]; lead_time_days?: number; lot_sizing?: boolean }
export interface MrpCapacityDto extends MrpRunDto { work_centers?: { code: string; available_minutes: number }[] }

// Material Requirements Planning: explode demand through BOMs (MULTI-LEVEL / recursive), net against
// on-hand once per item (shared on-hand pool), and emit planned Make orders (items that have a BOM, at
// any level) and Buy orders (raw/leaf components). planToPr turns the planned Buy into a real PR.
@Injectable()
export class MrpService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly procurement: ProcurementService,
  ) {}

  async run(dto: MrpRunDto, _user: JwtUser) {
    const db = this.db as any;
    const lead = dto.lead_time_days ?? 7;

    // on-hand from the latest stock snapshot; `remaining` is consumed as requirements net against it.
    const snap = await latestSnapshotDate(db);
    const onHand = new Map<string, number>();
    if (snap) {
      const rows = await db.select({ itemId: stockSnapshots.itemId, qty: stockSnapshots.avQty }).from(stockSnapshots).where(eq(stockSnapshots.generateDate, snap));
      for (const r of rows) onHand.set(r.itemId, n(r.qty));
    }
    const remaining = new Map(onHand);

    // caches so each BOM/its lines are fetched once
    const bomCache = new Map<string, any | null>();
    const linesCache = new Map<number, any[]>();
    const getBom = async (itemId: string) => {
      if (!bomCache.has(itemId)) { const [b] = await db.select().from(bomMaster).where(eq(bomMaster.bomCode, itemId)).limit(1); bomCache.set(itemId, b ?? null); }
      return bomCache.get(itemId);
    };
    const getLines = async (bomId: number) => {
      if (!linesCache.has(bomId)) linesCache.set(bomId, await db.select().from(bomMasterLines).where(eq(bomMasterLines.bomId, bomId)));
      return linesCache.get(bomId)!;
    };

    const makeMap = new Map<string, { qty: number; gross: number; needBy: string | null; desc: string | null; level: number; source: string }>();
    const buyMap = new Map<string, { qty: number; gross: number; needBy: string | null; desc: string | null }>();

    // Net `qty` of `itemId` against the shared on-hand pool; if it has a BOM → make + recurse into its
    // components, else → buy. depth/path guard the recursion against circular BOMs.
    const require_ = async (itemId: string, qty: number, needBy: string | null, desc: string | null, depth: number, path: string[], source: string): Promise<void> => {
      if (depth > MAX_BOM_DEPTH || path.includes(itemId)) throw new BadRequestException({ code: 'CIRCULAR_BOM', message: `Circular/too-deep BOM at ${itemId}`, messageTh: `โครงสร้าง BOM วนซ้ำที่ ${itemId}` });
      const avail = remaining.get(itemId) ?? 0;
      const used = Math.min(avail, qty);
      remaining.set(itemId, avail - used);
      const net = r3(qty - used);
      if (net <= 0) return;
      const bom = await getBom(itemId);
      if (!bom) {
        const cur = buyMap.get(itemId) ?? { qty: 0, gross: 0, needBy, desc };
        cur.qty = r3(cur.qty + net); cur.gross = r3(cur.gross + qty);
        buyMap.set(itemId, cur);
        return;
      }
      const m = makeMap.get(itemId) ?? { qty: 0, gross: 0, needBy, desc: bom.productName ?? desc, level: depth, source };
      m.qty = r3(m.qty + net); m.gross = r3(m.gross + qty); m.level = Math.max(m.level, depth);
      makeMap.set(itemId, m);
      const factor = net / (n(bom.yieldQty) || 1);
      for (const l of await getLines(Number(bom.id))) {
        await require_(l.itemId, n(l.qtyUseUom) * factor, needBy, l.itemDescription, depth + 1, [...path, itemId], 'explosion');
      }
    };

    for (const d of dto.demand ?? []) await require_(d.item_id, n(d.qty), d.need_by ?? null, null, 0, [], 'demand');

    const planned_make = [...makeMap.entries()].map(([item_id, v]) => ({ item_id, qty: v.qty, gross_qty: v.gross, on_hand: onHand.get(item_id) ?? 0, need_by: v.needBy, level: v.level, source: v.source }));
    const planned_buy: any[] = [...buyMap.entries()].map(([item_id, v]) => ({ item_id, description: v.desc, qty: v.qty, gross_qty: v.gross, on_hand: onHand.get(item_id) ?? 0, need_by: v.needBy }));

    // Lot-sizing (opt-in): raise the net qty to the item's EOQ / minimum-order-qty and round up to the
    // order multiple, so planned buys respect economic + packaging constraints (not pure lot-for-lot).
    if (dto.lot_sizing && planned_buy.length) {
      const masters = await db.select().from(items);
      const byItem = new Map<string, any>(masters.map((m: any) => [String(m.itemId), m] as [string, any]));
      for (const b of planned_buy) {
        const m = byItem.get(b.item_id);
        const minQ = n(m?.minOrderQty), mult = n(m?.orderMultiple), S = n(m?.orderCost), H = n(m?.holdingCost);
        const annualD = n(m?.avgDailyUsage) * 365;
        const eoq = annualD > 0 && S > 0 && H > 0 ? Math.ceil(Math.sqrt((2 * annualD * S) / H)) : 0;
        let q = b.qty;
        if (minQ > 0) q = Math.max(q, minQ);
        if (eoq > q) q = eoq;
        if (mult > 0) q = Math.ceil(q / mult) * mult;
        b.eoq = eoq || null;
        b.ordered_qty = r3(q);
        b.lot_policy = eoq && b.ordered_qty === eoq ? 'eoq' : mult > 0 ? 'multiple' : minQ > 0 ? 'min' : 'lot-for-lot';
      }
    }

    const buyTotal = planned_buy.reduce((a, b) => a + (dto.lot_sizing ? n(b.ordered_qty) : b.qty), 0);
    return {
      on_hand_date: snap, lead_time_days: lead,
      planned_make, planned_buy,
      summary: { make_orders: planned_make.length, buy_orders: planned_buy.length, total_buy_qty: r3(buyTotal), max_level: planned_make.reduce((mx, m) => Math.max(mx, m.level), 0) },
    };
  }

  // Rough-cut capacity planning (RCCP): explode demand to planned Make orders, then load each work
  // centre from the product's routing (setup + run·qty minutes) and compare to the available minutes
  // supplied per work centre — flags overloaded centres so a planner can re-time or offload.
  async capacity(dto: MrpCapacityDto, user: JwtUser) {
    const db = this.db as any;
    const plan = await this.run(dto, user);
    const avail = new Map<string, number>((dto.work_centers ?? []).map((w) => [w.code, n(w.available_minutes)]));
    const load = new Map<string, number>();
    for (const mk of plan.planned_make) {
      // routing for the make item (by product_item_id, else routing_code)
      let [rt] = await db.select().from(routings).where(eq(routings.productItemId, mk.item_id)).limit(1);
      if (!rt) [rt] = await db.select().from(routings).where(eq(routings.routingCode, mk.item_id)).limit(1);
      if (!rt) continue;
      const ops = await db.select().from(routingOperations).where(eq(routingOperations.routingId, Number(rt.id)));
      for (const op of ops) {
        const wc = op.workCenter ?? 'UNASSIGNED';
        const mins = n(op.setupMin) + n(op.runMinPerUnit) * mk.qty;
        load.set(wc, (load.get(wc) ?? 0) + mins);
      }
    }
    const work_centers = [...load.entries()].map(([work_center, load_minutes]) => {
      const available_minutes = avail.has(work_center) ? avail.get(work_center)! : null;
      const utilization_pct = available_minutes && available_minutes > 0 ? r3((load_minutes / available_minutes) * 100) : null;
      return { work_center, load_minutes: r3(load_minutes), available_minutes, utilization_pct, overloaded: available_minutes != null && load_minutes > available_minutes };
    });
    return { planned_make: plan.planned_make, work_centers, summary: { centers: work_centers.length, overloaded: work_centers.filter((w) => w.overloaded).length, total_load_minutes: r3([...load.values()].reduce((a, b) => a + b, 0)) } };
  }

  // Run MRP and turn the planned Buy orders into a single consolidated Purchase Requisition (reuses the
  // normal PR workflow → approvals/PO/GR downstream). Returns the PR plus the plan for transparency.
  async planToPr(dto: MrpRunDto, user: JwtUser) {
    const plan = await this.run(dto, user);
    if (!plan.planned_buy.length) return { pr_no: null as string | null, message: 'No buy requirements', messageTh: 'ไม่มีรายการต้องสั่งซื้อ', planned_make: plan.planned_make, planned_buy: plan.planned_buy, summary: plan.summary };
    const pr: any = await this.procurement.createPr({
      remarks: 'MRP planned buy',
      items: plan.planned_buy.map((b) => ({ item_id: b.item_id, item_description: b.description ?? undefined, request_qty: dto.lot_sizing ? n(b.ordered_qty) : b.qty, reason: dto.lot_sizing ? `MRP (${b.lot_policy})` : 'MRP' })),
    }, user);
    return { pr_no: pr.pr_no as string | null, pr_status: pr.status, planned_make: plan.planned_make, planned_buy: plan.planned_buy, summary: plan.summary };
  }
}
