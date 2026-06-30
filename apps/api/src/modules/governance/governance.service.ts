import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { ethicsAcknowledgements, whistleblowerCases } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

const STATUSES = ['received', 'investigating', 'resolved', 'dismissed'] as const;

// Entity-level governance evidence capture (ELC-01 ethics-acknowledgement register, ELC-04 whistleblower
// case log). Tenant-scoped by RLS; the policy + governance bodies remain an org/PMO process.
@Injectable()
export class GovernanceService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ELC-01 — record a staff member's acknowledgement of a code-of-conduct version (idempotent per version).
  async acknowledgeEthics(user: JwtUser, policyVersion: string) {
    const db = this.db as any;
    await db.insert(ethicsAcknowledgements).values({
      tenantId: user.tenantId ?? null, username: user.username, policyVersion,
    }).onConflictDoNothing({ target: [ethicsAcknowledgements.tenantId, ethicsAcknowledgements.username, ethicsAcknowledgements.policyVersion] });
    const [row] = await db.select().from(ethicsAcknowledgements)
      .where(and(eq(ethicsAcknowledgements.username, user.username), eq(ethicsAcknowledgements.policyVersion, policyVersion)))
      .orderBy(desc(ethicsAcknowledgements.acknowledgedAt)).limit(1);
    return { username: user.username, policy_version: policyVersion, acknowledged_at: row?.acknowledgedAt ?? null };
  }

  // ELC-01 — the register (admin/compliance): who acknowledged which version, when. Tenant-scoped by RLS.
  async ethicsRegister(policyVersion?: string) {
    const db = this.db as any;
    const rows = await db.select().from(ethicsAcknowledgements)
      .where(policyVersion ? eq(ethicsAcknowledgements.policyVersion, policyVersion) : undefined)
      .orderBy(desc(ethicsAcknowledgements.acknowledgedAt)).limit(1000);
    return { register: rows.map((r: any) => ({ username: r.username, policy_version: r.policyVersion, acknowledged_at: r.acknowledgedAt })), count: rows.length };
  }

  // ELC-04 — file a whistleblower report (any authenticated staff). Anonymous by default: the reporter is
  // recorded only when the submitter opts OUT of anonymity (non-retaliation).
  async fileCase(user: JwtUser, dto: { allegation: string; category?: string; anonymous?: boolean }) {
    const db = this.db as any;
    const anonymous = dto.anonymous !== false; // default anonymous
    const caseRef = `WB-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [row] = await db.insert(whistleblowerCases).values({
      tenantId: user.tenantId ?? null, caseRef, category: dto.category ?? null, allegation: dto.allegation,
      reporter: anonymous ? null : user.username, anonymous, status: 'received',
    }).returning({ caseRef: whistleblowerCases.caseRef, status: whistleblowerCases.status });
    return { case_ref: row.caseRef, status: row.status, anonymous };
  }

  // ELC-04 — the case log (audit committee / compliance). Tenant-scoped by RLS.
  async listCases(status?: string) {
    const db = this.db as any;
    const rows = await db.select().from(whistleblowerCases)
      .where(status ? eq(whistleblowerCases.status, status) : undefined)
      .orderBy(desc(whistleblowerCases.submittedAt)).limit(500);
    return {
      cases: rows.map((c: any) => ({
        case_ref: c.caseRef, category: c.category, allegation: c.allegation, reporter: c.reporter, anonymous: c.anonymous,
        status: c.status, resolution_note: c.resolutionNote, handled_by: c.handledBy, submitted_at: c.submittedAt, updated_at: c.updatedAt,
      })),
      count: rows.length,
    };
  }

  // ELC-04 — advance a case through its lifecycle with a resolution note (audit committee / compliance).
  async updateCase(caseRef: string, dto: { status: string; resolution_note?: string }, user: JwtUser) {
    const db = this.db as any;
    if (!STATUSES.includes(dto.status as any)) throw new BadRequestException({ code: 'BAD_STATUS', message: `status must be one of ${STATUSES.join(', ')}`, messageTh: 'สถานะไม่ถูกต้อง' });
    const [existing] = await db.select().from(whistleblowerCases).where(eq(whistleblowerCases.caseRef, caseRef)).limit(1);
    if (!existing) throw new NotFoundException({ code: 'CASE_NOT_FOUND', message: 'Whistleblower case not found', messageTh: 'ไม่พบเคสแจ้งเบาะแส' });
    await db.update(whistleblowerCases).set({
      status: dto.status, resolutionNote: dto.resolution_note ?? existing.resolutionNote, handledBy: user.username, updatedAt: new Date(),
    }).where(eq(whistleblowerCases.caseRef, caseRef));
    return { case_ref: caseRef, status: dto.status, handled_by: user.username };
  }
}
