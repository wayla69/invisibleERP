import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, asc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { routings, routingOperations } from '../../database/schema';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;

export interface RoutingOpDto { op_no: number; work_center?: string; description?: string; setup_min?: number; run_min_per_unit?: number; labor_rate?: number }
export interface CreateRoutingDto { routing_code: string; product_item_id?: string; name?: string; operations?: RoutingOpDto[] }

// Labor cost for a batch qty: per-operation setup (per batch) + run (per unit), all at the operation labor rate.
export function routingLabor(ops: { setupMin?: any; runMinPerUnit?: any; laborRate?: any }[], qty: number): number {
  return r2(ops.reduce((a, o) => a + (n(o.setupMin) / 60 + (n(o.runMinPerUnit) * qty) / 60) * n(o.laborRate), 0));
}

@Injectable()
export class RoutingService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async createRouting(dto: CreateRoutingDto, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    const [r] = await db.insert(routings).values({
      tenantId, routingCode: dto.routing_code, productItemId: dto.product_item_id ?? null, name: dto.name ?? null, createdBy: user.username,
    }).returning({ id: routings.id });
    const ops = dto.operations ?? [];
    if (ops.length)
      await db.insert(routingOperations).values(ops.map((o) => ({
        routingId: Number(r!.id), tenantId, opNo: String(o.op_no), workCenter: o.work_center ?? null, description: o.description ?? null,
        setupMin: fx(o.setup_min ?? 0, 2), runMinPerUnit: fx(o.run_min_per_unit ?? 0, 4), laborRate: fx(o.labor_rate ?? 0, 2),
      })));
    return this.get(dto.routing_code);
  }

  async list(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(routings).orderBy(routings.routingCode);
    return { routings: rows.map((r: any) => ({ routing_code: r.routingCode, product_item_id: r.productItemId, name: r.name, active: r.active !== false })), count: rows.length };
  }

  async get(code: string) {
    const db = this.db;
    const [r] = await db.select().from(routings).where(eq(routings.routingCode, code)).limit(1);
    if (!r) throw new NotFoundException({ code: 'ROUTING_NOT_FOUND', message: `Routing ${code} not found`, messageTh: 'ไม่พบเส้นทางการผลิต' });
    const ops = await db.select().from(routingOperations).where(eq(routingOperations.routingId, Number(r.id))).orderBy(asc(routingOperations.opNo));
    return {
      routing_code: r.routingCode, product_item_id: r.productItemId, name: r.name, active: r.active !== false,
      operations: ops.map((o: any) => ({ op_no: n(o.opNo), work_center: o.workCenter, description: o.description, setup_min: n(o.setupMin), run_min_per_unit: n(o.runMinPerUnit), labor_rate: n(o.laborRate) })),
    };
  }
}
