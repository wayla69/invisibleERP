import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, sql, desc, lt } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { recoveryCases, posMembers } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

const RESPONSE_SLA_HOURS = 24; // detractor must be contacted within 24h (LYL-20 default)

// V2 (docs/29) — service-recovery worklist (control LYL-20). A detractor is not "handled" until a named
// person contacted the member and resolved the case with a note; overdue cases are surfaced, never dropped.
@Injectable()
export class RecoveryService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  // Open a case for a detractor response — idempotent per (source, source_ref) via the unique index.
  // Called from NpsService.submit's best-effort detractor block (no user context — tenant from the row).
  async openForDetractor(tenantId: number | null, memberId: number, sourceRef: string, score: number, comment: string | null) {
    const db = this.db;
    const rows = await db.insert(recoveryCases).values({
      tenantId, memberId, source: 'nps', sourceRef, score, comment,
      responseDueAt: new Date(Date.now() + RESPONSE_SLA_HOURS * 3600_000),
    }).onConflictDoNothing().returning({ id: recoveryCases.id });
    return rows.length ? { id: Number(rows[0]!.id), opened: true } : { opened: false };
  }

  async list(user: JwtUser, status?: string) {
    const db = this.db;
    const tenantId = this.tid(user);
    const conds = [eq(recoveryCases.tenantId, tenantId)];
    if (status) conds.push(eq(recoveryCases.status, status));
    const rows = await db.select({
      c: recoveryCases, memberCode: posMembers.memberCode, memberName: posMembers.name,
    }).from(recoveryCases).leftJoin(posMembers, eq(recoveryCases.memberId, posMembers.id))
      .where(and(...conds)).orderBy(desc(recoveryCases.id)).limit(200);
    const now = Date.now();
    return {
      cases: rows.map((r: any) => shape(r.c, r.memberCode, r.memberName, now)),
      open: rows.filter((r: any) => r.c.status === 'Open').length,
      overdue: rows.filter((r: any) => r.c.status === 'Open' && r.c.responseDueAt && new Date(r.c.responseDueAt).getTime() < now).length,
    };
  }

  // Actor-stamped transitions. Contact: Open → Contacted; Resolve: Open/Contacted → Resolved (note required).
  async contact(user: JwtUser, id: number) {
    const db = this.db;
    const tenantId = this.tid(user);
    const rows = await db.update(recoveryCases)
      .set({ status: 'Contacted', contactedAt: new Date(), contactedBy: user.username })
      .where(and(eq(recoveryCases.id, id), eq(recoveryCases.tenantId, tenantId), eq(recoveryCases.status, 'Open')))
      .returning();
    if (!rows.length) {
      const [c] = await db.select().from(recoveryCases).where(and(eq(recoveryCases.id, id), eq(recoveryCases.tenantId, tenantId))).limit(1);
      if (!c) throw new NotFoundException({ code: 'CASE_NOT_FOUND', message: 'Recovery case not found', messageTh: 'ไม่พบเคส' });
      throw new ConflictException({ code: 'CASE_NOT_OPEN', message: `Case is ${c.status}, not Open`, messageTh: 'เคสไม่อยู่ในสถานะรอติดต่อ' });
    }
    return shape(rows[0]!, null, null, Date.now());
  }

  async resolve(user: JwtUser, id: number, note: string) {
    if (!note?.trim()) throw new BadRequestException({ code: 'NOTE_REQUIRED', message: 'resolution note required', messageTh: 'ต้องระบุบันทึกการแก้ไข' });
    const db = this.db;
    const tenantId = this.tid(user);
    const rows = await db.update(recoveryCases)
      .set({ status: 'Resolved', resolvedAt: new Date(), resolvedBy: user.username, resolutionNote: note.trim().slice(0, 500) })
      .where(and(eq(recoveryCases.id, id), eq(recoveryCases.tenantId, tenantId), sql`${recoveryCases.status} IN ('Open','Contacted')`))
      .returning();
    if (!rows.length) {
      const [c] = await db.select().from(recoveryCases).where(and(eq(recoveryCases.id, id), eq(recoveryCases.tenantId, tenantId))).limit(1);
      if (!c) throw new NotFoundException({ code: 'CASE_NOT_FOUND', message: 'Recovery case not found', messageTh: 'ไม่พบเคส' });
      throw new ConflictException({ code: 'CASE_ALREADY_RESOLVED', message: 'Case already resolved', messageTh: 'เคสนี้ปิดแล้ว' });
    }
    return shape(rows[0]!, null, null, Date.now());
  }

  // Aggregates for the NPS summary + member 360.
  async overdueCount(tenantId: number): Promise<{ open: number; overdue: number }> {
    const db = this.db;
    const [o] = await db.select({ c: sql<number>`count(*)` }).from(recoveryCases)
      .where(and(eq(recoveryCases.tenantId, tenantId), eq(recoveryCases.status, 'Open')));
    const [d] = await db.select({ c: sql<number>`count(*)` }).from(recoveryCases)
      .where(and(eq(recoveryCases.tenantId, tenantId), eq(recoveryCases.status, 'Open'), lt(recoveryCases.responseDueAt, new Date())));
    return { open: Number(o?.c ?? 0), overdue: Number(d?.c ?? 0) };
  }

  async openCaseForMember(tenantId: number, memberId: number) {
    const db = this.db;
    const [c] = await db.select().from(recoveryCases)
      .where(and(eq(recoveryCases.tenantId, tenantId), eq(recoveryCases.memberId, memberId), sql`${recoveryCases.status} IN ('Open','Contacted')`))
      .orderBy(desc(recoveryCases.id)).limit(1);
    return c ? shape(c, null, null, Date.now()) : null;
  }
}

function shape(c: any, memberCode: string | null, memberName: string | null, nowMs: number) {
  return {
    id: Number(c.id), member_id: Number(c.memberId), member_code: memberCode, member_name: memberName,
    source: c.source, source_ref: c.sourceRef, score: c.score != null ? Number(c.score) : null, comment: c.comment ?? null,
    status: c.status, response_due_at: c.responseDueAt,
    overdue: c.status === 'Open' && c.responseDueAt != null && new Date(c.responseDueAt).getTime() < nowMs,
    contacted_at: c.contactedAt, contacted_by: c.contactedBy, resolved_at: c.resolvedAt, resolved_by: c.resolvedBy,
    resolution_note: c.resolutionNote ?? null, assignee: c.assignee ?? null, created_at: c.createdAt,
  };
}
