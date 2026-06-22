import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, asc, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { workOrders, workOrderOperations, routings, routingOperations } from '../../database/schema';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { routingLabor } from './routing.service';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;

export interface ReportOpDto { completed_qty?: number; scrap_qty?: number }

// Shop-floor execution: attach a routing's operations to a work order, then report progress per op.
@Injectable()
export class ShopFloorService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async wo(woNo: string) {
    const [w] = await (this.db as any).select().from(workOrders).where(eq(workOrders.woNo, woNo)).limit(1);
    if (!w) throw new NotFoundException({ code: 'WO_NOT_FOUND', message: `Work order ${woNo} not found`, messageTh: 'ไม่พบใบสั่งผลิต' });
    return w;
  }

  // Generate WO operations from a routing, scaled to the WO planned qty (per-op labor pre-computed).
  async generate(woNo: string, routingCode: string, user: JwtUser) {
    const db = this.db as any;
    const w = await this.wo(woNo);
    const tenantId = w.tenantId ?? user.tenantId ?? null;
    const [r] = await db.select().from(routings).where(eq(routings.routingCode, routingCode)).limit(1);
    if (!r) throw new NotFoundException({ code: 'ROUTING_NOT_FOUND', message: `Routing ${routingCode} not found`, messageTh: 'ไม่พบเส้นทางการผลิต' });
    const ops = await db.select().from(routingOperations).where(eq(routingOperations.routingId, Number(r.id))).orderBy(asc(routingOperations.opNo));
    if (!ops.length) throw new BadRequestException({ code: 'NO_OPERATIONS', message: 'Routing has no operations', messageTh: 'เส้นทางการผลิตยังไม่มีขั้นตอน' });

    const qty = n(w.qtyPlanned);
    // clear any previously-generated ops for this WO, then insert fresh
    await db.delete(workOrderOperations).where(eq(workOrderOperations.woId, Number(w.id)));
    await db.insert(workOrderOperations).values(ops.map((o: any) => ({
      woId: Number(w.id), tenantId, opNo: String(n(o.opNo)), workCenter: o.workCenter, description: o.description,
      plannedQty: fx(qty, 3), laborCost: fx(routingLabor([o], qty), 2), status: 'Pending',
    })));
    return this.listOps(woNo);
  }

  // Report progress on one operation (accumulates completed + scrap).
  async report(woNo: string, opNo: number, dto: ReportOpDto, _user: JwtUser) {
    const db = this.db as any;
    const w = await this.wo(woNo);
    const [op] = await db.select().from(workOrderOperations).where(and(eq(workOrderOperations.woId, Number(w.id)), eq(workOrderOperations.opNo, String(opNo)))).limit(1);
    if (!op) throw new NotFoundException({ code: 'OP_NOT_FOUND', message: `Operation ${opNo} not found on ${woNo}`, messageTh: 'ไม่พบขั้นตอนการผลิต' });
    const completed = r2(n(op.completedQty) + n(dto.completed_qty));
    const scrap = r2(n(op.scrapQty) + n(dto.scrap_qty));
    const now = new Date();
    const status = completed + scrap >= n(op.plannedQty) ? 'Done' : 'InProgress';
    await db.update(workOrderOperations).set({
      completedQty: fx(completed, 3), scrapQty: fx(scrap, 3), status,
      startedAt: op.startedAt ?? now, completedAt: status === 'Done' ? now : null,
    }).where(eq(workOrderOperations.id, Number(op.id)));
    return { wo_no: woNo, op_no: opNo, completed_qty: completed, scrap_qty: scrap, status };
  }

  async listOps(woNo: string) {
    const db = this.db as any;
    const w = await this.wo(woNo);
    const ops = await db.select().from(workOrderOperations).where(eq(workOrderOperations.woId, Number(w.id))).orderBy(asc(workOrderOperations.opNo));
    const done = ops.filter((o: any) => o.status === 'Done').length;
    return {
      wo_no: woNo, all_done: ops.length > 0 && done === ops.length, op_count: ops.length, done_count: done,
      operations: ops.map((o: any) => ({ op_no: n(o.opNo), work_center: o.workCenter, description: o.description, planned_qty: n(o.plannedQty), completed_qty: n(o.completedQty), scrap_qty: n(o.scrapQty), labor_cost: n(o.laborCost), status: o.status })),
    };
  }
}
