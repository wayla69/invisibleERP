import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { workCenters, routings, routingOperations, workOrders } from '../../database/schema';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const DEFAULT_MIN_PER_DAY = 480; // one 8h shift
// Add whole days to a yyyy-mm-dd string (UTC date arithmetic — date-only, no TZ drift).
const addDays = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.floor(Number(days) || 0));
  return d.toISOString().slice(0, 10);
};

export interface WorkCenterDto { code: string; name?: string; minutes_per_day?: number; active?: boolean }
export interface ScheduleWoDto { wo_no: string; due_by?: string }
export interface ScheduleDto { work_orders?: ScheduleWoDto[]; horizon_start?: string; minutes_per_day?: number }

// Advanced production scheduling (APS, docs/22 Phase A) — a single-shift, unit-capacity finite scheduler.
// It sequences each work order's routing operations onto their work centres: an operation can't start before
// its predecessor (same WO, lower op_no) finishes OR before its work centre is free, and a centre runs one
// operation at a time up to minutes_per_day per calendar day (an op that won't fit the rest of a day rolls to
// the next morning). WOs are dispatched earliest-due-date first (EDD). Output: per-operation start/finish, a
// per-centre dispatch queue + utilisation, the makespan, and late flags. Deterministic; posts no GL.
@Injectable()
export class ApsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Work-centre master ──
  async upsertWorkCenter(dto: WorkCenterDto, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    const code = dto.code.trim();
    if (!code) throw new BadRequestException({ code: 'BAD_CODE', message: 'work-centre code is required', messageTh: 'ต้องระบุรหัสศูนย์งาน' });
    const minutes = dto.minutes_per_day != null ? r2(dto.minutes_per_day) : DEFAULT_MIN_PER_DAY;
    if (minutes <= 0) throw new BadRequestException({ code: 'BAD_CAPACITY', message: 'minutes_per_day must be positive', messageTh: 'เวลาทำงานต่อวันต้องมากกว่าศูนย์' });
    const conds = [eq(workCenters.code, code)];
    if (tenantId != null) conds.push(eq(workCenters.tenantId, tenantId));
    const [existing] = await db.select().from(workCenters).where(and(...conds)).limit(1);
    if (existing) {
      await db.update(workCenters).set({ name: dto.name ?? existing.name, minutesPerDay: String(minutes), active: dto.active ?? existing.active }).where(eq(workCenters.id, Number(existing.id)));
    } else {
      await db.insert(workCenters).values({ tenantId, code, name: dto.name ?? null, minutesPerDay: String(minutes), active: dto.active ?? true, createdBy: user.username });
    }
    return this.listWorkCenters(user);
  }

  async listWorkCenters(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(workCenters).orderBy(desc(workCenters.id)).limit(500);
    return { work_centers: rows.map((w: any) => ({ id: Number(w.id), code: w.code, name: w.name, minutes_per_day: n(w.minutesPerDay), active: w.active })), count: rows.length };
  }

  // ── The finite-capacity schedule ──
  async schedule(dto: ScheduleDto, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    const horizonStart = dto.horizon_start ?? new Date().toISOString().slice(0, 10);
    const shopMin = dto.minutes_per_day && dto.minutes_per_day > 0 ? r2(dto.minutes_per_day) : DEFAULT_MIN_PER_DAY;

    // Resolve the WOs to schedule: an explicit list, else every Open/Released WO for the tenant.
    const dueBy = new Map<string, string | null>();
    let woRows: any[];
    if (dto.work_orders && dto.work_orders.length) {
      const nos = dto.work_orders.map((w) => w.wo_no);
      for (const w of dto.work_orders) dueBy.set(w.wo_no, w.due_by ?? null);
      woRows = await db.select().from(workOrders).where(inArray(workOrders.woNo, nos));
    } else {
      const conds = [inArray(workOrders.status, ['Open', 'Released'])];
      if (tenantId != null) conds.push(eq(workOrders.tenantId, tenantId));
      woRows = await db.select().from(workOrders).where(and(...conds));
    }
    if (!woRows.length) return { horizon_start: horizonStart, minutes_per_day: shopMin, operations: [], work_centers: [], makespan_minutes: 0, makespan_days: 0, late: [], summary: { work_orders: 0, operations: 0, scheduled: 0, unscheduled_no_routing: 0, late: 0 } };

    // Per-centre per-WC capacity (minutes/day) from the master; default for an unknown centre.
    const wcRows = await db.select().from(workCenters);
    const wcCap = new Map<string, number>(wcRows.map((w: any) => [w.code, n(w.minutesPerDay) || shopMin]));

    // Build the operation list: each WO → its routing (by product_item_id, else routing_code = bom/product)
    // → routing_operations ordered by op_no, with duration = setup + run·qty.
    type Op = { wo_no: string; op_no: number; work_center: string; duration: number; due: string | null; wo_order: number };
    const ops: Op[] = [];
    const noRouting: string[] = [];
    let woOrder = 0;
    // Dispatch WOs earliest-due-first (nulls last), then by discovery order — stable EDD.
    const sortedWo = [...woRows].sort((a, b) => {
      const da = dueBy.get(a.woNo) ?? null, dbb = dueBy.get(b.woNo) ?? null;
      if (da && dbb) return da.localeCompare(dbb);
      if (da) return -1; if (dbb) return 1; return Number(a.id) - Number(b.id);
    });
    for (const wo of sortedWo) {
      const order = woOrder++;
      let [rt] = await db.select().from(routings).where(eq(routings.productItemId, wo.productItemId)).limit(1);
      if (!rt) [rt] = await db.select().from(routings).where(eq(routings.routingCode, wo.bomCode ?? wo.productItemId)).limit(1);
      if (!rt) { noRouting.push(wo.woNo); continue; }
      const rops = await db.select().from(routingOperations).where(eq(routingOperations.routingId, Number(rt.id)));
      rops.sort((a: any, b: any) => n(a.opNo) - n(b.opNo));
      const qty = n(wo.qtyPlanned) || 1;
      for (const op of rops) {
        const duration = r2(n(op.setupMin) + n(op.runMinPerUnit) * qty);
        ops.push({ wo_no: wo.woNo, op_no: n(op.opNo), work_center: op.workCenter ?? 'UNASSIGNED', duration, due: dueBy.get(wo.woNo) ?? null, wo_order: order });
      }
    }

    // Place a duration on a work centre at the earliest feasible minute ≥ readyAt, respecting the centre's
    // daily capacity: if the op won't fit in the remainder of its current day, roll to the next day's start.
    const wcFree = new Map<string, number>(); // elapsed minutes the centre is busy until
    const place = (wc: string, readyAt: number, duration: number) => {
      const cap = wcCap.get(wc) ?? shopMin;
      let start = Math.max(wcFree.get(wc) ?? 0, readyAt);
      const within = start % cap;
      if (within > 0 && within + duration > cap && duration <= cap) start = (Math.floor(start / cap) + 1) * cap; // roll to next day
      const finish = start + duration;
      wcFree.set(wc, finish);
      return { start, finish };
    };

    // Schedule WO by WO (EDD order); within a WO, ops run in op_no order (predecessor finish gates the next).
    const scheduled: any[] = [];
    const woReady = new Map<string, number>();
    const minToDate = (min: number) => addDays(horizonStart, Math.floor(min / shopMin));
    for (const op of ops) {
      const readyAt = woReady.get(op.wo_no) ?? 0;
      const { start, finish } = place(op.work_center, readyAt, op.duration);
      woReady.set(op.wo_no, finish);
      scheduled.push({
        wo_no: op.wo_no, op_no: op.op_no, work_center: op.work_center, duration_min: op.duration,
        start_min: r2(start), finish_min: r2(finish), start_date: minToDate(start), finish_date: minToDate(finish), due_by: op.due,
      });
    }

    const makespan = scheduled.reduce((mx, s) => Math.max(mx, s.finish_min), 0);
    // Per-WO finish + lateness (only when a due date was supplied).
    const woFinish = new Map<string, number>();
    for (const s of scheduled) woFinish.set(s.wo_no, Math.max(woFinish.get(s.wo_no) ?? 0, s.finish_min));
    const late = [...woFinish.entries()]
      .map(([wo_no, fin]) => ({ wo_no, finish_date: minToDate(fin), due_by: dueBy.get(wo_no) ?? null }))
      .filter((w) => w.due_by && w.finish_date > w.due_by);
    // Per-work-centre load, utilisation (vs capacity over the makespan horizon) + dispatch queue.
    const horizonDays = Math.max(1, Math.ceil(makespan / shopMin));
    const wcAgg = new Map<string, { load: number; ops: any[] }>();
    for (const s of scheduled) {
      const a = wcAgg.get(s.work_center) ?? { load: 0, ops: [] };
      a.load += s.duration_min; a.ops.push(s); wcAgg.set(s.work_center, a);
    }
    const work_centers_out = [...wcAgg.entries()].map(([code, a]) => {
      const cap = wcCap.get(code) ?? shopMin;
      const capacityMin = cap * horizonDays;
      return {
        work_center: code, load_minutes: r2(a.load), capacity_minutes: r2(capacityMin),
        utilization_pct: capacityMin > 0 ? r2((a.load / capacityMin) * 100) : null,
        overloaded: a.load > capacityMin,
        dispatch: a.ops.sort((x, y) => x.start_min - y.start_min).map((o) => ({ wo_no: o.wo_no, op_no: o.op_no, start_min: o.start_min, finish_min: o.finish_min, start_date: o.start_date })),
      };
    }).sort((x, y) => y.load_minutes - x.load_minutes);

    return {
      horizon_start: horizonStart, minutes_per_day: shopMin,
      operations: scheduled, work_centers: work_centers_out,
      makespan_minutes: r2(makespan), makespan_days: horizonDays,
      late,
      summary: { work_orders: sortedWo.length, operations: ops.length, scheduled: scheduled.length, unscheduled_no_routing: noRouting.length, late: late.length, no_routing: noRouting },
    };
  }
}
