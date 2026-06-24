import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { eq, and, asc, desc, inArray, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { diningTables, floorZones, tableSessions, dineInOrders } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { mintTableToken } from './qr-token.util';
import type { CreateTableDto, UpdateTableDto, ZoneDto, ZoneUpdateDto } from './dto';

const LIVE_SESSION = ['open', 'bill_requested', 'paying'];

@Injectable()
export class TableService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  // ── zones / rooms (floor-plan groupings; a VIP room is just a zone with an accent colour) ──
  async listZones(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(floorZones).where(eq(floorZones.active, true)).orderBy(asc(floorZones.sortOrder));
    return { zones: rows.map(shapeZone) };
  }
  async createZone(dto: ZoneDto, user: JwtUser) {
    const db = this.db as any;
    const [z] = await db.insert(floorZones).values({
      tenantId: user.tenantId, name: dto.name, sortOrder: dto.sort_order ?? 0,
      posX: String(dto.pos_x ?? 16), posY: String(dto.pos_y ?? 16),
      width: String(dto.width ?? 320), height: String(dto.height ?? 200), color: dto.color ?? null,
    }).returning();
    return shapeZone(z);
  }
  async updateZone(id: number, dto: ZoneUpdateDto, _user: JwtUser) {
    const db = this.db as any;
    const set: any = {};
    if (dto.name != null) set.name = dto.name;
    if (dto.sort_order != null) set.sortOrder = dto.sort_order;
    if (dto.pos_x != null) set.posX = String(dto.pos_x);
    if (dto.pos_y != null) set.posY = String(dto.pos_y);
    if (dto.width != null) set.width = String(dto.width);
    if (dto.height != null) set.height = String(dto.height);
    if (dto.color !== undefined) set.color = dto.color ?? null;
    const [z] = await db.update(floorZones).set(set).where(eq(floorZones.id, id)).returning();
    if (!z) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Zone not found', messageTh: 'ไม่พบโซน' });
    return shapeZone(z);
  }
  // Soft-delete a zone (active=false). Its tables stay on the plan but become un-grouped (zone_id=null).
  async deleteZone(id: number, _user: JwtUser) {
    const db = this.db as any;
    const [z] = await db.select().from(floorZones).where(eq(floorZones.id, id)).limit(1);
    if (!z || !z.active) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Zone not found', messageTh: 'ไม่พบโซน' });
    await db.update(diningTables).set({ zoneId: null, updatedAt: new Date() }).where(eq(diningTables.zoneId, id));
    await db.update(floorZones).set({ active: false }).where(eq(floorZones.id, id));
    return { id, deleted: true, name: z.name };
  }

  // ── tables ──
  async listTables(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(diningTables).where(eq(diningTables.active, true)).orderBy(asc(diningTables.tableNo));
    return { tables: rows.map(shapeTable) };
  }

  async createTable(dto: CreateTableDto, user: JwtUser) {
    const db = this.db as any;
    const qrToken = 'rt_' + randomBytes(18).toString('base64url');
    const [t] = await db.insert(diningTables).values({
      tenantId: user.tenantId, zoneId: dto.zone_id ?? null, tableNo: dto.table_no, seats: dto.seats ?? 4,
      shape: dto.shape ?? 'rect', posX: String(dto.pos_x ?? 0), posY: String(dto.pos_y ?? 0),
      width: String(dto.width ?? 80), height: String(dto.height ?? 80), status: 'available', qrToken,
    }).returning();
    return shapeTable(t);
  }

  // Every update bumps `rev`. When the caller passes the `rev` it last saw (optimistic concurrency),
  // the write is gated on it: a stale `rev` (someone else edited the table meanwhile) → 409 STALE_WRITE.
  // Omitting `rev` keeps the legacy last-write-wins behaviour (e.g. an undo that must always apply).
  async updateTable(id: number, dto: UpdateTableDto, _user: JwtUser) {
    const db = this.db as any;
    const set: any = { updatedAt: new Date(), rev: sql`${diningTables.rev} + 1` };
    if (dto.table_no != null) set.tableNo = dto.table_no;
    if (dto.zone_id !== undefined) set.zoneId = dto.zone_id;   // explicit null un-assigns the table from its zone
    if (dto.seats != null) set.seats = dto.seats;
    if (dto.shape != null) set.shape = dto.shape;
    if (dto.rotation != null) set.rotation = dto.rotation;
    if (dto.pos_x != null) set.posX = String(dto.pos_x);
    if (dto.pos_y != null) set.posY = String(dto.pos_y);
    if (dto.width != null) set.width = String(dto.width);
    if (dto.height != null) set.height = String(dto.height);
    const whereClause = dto.rev != null ? and(eq(diningTables.id, id), eq(diningTables.rev, dto.rev)) : eq(diningTables.id, id);
    const [t] = await db.update(diningTables).set(set).where(whereClause).returning();
    if (!t) {
      if (dto.rev != null) {
        const [exists] = await db.select().from(diningTables).where(eq(diningTables.id, id)).limit(1);
        if (exists) throw new ConflictException({ code: 'STALE_WRITE', message: 'Table changed since it was loaded', messageTh: 'ผังถูกแก้ไขโดยผู้อื่น กรุณารีเฟรช' });
      }
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Table not found', messageTh: 'ไม่พบโต๊ะ' });
    }
    return shapeTable(t);
  }

  // Soft-delete a table (active=false) — preserves history + FKs (orders/sessions keep referencing it).
  // A table with a live session cannot be removed; clear/checkout the table first.
  async deleteTable(id: number, _user: JwtUser) {
    const db = this.db as any;
    const [t] = await db.select().from(diningTables).where(eq(diningTables.id, id)).limit(1);
    if (!t || !t.active) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Table not found', messageTh: 'ไม่พบโต๊ะ' });
    const [live] = await db.select().from(tableSessions).where(and(eq(tableSessions.tableId, id), inArray(tableSessions.status, LIVE_SESSION as any))).limit(1);
    if (live) throw new BadRequestException({ code: 'TABLE_BUSY', message: 'Table has a live session — clear it first', messageTh: 'โต๊ะมีลูกค้าอยู่ — เคลียร์โต๊ะก่อนจึงจะลบได้' });
    await db.update(diningTables).set({ active: false, updatedAt: new Date() }).where(eq(diningTables.id, id));
    return { id, deleted: true, table_no: t.tableNo };
  }

  async setStatus(id: number, status: string, _user: JwtUser) {
    const db = this.db as any;
    const [t] = await db.select().from(diningTables).where(eq(diningTables.id, id)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Table not found', messageTh: 'ไม่พบโต๊ะ' });
    if (status === 'out_of_service') {
      const [live] = await db.select().from(tableSessions).where(and(eq(tableSessions.tableId, id), inArray(tableSessions.status, LIVE_SESSION as any))).limit(1);
      if (live) throw new BadRequestException({ code: 'TABLE_BUSY', message: 'Table has a live session', messageTh: 'โต๊ะมีลูกค้าอยู่' });
    }
    await db.update(diningTables).set({ status, updatedAt: new Date() }).where(eq(diningTables.id, id));
    return { id, status };
  }

  // open a table → mint a session + diner token (also used when a diner self-opens via QR)
  async openTable(tableId: number, partySize: number | undefined, openedBy: string, user: JwtUser | null) {
    const db = this.db as any;
    const [t] = await db.select().from(diningTables).where(eq(diningTables.id, tableId)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Table not found', messageTh: 'ไม่พบโต๊ะ' });
    // reuse an existing live session if present (idempotent for diner re-scan)
    const [live] = await db.select().from(tableSessions).where(and(eq(tableSessions.tableId, tableId), inArray(tableSessions.status, LIVE_SESSION as any))).limit(1);
    if (live) return { session_id: Number(live.id), session_no: live.sessionNo, public_token: live.publicToken, table_no: t.tableNo, reused: true };
    const sessionNo = await this.docNo.nextDaily('TS');
    const tenantId = Number(t.tenantId);
    const [s] = await db.insert(tableSessions).values({ tenantId, tableId, sessionNo, publicToken: 'pending', status: 'open', partySize: partySize ?? null, openedBy }).returning({ id: tableSessions.id });
    const publicToken = mintTableToken({ tenantId, tableId, sessionId: Number(s.id) });
    await db.update(tableSessions).set({ publicToken }).where(eq(tableSessions.id, s.id));
    await db.update(diningTables).set({ status: 'occupied', updatedAt: new Date() }).where(and(eq(diningTables.id, tableId), inArray(diningTables.status, ['available', 'reserved'] as any)));
    return { session_id: Number(s.id), session_no: sessionNo, public_token: publicToken, table_no: t.tableNo, qr_token: t.qrToken, reused: false };
  }

  // Move a live tab to another (free) table: reassign the session + its open orders, then update both
  // tables' status. Moving onto an occupied table is a merge (separate flow) and is rejected here.
  async moveSession(fromTableId: number, toTableId: number, _user: JwtUser) {
    const db = this.db as any;
    if (fromTableId === toTableId) throw new BadRequestException({ code: 'SAME_TABLE', message: 'Source and target are the same table', messageTh: 'โต๊ะต้นทางและปลายทางเป็นโต๊ะเดียวกัน' });
    const [from] = await db.select().from(diningTables).where(eq(diningTables.id, fromTableId)).limit(1);
    if (!from) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Source table not found', messageTh: 'ไม่พบโต๊ะต้นทาง' });
    const [to] = await db.select().from(diningTables).where(eq(diningTables.id, toTableId)).limit(1);
    if (!to || !to.active) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Target table not found', messageTh: 'ไม่พบโต๊ะปลายทาง' });
    const [sess] = await db.select().from(tableSessions).where(and(eq(tableSessions.tableId, fromTableId), inArray(tableSessions.status, LIVE_SESSION as any))).limit(1);
    if (!sess) throw new BadRequestException({ code: 'NO_SESSION', message: 'No live session on the source table', messageTh: 'โต๊ะต้นทางไม่มีลูกค้า' });
    // target must be free — moving onto a table that already has a live session would be a merge
    const [busy] = await db.select().from(tableSessions).where(and(eq(tableSessions.tableId, toTableId), inArray(tableSessions.status, LIVE_SESSION as any))).limit(1);
    if (busy) throw new BadRequestException({ code: 'TABLE_BUSY', message: 'Target table is occupied (use merge instead)', messageTh: 'โต๊ะปลายทางมีลูกค้าอยู่ (ใช้การรวมโต๊ะ)' });
    const now = new Date();
    await db.update(tableSessions).set({ tableId: toTableId }).where(eq(tableSessions.id, sess.id));
    await db.update(dineInOrders).set({ tableId: toTableId }).where(and(eq(dineInOrders.sessionId, Number(sess.id)), ne(dineInOrders.status, 'closed'), ne(dineInOrders.status, 'cancelled')));
    await db.update(diningTables).set({ status: 'occupied', updatedAt: now }).where(eq(diningTables.id, toTableId));
    await db.update(diningTables).set({ status: 'available', updatedAt: now }).where(eq(diningTables.id, fromTableId));
    return { from_table_no: from.tableNo, to_table_no: to.tableNo, session_no: sess.sessionNo };
  }

  // Printable diner QR for a table — encodes the STABLE landing URL (…/qr/start/:qrToken). Scanning it
  // opens/joins the table session and drops the guest on the order page. `base` = the web origin
  // (passed by the admin UI as window.location.origin), else WEB_PUBLIC_URL, else a relative path.
  async qrSticker(tableId: number, base: unknown, _user: JwtUser) {
    const db = this.db as any;
    const [t] = await db.select().from(diningTables).where(eq(diningTables.id, tableId)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Table not found', messageTh: 'ไม่พบโต๊ะ' });
    if (!t.qrToken) throw new BadRequestException({ code: 'NO_QR', message: 'Table has no QR token', messageTh: 'โต๊ะนี้ยังไม่มี QR' });
    // `base` is an uncontrolled query param (could be tampered to an array) — accept a string only.
    const baseStr = typeof base === 'string' ? base : '';
    // strip trailing slashes without a regex (avoid polynomial backtracking on uncontrolled input)
    const trimSlash = (s: string) => { let e = s.length; while (e > 0 && s.charCodeAt(e - 1) === 47) e--; return s.slice(0, e); };
    const origin = baseStr && /^https?:\/\//.test(baseStr) ? trimSlash(baseStr) : trimSlash(process.env.WEB_PUBLIC_URL || '');
    const path = `/qr/start/${t.qrToken}`;
    const url = origin ? `${origin}${path}` : path;
    const qrImage = await QRCode.toDataURL(url, { margin: 1, width: 320 });
    return { table_no: t.tableNo, qr_token: t.qrToken, url, qr_image: qrImage };
  }

  // staff status board: table + live session + its open order summary
  async statusBoard(_user: JwtUser) {
    const db = this.db as any;
    const tables = await db.select().from(diningTables).where(eq(diningTables.active, true)).orderBy(asc(diningTables.tableNo));
    const now = Date.now();
    const out = [];
    for (const t of tables) {
      const [sess] = await db.select().from(tableSessions).where(and(eq(tableSessions.tableId, Number(t.id)), inArray(tableSessions.status, LIVE_SESSION as any))).orderBy(desc(tableSessions.id)).limit(1);
      let order = null;
      if (sess) {
        const [o] = await db.select().from(dineInOrders).where(and(eq(dineInOrders.sessionId, Number(sess.id)), ne(dineInOrders.status, 'cancelled'))).orderBy(desc(dineInOrders.id)).limit(1);
        if (o) order = { order_no: o.orderNo, status: o.status, total: n(o.total), waited_min: o.firedAt ? Math.floor((now - new Date(o.firedAt).getTime()) / 60000) : 0 };
      }
      out.push({
        ...shapeTable(t),
        session: sess ? { session_no: sess.sessionNo, party_size: sess.partySize, opened_at: sess.openedAt, elapsed_min: sess.openedAt ? Math.floor((now - new Date(sess.openedAt).getTime()) / 60000) : 0 } : null,
        order,
      });
    }
    return { tables: out, generated_at: new Date().toISOString() };
  }
}

function shapeTable(t: any) {
  return {
    id: Number(t.id), table_no: t.tableNo, zone_id: t.zoneId, seats: t.seats, shape: t.shape, status: t.status,
    pos_x: n(t.posX), pos_y: n(t.posY), width: n(t.width), height: n(t.height), rotation: t.rotation, rev: t.rev, qr_token: t.qrToken,
  };
}

function shapeZone(z: any) {
  return {
    id: Number(z.id), name: z.name, sort_order: z.sortOrder, color: z.color ?? null,
    pos_x: n(z.posX), pos_y: n(z.posY), width: n(z.width), height: n(z.height),
  };
}
