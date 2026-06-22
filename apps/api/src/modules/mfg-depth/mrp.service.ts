import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { bomMaster, bomMasterLines, stockSnapshots } from '../../database/schema';
import { latestSnapshotDate, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface DemandLine { item_id: string; qty: number; need_by?: string }
export interface MrpRunDto { demand: DemandLine[]; lead_time_days?: number }

// Material Requirements Planning: explode demand through BOMs, net against on-hand, emit planned
// Make orders (items that have a BOM) and Buy orders (raw components / non-manufactured items).
@Injectable()
export class MrpService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async run(dto: MrpRunDto, _user: JwtUser) {
    const db = this.db as any;
    const lead = dto.lead_time_days ?? 7;

    // on-hand from the latest stock snapshot
    const snap = await latestSnapshotDate(db);
    const onHand = new Map<string, number>();
    if (snap) {
      const rows = await db.select({ itemId: stockSnapshots.itemId, qty: stockSnapshots.avQty }).from(stockSnapshots).where(eq(stockSnapshots.generateDate, snap));
      for (const r of rows) onHand.set(r.itemId, n(r.qty));
    }
    const avail = (id: string) => onHand.get(id) ?? 0;

    const make: any[] = [];
    const compNeed = new Map<string, { qty: number; desc: string | null; needBy: string | null }>();

    for (const d of dto.demand ?? []) {
      const net = r3(Math.max(0, n(d.qty) - avail(d.item_id)));
      if (net <= 0) continue;
      const [bom] = await db.select().from(bomMaster).where(eq(bomMaster.bomCode, d.item_id)).limit(1);
      if (!bom) {
        compNeed.set(d.item_id, { qty: (compNeed.get(d.item_id)?.qty ?? 0) + net, desc: null, needBy: d.need_by ?? null });
        continue;
      }
      make.push({ item_id: d.item_id, qty: net, need_by: d.need_by ?? null, source: 'demand' });
      const lines = await db.select().from(bomMasterLines).where(eq(bomMasterLines.bomId, Number(bom.id)));
      const factor = net / (n(bom.yieldQty) || 1);
      for (const l of lines) {
        const req = n(l.qtyUseUom) * factor;
        const cur = compNeed.get(l.itemId) ?? { qty: 0, desc: l.itemDescription, needBy: d.need_by ?? null };
        cur.qty += req;
        compNeed.set(l.itemId, cur);
      }
    }

    // net component requirements against on-hand → planned Buy orders
    const buy: any[] = [];
    for (const [itemId, info] of compNeed) {
      const net = r3(Math.max(0, info.qty - avail(itemId)));
      if (net > 0) buy.push({ item_id: itemId, description: info.desc, qty: net, gross_qty: r3(info.qty), on_hand: avail(itemId), need_by: info.needBy });
    }

    return {
      on_hand_date: snap, lead_time_days: lead,
      planned_make: make, planned_buy: buy,
      summary: { make_orders: make.length, buy_orders: buy.length, total_buy_qty: r3(buy.reduce((a, b) => a + b.qty, 0)) },
    };
  }
}
