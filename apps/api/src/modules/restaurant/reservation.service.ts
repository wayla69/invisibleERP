import { Inject, Injectable, Optional, NotFoundException, BadRequestException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tableReservations, diningTables, posMembers, buffetPackages } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { MessagingService } from '../messaging/messaging.service';

export interface CreateReservationDto {
  kind?: 'reservation' | 'waitlist';
  table_id?: number;
  reserved_for?: string;        // ISO; required for a reservation, ignored for waitlist
  party_size?: number;
  customer_name?: string;
  customer_phone?: string;
  member_id?: number;
  quoted_wait_min?: number;     // waitlist estimate
  notes?: string;
  // fine-casual: one venue seats buffet and à-la-carte parties — book the mode up front
  service_mode?: 'a_la_carte' | 'buffet';
  buffet_package_id?: number;   // optional pre-picked tier (buffet mode only)
  occasion?: string;            // birthday / anniversary / business — service prep
}
export interface ListReservationsDto { kind?: string; status?: string; from?: string; to?: string }

// Table reservations + walk-in waitlist. Operational scheduling — no GL. The guest is notified
// (LINE/SMS via MessagingService) when their table is ready; seating marks the table occupied.
@Injectable()
export class ReservationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly messaging?: MessagingService, // best-effort "table ready" notice
  ) {}

  async create(dto: CreateReservationDto, user: JwtUser) {
    const db = this.db;
    const kind = dto.kind === 'waitlist' ? 'waitlist' : 'reservation';
    if (kind === 'reservation' && !dto.reserved_for) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'reserved_for is required for a reservation', messageTh: 'ต้องระบุเวลาการจอง' });
    }
    if ((dto.party_size ?? 2) <= 0) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'party_size must be positive', messageTh: 'จำนวนคนต้องมากกว่าศูนย์' });
    // fine-casual service mode: a pre-picked buffet tier only makes sense on a buffet booking, and must
    // be a live tier of this shop (the buffet clock itself still starts at the table, not here).
    const serviceMode = dto.service_mode === 'buffet' ? 'buffet' : 'a_la_carte';
    if (dto.buffet_package_id != null && serviceMode !== 'buffet') {
      throw new BadRequestException({ code: 'BAD_PACKAGE', message: 'buffet_package_id requires service_mode=buffet', messageTh: 'เลือกแพ็กเกจบุฟเฟ่ต์ได้เฉพาะการจองแบบบุฟเฟ่ต์' });
    }
    if (dto.buffet_package_id != null) {
      const [pkg] = await db.select().from(buffetPackages).where(and(eq(buffetPackages.id, dto.buffet_package_id), eq(buffetPackages.tenantId, user.tenantId as number), eq(buffetPackages.active, true))).limit(1);
      if (!pkg) throw new BadRequestException({ code: 'BAD_PACKAGE', message: 'Buffet package not found or inactive', messageTh: 'ไม่พบแพ็กเกจบุฟเฟ่ต์ หรือแพ็กเกจปิดใช้งานแล้ว' });
    }
    const [row] = await db.insert(tableReservations).values({
      tenantId: user.tenantId!, kind, tableId: dto.table_id ?? null,
      reservedFor: kind === 'reservation' ? new Date(dto.reserved_for!) : null,
      partySize: dto.party_size ?? 2, customerName: dto.customer_name ?? null, customerPhone: dto.customer_phone ?? null,
      memberId: dto.member_id ?? null, status: kind === 'waitlist' ? 'waiting' : 'booked',
      quotedWaitMin: dto.quoted_wait_min ?? null, notes: dto.notes ?? null, createdBy: user.username,
      serviceMode, buffetPackageId: dto.buffet_package_id ?? null, occasion: dto.occasion ?? null,
    }).returning();
    // pre-assigning a table holds it as 'reserved' (only from available — never steal an occupied table).
    if (dto.table_id) await db.update(diningTables).set({ status: 'reserved', updatedAt: new Date() }).where(and(eq(diningTables.id, dto.table_id), eq(diningTables.status, 'available')));
    return this.shape(row);
  }

  async list(dto: ListReservationsDto, user: JwtUser) {
    const db = this.db;
    const conds = [eq(tableReservations.tenantId, user.tenantId as number)];
    if (dto.kind) conds.push(eq(tableReservations.kind, dto.kind));
    if (dto.status) conds.push(eq(tableReservations.status, dto.status as typeof tableReservations.$inferSelect.status));
    if (dto.from) conds.push(gte(tableReservations.reservedFor, new Date(dto.from)));
    if (dto.to) conds.push(lte(tableReservations.reservedFor, new Date(dto.to)));
    const rows = await db.select().from(tableReservations).where(and(...conds))
      .orderBy(desc(tableReservations.createdAt)).limit(500);
    // resolve pre-picked buffet tier names in one query for the list view
    const pkgIds = [...new Set(rows.map((r: any) => r.buffetPackageId).filter(Boolean))] as number[];
    const pkgs = pkgIds.length ? await db.select({ id: buffetPackages.id, name: buffetPackages.name }).from(buffetPackages).where(inArray(buffetPackages.id, pkgIds)) : [];
    const pkgName = new Map(pkgs.map((p: any) => [Number(p.id), p.name]));
    const out = rows.map((r: any) => ({ ...this.shape(r), buffet_package_name: r.buffetPackageId ? pkgName.get(Number(r.buffetPackageId)) ?? null : null }));
    const active = out.filter((r: any) => ['booked', 'waiting', 'ready'].includes(r.status));
    return {
      reservations: out, count: out.length,
      waiting: out.filter((r: any) => r.status === 'waiting').length,
      booked: out.filter((r: any) => r.status === 'booked').length,
      covers_pending: active.reduce((a: number, r: any) => a + (r.party_size ?? 0), 0),
      // fine-casual: the floor plans buffet and à-la-carte covers separately (station prep vs kitchen load)
      covers_buffet: active.filter((r: any) => r.service_mode === 'buffet').reduce((a: number, r: any) => a + (r.party_size ?? 0), 0),
      covers_a_la_carte: active.filter((r: any) => r.service_mode !== 'buffet').reduce((a: number, r: any) => a + (r.party_size ?? 0), 0),
    };
  }

  // Notify the guest their table is ready (waitlist) or confirm a booking is up next → status 'ready'.
  async notifyReady(id: number, user: JwtUser) {
    const db = this.db;
    const row = await this.load(id, user);
    if (['seated', 'cancelled', 'no_show'].includes(String(row.status))) {
      throw new BadRequestException({ code: 'BAD_STATUS', message: `Cannot notify a ${row.status} entry`, messageTh: 'สถานะนี้แจ้งเตือนไม่ได้' });
    }
    let delivered: any = null;
    if (this.messaging) {
      const body = `🍽️ โต๊ะของคุณ${row.customerName ? ' คุณ' + row.customerName : ''} (${row.partySize} ท่าน) พร้อมแล้ว เชิญที่ร้านได้เลยค่ะ/ครับ`;
      const channel = await this.preferredChannel(row);
      try { delivered = await this.messaging.send({ member_id: row.memberId ?? undefined, to: row.customerPhone ?? undefined, channel, body, campaign: 'reservation_ready' }, user); } catch { /* notice is best-effort */ }
    }
    await db.update(tableReservations).set({ status: 'ready', notifiedAt: new Date(), updatedAt: new Date() }).where(eq(tableReservations.id, id));
    return { id, status: 'ready', notified: delivered?.status ?? 'skipped', channel: delivered?.channel ?? null };
  }

  // Seat the party → status 'seated'; the assigned table (if any) becomes occupied.
  async seat(id: number, user: JwtUser) {
    const db = this.db;
    const row = await this.load(id, user);
    if (['seated', 'cancelled', 'no_show'].includes(String(row.status))) {
      throw new BadRequestException({ code: 'BAD_STATUS', message: `Already ${row.status}`, messageTh: 'รายการนี้ปิดแล้ว' });
    }
    await db.update(tableReservations).set({ status: 'seated', seatedAt: new Date(), updatedAt: new Date() }).where(eq(tableReservations.id, id));
    if (row.tableId) await db.update(diningTables).set({ status: 'occupied', updatedAt: new Date() }).where(and(eq(diningTables.id, row.tableId), inArray(diningTables.status, ['available', 'reserved'] as NonNullable<typeof diningTables.$inferSelect.status>[])));
    return { id, status: 'seated', table_id: row.tableId ?? null };
  }

  async cancel(id: number, user: JwtUser) { return this.close(id, user, 'cancelled'); }
  async noShow(id: number, user: JwtUser) { return this.close(id, user, 'no_show'); }

  private async close(id: number, user: JwtUser, status: 'cancelled' | 'no_show') {
    const db = this.db;
    const row = await this.load(id, user);
    if (['seated', 'cancelled', 'no_show'].includes(String(row.status))) {
      throw new BadRequestException({ code: 'BAD_STATUS', message: `Already ${row.status}`, messageTh: 'รายการนี้ปิดแล้ว' });
    }
    await db.update(tableReservations).set({ status, updatedAt: new Date() }).where(eq(tableReservations.id, id));
    // release a table we were holding (only if still 'reserved' for this booking — never free an occupied table).
    if (row.tableId) await db.update(diningTables).set({ status: 'available', updatedAt: new Date() }).where(and(eq(diningTables.id, row.tableId), eq(diningTables.status, 'reserved')));
    return { id, status };
  }

  private async load(id: number, user: JwtUser) {
    const db = this.db;
    const [row] = await db.select().from(tableReservations).where(and(eq(tableReservations.id, id), eq(tableReservations.tenantId, user.tenantId as number))).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Reservation not found', messageTh: 'ไม่พบรายการจอง' });
    return row;
  }

  // Prefer LINE when the linked member has a LINE identity, else SMS to the phone.
  private async preferredChannel(row: any): Promise<'line' | 'sms'> {
    if (row.memberId) {
      const db = this.db;
      const [m] = await db.select({ line: posMembers.lineUserId }).from(posMembers).where(eq(posMembers.id, row.memberId)).limit(1);
      if (m?.line) return 'line';
    }
    return 'sms';
  }

  private shape(r: any) {
    return {
      id: Number(r.id), kind: r.kind, table_id: r.tableId ? Number(r.tableId) : null,
      reserved_for: r.reservedFor, party_size: r.partySize, customer_name: r.customerName,
      customer_phone: r.customerPhone, member_id: r.memberId ? Number(r.memberId) : null,
      status: r.status, quoted_wait_min: r.quotedWaitMin, notes: r.notes,
      service_mode: r.serviceMode ?? 'a_la_carte', buffet_package_id: r.buffetPackageId ? Number(r.buffetPackageId) : null,
      occasion: r.occasion ?? null,
      notified_at: r.notifiedAt, seated_at: r.seatedAt, created_at: r.createdAt,
    };
  }
}
