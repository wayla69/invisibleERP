import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, gte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { serviceRequests, diningTables, tableSessions } from '../../database/schema';
import { RealtimeService } from '../pos/scale/realtime.service';
import type { JwtUser } from '../../common/decorators';

const TYPES = ['waiter', 'water', 'cutlery', 'bill', 'custom'] as const;
export type ServiceRequestType = (typeof TYPES)[number];
const OPEN: string[] = ['open', 'ack'];

// Diner "call staff" / service requests (F1) — a bounded service: the diner raises a request from the QR
// page (public, via QrService); the floor board lists + acknowledges + clears them. Realtime-pushed so a
// request pops on the staff board without waiting for its poll. Assumes it runs inside the tenant tx (RLS).
@Injectable()
export class ServiceRequestService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  // diner-raised (public): resolve session/table from the verified token claim in QrService, then insert.
  async create(claim: { tenantId: number; tableId: number; sessionId: number }, type: string, note: string | undefined) {
    if (!TYPES.includes(type as ServiceRequestType)) throw new BadRequestException({ code: 'BAD_REQUEST_TYPE', message: 'Unknown request type', messageTh: 'ประเภทคำขอไม่ถูกต้อง' });
    const db = this.db;
    // coalesce: an identical still-open request on the same table isn't duplicated (double-tap safe)
    const [dup] = await db.select({ id: serviceRequests.id }).from(serviceRequests)
      .where(and(eq(serviceRequests.tableId, claim.tableId), eq(serviceRequests.type, type), inArray(serviceRequests.status, OPEN))).limit(1);
    if (dup) return { id: Number(dup.id), type, status: 'open', deduped: true };
    const [row] = await db.insert(serviceRequests).values({
      tenantId: claim.tenantId, sessionId: claim.sessionId, tableId: claim.tableId,
      type, note: note ?? null, status: 'open', createdBy: 'diner:qr',
    }).returning({ id: serviceRequests.id });
    const [tbl] = await db.select({ tableNo: diningTables.tableNo }).from(diningTables).where(eq(diningTables.id, claim.tableId)).limit(1);
    this.realtime?.publish({ type: 'service_request', tenant_id: claim.tenantId, request_id: Number(row!.id), table_id: claim.tableId, table_no: tbl?.tableNo ?? null, request_type: type, status: 'open', at: new Date().toISOString() });
    return { id: Number(row!.id), type, status: 'open', table_no: tbl?.tableNo ?? null };
  }

  // staff floor board: open + recently-cleared requests (last 2h), newest first, with the table label.
  async list(_user: JwtUser) {
    const db = this.db;
    const since = new Date(Date.now() - 2 * 3600 * 1000);
    const rows = await db.select({
      id: serviceRequests.id, type: serviceRequests.type, note: serviceRequests.note, status: serviceRequests.status,
      tableId: serviceRequests.tableId, tableNo: diningTables.tableNo, createdAt: serviceRequests.createdAt,
      ackedBy: serviceRequests.ackedBy, ackedAt: serviceRequests.ackedAt,
    }).from(serviceRequests)
      .leftJoin(diningTables, eq(serviceRequests.tableId, diningTables.id))
      .where(gte(serviceRequests.createdAt, since))
      .orderBy(desc(serviceRequests.createdAt));
    const now = Date.now();
    const items = rows.map((r: any) => ({
      id: Number(r.id), type: r.type, note: r.note, status: r.status,
      table_id: r.tableId != null ? Number(r.tableId) : null, table_no: r.tableNo ?? null,
      created_at: r.createdAt, acked_by: r.ackedBy ?? null,
      waiting_min: r.createdAt ? Math.floor((now - new Date(r.createdAt).getTime()) / 60000) : 0,
    }));
    return { requests: items, open_count: items.filter((i) => i.status !== 'done').length, generated_at: new Date().toISOString() };
  }

  async ack(id: number, user: JwtUser) { return this.transition(id, 'ack', user); }
  async done(id: number, user: JwtUser) { return this.transition(id, 'done', user); }

  private async transition(id: number, to: 'ack' | 'done', user: JwtUser) {
    const db = this.db;
    const [row] = await db.select().from(serviceRequests).where(eq(serviceRequests.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Request not found', messageTh: 'ไม่พบคำขอ' });
    const now = new Date();
    const set: Record<string, unknown> = { status: to };
    if (to === 'ack') { set.ackedBy = user.username; set.ackedAt = now; } else set.doneAt = now;
    await db.update(serviceRequests).set(set).where(eq(serviceRequests.id, id));
    this.realtime?.publish({ type: 'service_request', tenant_id: user.tenantId ?? null, request_id: id, table_id: Number(row.tableId), request_type: row.type, status: to, at: now.toISOString() });
    return { id, status: to };
  }
}
