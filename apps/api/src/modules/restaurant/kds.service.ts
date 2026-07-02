import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, asc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { dineInOrderItems, kitchenStations, dineInOrders, diningTables } from '../../database/schema';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import type { StationBody } from './dto';
import type { z } from 'zod';

@Injectable()
export class KdsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // active kitchen items grouped by station, oldest-fired first (cook next), excl served/voided
  async feed(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select({
      itemId: dineInOrderItems.id, name: dineInOrderItems.name, qty: dineInOrderItems.qty,
      modifiers: dineInOrderItems.modifiers, notes: dineInOrderItems.notes, kdsStatus: dineInOrderItems.kdsStatus,
      firedAt: dineInOrderItems.firedAt, estPrep: dineInOrderItems.estPrepMinutes,
      isBuffet: dineInOrderItems.isBuffet, createdBy: dineInOrderItems.createdBy, course: dineInOrderItems.course,
      stationId: kitchenStations.id, stationCode: kitchenStations.code, stationName: kitchenStations.name, stationSort: kitchenStations.sort, stationPrep: kitchenStations.defaultPrepMinutes,
      orderNo: dineInOrders.orderNo, tableNo: diningTables.tableNo,
    }).from(dineInOrderItems)
      .innerJoin(kitchenStations, eq(dineInOrderItems.stationId, kitchenStations.id))
      .innerJoin(dineInOrders, eq(dineInOrderItems.orderId, dineInOrders.id))
      .leftJoin(diningTables, eq(dineInOrders.tableId, diningTables.id))
      .where(inArray(dineInOrderItems.kdsStatus, ['queued', 'preparing', 'ready'] as any))
      .orderBy(asc(kitchenStations.sort), asc(dineInOrderItems.course), asc(dineInOrderItems.firedAt));

    const now = Date.now();
    const stations = new Map<number, any>();
    for (const r of rows) {
      const sid = Number(r.stationId);
      if (!stations.has(sid)) stations.set(sid, { station_id: sid, station_code: r.stationCode, station_name: r.stationName, items: [] });
      const fired = r.firedAt ? new Date(r.firedAt).getTime() : now;
      const prep = r.estPrep ?? r.stationPrep ?? 10;
      const elapsedMin = Math.floor((now - fired) / 60000);
      stations.get(sid).items.push({
        item_id: Number(r.itemId), order_no: r.orderNo, table_label: r.tableNo ?? null, name: r.name, qty: n(r.qty),
        modifiers: r.modifiers ?? [], notes: r.notes, kds_status: r.kdsStatus, fired_at: r.firedAt,
        is_buffet: r.isBuffet, from_diner: r.createdBy === 'diner:qr', course: r.course ?? 1,
        elapsed_min: elapsedMin, prep_min: prep, remaining_min: Math.max(0, prep - elapsedMin),
      });
    }
    return { stations: [...stations.values()], generated_at: new Date().toISOString() };
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
