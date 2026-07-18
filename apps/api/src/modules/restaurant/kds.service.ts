import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, inArray, asc, desc, and, gte, isNotNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { dineInOrderItems, kitchenStations, dineInOrders, diningTables } from '../../database/schema';
import { n } from '../../database/queries';
import { bizYmdDash } from '../../common/bizdate';
import type { JwtUser } from '../../common/decorators';
import type { StationBody } from './dto';
import type { z } from 'zod';
import { GuestProfileService } from './guest-profile.service';

// KDS prep-time SLA (POS-4): elapsed vs target prep minutes → aging state (green/amber/red on the board).
// < target = on time; < target×1.5 = at risk; else overdue. Computed server-side so the board, the expo
// pass and the station-load view all agree on the colour without re-deriving the rule per screen.
export type SlaState = 'ok' | 'warn' | 'late';
export const kdsSla = (elapsedMin: number, prepMin: number): SlaState =>
  elapsedMin < prepMin ? 'ok' : elapsedMin < prepMin * 1.5 ? 'warn' : 'late';

// Hard "stuck" alarm (POS): a line still cooking past this many minutes since it fired must raise a loud
// warning on the board regardless of its per-dish prep SLA — a ticket that has hung this long needs a human.
export const kdsStuckMinutes = (): number => Number(process.env.KDS_STUCK_MINUTES ?? 10);

type KdsStatus = typeof dineInOrderItems.$inferSelect['kdsStatus'];
type ReadyItem = { item_id: number; name: string; qty: number; station_name: string | null; course: number; ready_at: Date | null; ready_min: number };
const ACTIVE_KDS = ['queued', 'preparing', 'ready'] as KdsStatus[];
const LOAD_KDS = ['queued', 'preparing', 'ready', 'served'] as KdsStatus[];

@Injectable()
export class KdsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly guests?: GuestProfileService, // consent-gated allergy flags on tickets
  ) {}

  // Prep-time auto-learn (F5): the rolling average COMPLETION time (fired → served) per menu SKU over the
  // trailing window, with ≥3 samples so a single outlier can't skew it. Used as the prep estimate that
  // drives the SLA colours + ETA, so the board gets more accurate the more the kitchen cooks.
  private async learnedPrepMap(days = 14, minSamples = 3): Promise<Map<string, number>> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db.select({ sku: dineInOrderItems.itemId, firedAt: dineInOrderItems.firedAt, servedAt: dineInOrderItems.servedAt })
      .from(dineInOrderItems)
      .where(and(eq(dineInOrderItems.kdsStatus, 'served'), isNotNull(dineInOrderItems.itemId), isNotNull(dineInOrderItems.firedAt), isNotNull(dineInOrderItems.servedAt), gte(dineInOrderItems.servedAt, since)));
    const acc = new Map<string, { sum: number; n: number }>();
    for (const r of rows) {
      if (!r.sku || !r.firedAt || !r.servedAt) continue;
      const mins = (new Date(r.servedAt).getTime() - new Date(r.firedAt).getTime()) / 60000;
      if (mins <= 0 || mins > 240) continue; // ignore zero/degenerate and absurd (>4h) samples
      const e = acc.get(r.sku) ?? { sum: 0, n: 0 }; e.sum += mins; e.n += 1; acc.set(r.sku, e);
    }
    const out = new Map<string, number>();
    for (const [sku, e] of acc) if (e.n >= minSamples) out.set(sku, Math.max(1, Math.round(e.sum / e.n)));
    return out;
  }

  // Manager view: learned average completion time per dish (+ sample count) — the "prep-time learning" report.
  async prepTimes(_user: JwtUser) {
    const rows = await this.db.select({ sku: dineInOrderItems.itemId, name: dineInOrderItems.name, firedAt: dineInOrderItems.firedAt, servedAt: dineInOrderItems.servedAt })
      .from(dineInOrderItems)
      .where(and(eq(dineInOrderItems.kdsStatus, 'served'), isNotNull(dineInOrderItems.itemId), isNotNull(dineInOrderItems.firedAt), isNotNull(dineInOrderItems.servedAt), gte(dineInOrderItems.servedAt, new Date(Date.now() - 14 * 86_400_000))));
    const acc = new Map<string, { name: string; sum: number; n: number }>();
    for (const r of rows) {
      if (!r.sku || !r.firedAt || !r.servedAt) continue;
      const mins = (new Date(r.servedAt).getTime() - new Date(r.firedAt).getTime()) / 60000;
      if (mins <= 0 || mins > 240) continue;
      const e = acc.get(r.sku) ?? { name: r.name, sum: 0, n: 0 }; e.sum += mins; e.n += 1; acc.set(r.sku, e);
    }
    const dishes = [...acc.entries()].map(([sku, e]) => ({ sku, name: e.name, avg_prep_min: Math.round((e.sum / e.n) * 10) / 10, samples: e.n }))
      .sort((a, b) => b.avg_prep_min - a.avg_prep_min);
    return { dishes, generated_at: new Date().toISOString() };
  }

  // active kitchen items grouped by station, oldest-fired first (cook next), excl served/voided
  async feed(_user: JwtUser) {
    const db = this.db;
    const learned = await this.learnedPrepMap(); // F5: prefer the learned completion time as the prep estimate
    const rows = await db.select({
      itemId: dineInOrderItems.id, sku: dineInOrderItems.itemId, name: dineInOrderItems.name, qty: dineInOrderItems.qty,
      modifiers: dineInOrderItems.modifiers, notes: dineInOrderItems.notes, kdsStatus: dineInOrderItems.kdsStatus,
      firedAt: dineInOrderItems.firedAt, estPrep: dineInOrderItems.estPrepMinutes,
      isBuffet: dineInOrderItems.isBuffet, createdBy: dineInOrderItems.createdBy, course: dineInOrderItems.course, kdsPriority: dineInOrderItems.kdsPriority,
      stationId: kitchenStations.id, stationCode: kitchenStations.code, stationName: kitchenStations.name, stationSort: kitchenStations.sort, stationPrep: kitchenStations.defaultPrepMinutes,
      orderNo: dineInOrders.orderNo, tableNo: diningTables.tableNo, tableId: dineInOrders.tableId,
    }).from(dineInOrderItems)
      .innerJoin(kitchenStations, eq(dineInOrderItems.stationId, kitchenStations.id))
      .innerJoin(dineInOrders, eq(dineInOrderItems.orderId, dineInOrders.id))
      .leftJoin(diningTables, eq(dineInOrders.tableId, diningTables.id))
      .where(inArray(dineInOrderItems.kdsStatus, ['queued', 'preparing', 'ready']))
      // fire-time order first (oldest lot cooks next); WITHIN one fire lot the higher food-priority plates
      // out first (same-lot prioritisation); course breaks any remaining tie.
      .orderBy(asc(kitchenStations.sort), asc(dineInOrderItems.firedAt), desc(dineInOrderItems.kdsPriority), asc(dineInOrderItems.course));

    // Consent-gated dining cautions of the guest seated at each ticket's table — the kitchen sees
    // "แพ้กุ้ง" on the ticket itself. Computed at read time (never stored on the item), best-effort.
    let guestFlags = new Map<number, any>();
    try {
      const tableIds = [...new Set(rows.map((r: any) => (r.tableId != null ? Number(r.tableId) : null)).filter((x: any): x is number => x != null))];
      guestFlags = (await this.guests?.serviceFlagsByTable(tableIds, _user.tenantId as number)) ?? guestFlags;
    } catch { /* the board must render regardless */ }

    const now = Date.now();
    const stuckMin = kdsStuckMinutes();
    let stuckCount = 0;
    let waitSum = 0;
    const stations = new Map<number, any>();
    for (const r of rows) {
      const sid = Number(r.stationId);
      if (!stations.has(sid)) stations.set(sid, { station_id: sid, station_code: r.stationCode, station_name: r.stationName, items: [] });
      const fired = r.firedAt ? new Date(r.firedAt).getTime() : now;
      const prep = (r.sku && learned.get(r.sku)) || r.estPrep || r.stationPrep || 10; // F5: learned → snapshot → station default
      const elapsedMin = Math.floor((now - fired) / 60000);
      waitSum += elapsedMin;
      const stuck = elapsedMin >= stuckMin; // hard aging alarm: hung this long since firing → needs a human
      if (stuck) stuckCount += 1;
      stations.get(sid).items.push({
        item_id: Number(r.itemId), sku: r.sku ?? null, order_no: r.orderNo, table_label: r.tableNo ?? null, table_id: r.tableId != null ? Number(r.tableId) : null,
        station_code: r.stationCode, station_name: r.stationName, name: r.name, qty: n(r.qty),
        modifiers: r.modifiers ?? [], notes: r.notes, kds_status: r.kdsStatus, fired_at: r.firedAt,
        is_buffet: r.isBuffet, from_diner: r.createdBy === 'diner:qr', course: r.course ?? 1, priority: Number(r.kdsPriority) || 0,
        elapsed_min: elapsedMin, prep_min: prep, remaining_min: Math.max(0, prep - elapsedMin),
        sla: kdsSla(elapsedMin, prep), // aging colour (POS-4)
        stuck, // over the hard stuck threshold (default 10 min)
        guest_allergies: (r.tableId != null && guestFlags.get(Number(r.tableId))?.allergies) || [],
        guest_dietary: (r.tableId != null ? guestFlags.get(Number(r.tableId))?.dietary : null) ?? null,
      });
    }
    // Live throughput summary for the board header: current WIP + average wait of active lines, and the
    // business-day (Asia/Bangkok) average completion time (fired → served) with the served count.
    const dayStartApprox = new Date(now - 30 * 3600 * 1000); // bound the served scan; biz-day filter below is exact
    const servedRows = await db.select({ firedAt: dineInOrderItems.firedAt, servedAt: dineInOrderItems.servedAt })
      .from(dineInOrderItems)
      .where(and(eq(dineInOrderItems.kdsStatus, 'served'), isNotNull(dineInOrderItems.servedAt), isNotNull(dineInOrderItems.firedAt), gte(dineInOrderItems.servedAt, dayStartApprox)));
    const today = bizYmdDash();
    let prepSum = 0, servedToday = 0;
    for (const s of servedRows) {
      if (!s.servedAt || !s.firedAt || bizYmdDash(new Date(s.servedAt)) !== today) continue;
      prepSum += Math.max(0, (new Date(s.servedAt).getTime() - new Date(s.firedAt).getTime()) / 60000);
      servedToday += 1;
    }
    const summary = {
      active_count: rows.length,
      avg_wait_min: rows.length ? Math.round(waitSum / rows.length) : 0,
      served_today: servedToday,
      avg_prep_today_min: servedToday ? Math.round(prepSum / servedToday) : 0,
    };
    return { stations: [...stations.values()], stuck_count: stuckCount, stuck_minutes: stuckMin, summary, generated_at: new Date().toISOString() };
  }

  // Expo / order-ready pass (POS-4): aggregates the active kitchen lines BY ORDER so the expeditor sees
  // whole tickets. An order is `all_ready` (ready for pass/runner) once nothing is still cooking; a ticket
  // with anything queued/preparing shows how many lines remain. Excludes served/voided (already off the pass).
  async expo(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select({
      itemId: dineInOrderItems.id, name: dineInOrderItems.name, qty: dineInOrderItems.qty,
      kdsStatus: dineInOrderItems.kdsStatus, readyAt: dineInOrderItems.readyAt, course: dineInOrderItems.course, kdsPriority: dineInOrderItems.kdsPriority,
      stationName: kitchenStations.name,
      orderId: dineInOrders.id, orderNo: dineInOrders.orderNo, firedAt: dineInOrders.firedAt,
      tableNo: diningTables.tableNo,
    }).from(dineInOrderItems)
      .innerJoin(kitchenStations, eq(dineInOrderItems.stationId, kitchenStations.id))
      .innerJoin(dineInOrders, eq(dineInOrderItems.orderId, dineInOrders.id))
      .leftJoin(diningTables, eq(dineInOrders.tableId, diningTables.id))
      .where(inArray(dineInOrderItems.kdsStatus, ACTIVE_KDS))
      // oldest ticket first; within it the higher food-priority line lists first for the runner.
      .orderBy(asc(dineInOrders.firedAt), desc(dineInOrderItems.kdsPriority), asc(dineInOrderItems.course));

    const now = Date.now();
    const orders = new Map<number, any>();
    for (const r of rows) {
      const oid = Number(r.orderId);
      if (!orders.has(oid)) orders.set(oid, {
        order_id: oid, order_no: r.orderNo, table_label: r.tableNo ?? null,
        fired_at: r.firedAt, ready_items: [] as ReadyItem[], pending_count: 0,
      });
      const o = orders.get(oid);
      if (String(r.kdsStatus) === 'ready') {
        const readyMs = r.readyAt ? new Date(r.readyAt).getTime() : now;
        o.ready_items.push({ item_id: Number(r.itemId), name: r.name, qty: n(r.qty), station_name: r.stationName, course: r.course ?? 1, ready_at: r.readyAt, ready_min: Math.max(0, Math.floor((now - readyMs) / 60000)) });
      } else {
        o.pending_count += 1;
      }
    }
    // Only tickets with at least one ready line belong on the pass. Ready-to-run orders float to the top,
    // then the longest-waiting food first.
    const tickets = [...orders.values()]
      .filter((o) => o.ready_items.length > 0)
      .map((o) => ({
        ...o,
        ready_count: o.ready_items.length,
        all_ready: o.pending_count === 0,
        oldest_ready_min: o.ready_items.reduce((m: number, it: any) => Math.max(m, it.ready_min), 0),
      }))
      .sort((a, b) => (a.all_ready === b.all_ready ? b.oldest_ready_min - a.oldest_ready_min : a.all_ready ? -1 : 1));
    return { tickets, ready_orders: tickets.filter((t) => t.all_ready).length, generated_at: new Date().toISOString() };
  }

  // Station load view (POS-4): per-station work-in-progress + all-day throughput. `active`/`overdue` and the
  // "all-day" per-item quantity summary drive load balancing; `bumped_today`/`recalls_today` (business-day
  // scoped, Asia/Bangkok) are the bump/recall counts. Idle active stations still appear (zeroed).
  async stationLoad(_user: JwtUser) {
    const db = this.db;
    const today = bizYmdDash();
    const stationRows = await db.select().from(kitchenStations).where(eq(kitchenStations.active, true)).orderBy(asc(kitchenStations.sort));
    const rows = await db.select({
      stationId: dineInOrderItems.stationId, name: dineInOrderItems.name, qty: dineInOrderItems.qty,
      kdsStatus: dineInOrderItems.kdsStatus, firedAt: dineInOrderItems.firedAt, servedAt: dineInOrderItems.servedAt,
      estPrep: dineInOrderItems.estPrepMinutes, recallCount: dineInOrderItems.recallCount,
      stationPrep: kitchenStations.defaultPrepMinutes,
    }).from(dineInOrderItems)
      .innerJoin(kitchenStations, eq(dineInOrderItems.stationId, kitchenStations.id))
      .where(inArray(dineInOrderItems.kdsStatus, LOAD_KDS));

    const now = Date.now();
    const map = new Map<number, any>();
    for (const s of stationRows) {
      map.set(Number(s.id), {
        station_id: Number(s.id), station_code: s.code, station_name: s.name, default_prep_minutes: s.defaultPrepMinutes ?? 10,
        active: 0, queued: 0, preparing: 0, ready: 0, overdue: 0, avg_elapsed_min: 0, oldest_min: 0,
        bumped_today: 0, recalls_today: 0, all_day: [] as { name: string; qty: number }[],
        _elapsedSum: 0, _allDay: new Map<string, number>(),
      });
    }
    for (const r of rows) {
      const bucket = map.get(Number(r.stationId));
      if (!bucket) continue; // an inactive station's lines are ignored on the load view
      const st = String(r.kdsStatus);
      const firedToday = r.firedAt ? bizYmdDash(new Date(r.firedAt)) === today : false;
      if (st === 'served') {
        if (r.servedAt && bizYmdDash(new Date(r.servedAt)) === today) bucket.bumped_today += 1;
      } else {
        bucket.active += 1;
        if (st === 'queued') bucket.queued += 1; else if (st === 'preparing') bucket.preparing += 1; else if (st === 'ready') bucket.ready += 1;
        const fired = r.firedAt ? new Date(r.firedAt).getTime() : now;
        const prep = r.estPrep ?? r.stationPrep ?? 10;
        const elapsed = Math.max(0, Math.floor((now - fired) / 60000));
        bucket._elapsedSum += elapsed;
        bucket.oldest_min = Math.max(bucket.oldest_min, elapsed);
        if (elapsed >= prep) bucket.overdue += 1;
        bucket._allDay.set(r.name, (bucket._allDay.get(r.name) ?? 0) + n(r.qty));
      }
      if (firedToday) bucket.recalls_today += Number(r.recallCount) || 0;
    }
    const stations = [...map.values()].map((b) => {
      b.avg_elapsed_min = b.active ? Math.round(b._elapsedSum / b.active) : 0;
      b.all_day = [...b._allDay.entries()].map(([name, qty]) => ({ name, qty })).sort((a, b2) => b2.qty - a.qty);
      delete b._elapsedSum; delete b._allDay;
      return b;
    });
    return { stations, generated_at: new Date().toISOString() };
  }

  // Course-pacing helper (F8): for orders that fire course-by-course, suggest firing the NEXT held course
  // once the current fired course is plated (nothing still cooking) — so the kitchen paces multi-course
  // tables without the floor watching each ticket. Returns one nudge per order that's ready to advance.
  async pacing(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select({
      orderId: dineInOrders.id, orderNo: dineInOrders.orderNo, tableNo: diningTables.tableNo,
      course: dineInOrderItems.course, kdsStatus: dineInOrderItems.kdsStatus,
    }).from(dineInOrderItems)
      .innerJoin(dineInOrders, eq(dineInOrderItems.orderId, dineInOrders.id))
      .leftJoin(diningTables, eq(dineInOrders.tableId, diningTables.id))
      .where(inArray(dineInOrderItems.kdsStatus, ['new', 'queued', 'preparing', 'ready', 'served']));
    const orders = new Map<number, { orderNo: string; tableNo: string | null; firedMax: number; heldMin: number | null; cooking: boolean }>();
    for (const r of rows) {
      const o = orders.get(Number(r.orderId)) ?? { orderNo: r.orderNo, tableNo: r.tableNo ?? null, firedMax: 0, heldMin: null, cooking: false };
      const course = r.course ?? 1;
      if (r.kdsStatus === 'new') o.heldMin = o.heldMin == null ? course : Math.min(o.heldMin, course);
      else { o.firedMax = Math.max(o.firedMax, course); if (r.kdsStatus === 'queued' || r.kdsStatus === 'preparing') o.cooking = true; }
      orders.set(Number(r.orderId), o);
    }
    const nudges = [...orders.values()]
      // a held course exists beyond what's fired, and the current fired course is fully plated (not cooking)
      .filter((o) => o.heldMin != null && o.heldMin > o.firedMax && o.firedMax > 0 && !o.cooking)
      .map((o) => ({ order_no: o.orderNo, table_label: o.tableNo, next_course: o.heldMin as number, current_course: o.firedMax }));
    return { nudges, generated_at: new Date().toISOString() };
  }

  async listStations(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(kitchenStations).orderBy(asc(kitchenStations.sort));
    return { stations: rows.map((s: any) => ({ id: Number(s.id), code: s.code, name: s.name, sort: s.sort, default_prep_minutes: s.defaultPrepMinutes, active: s.active })) };
  }

  async upsertStation(dto: z.infer<typeof StationBody>, user: JwtUser) {
    const db = this.db;
    const [existing] = await db.select().from(kitchenStations).where(eq(kitchenStations.code, dto.code)).limit(1);
    if (existing) {
      await db.update(kitchenStations).set({ name: dto.name, sort: dto.sort ?? existing.sort, defaultPrepMinutes: dto.default_prep_minutes ?? existing.defaultPrepMinutes }).where(eq(kitchenStations.id, existing.id));
      return { id: Number(existing.id), code: dto.code };
    }
    const [created] = await db.insert(kitchenStations).values({ tenantId: user.tenantId, code: dto.code, name: dto.name, sort: dto.sort ?? 0, defaultPrepMinutes: dto.default_prep_minutes ?? 10 }).returning({ id: kitchenStations.id });
    return { id: Number(created!.id), code: dto.code };
  }
}
