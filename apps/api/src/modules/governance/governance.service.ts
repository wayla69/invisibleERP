import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { ethicsAcknowledgements, whistleblowerCases, delegationOfAuthority, fraudRisks, governanceOversight } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

const STATUSES = ['received', 'investigating', 'resolved', 'dismissed'] as const;
const RISK_STATUSES = ['open', 'mitigated', 'accepted', 'closed'] as const;
const LEVELS = ['low', 'medium', 'high'] as const;
const n2 = (v: any) => (v == null ? null : Number(v));

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

  // ───────────────── ELC-03 — Delegation-of-Authority matrix ─────────────────
  // Define (or update) who may authorize what, up to what limit. Upsert per (tenant, area, role).
  async setAuthority(user: JwtUser, dto: { authority_area: string; role: string; approval_limit?: number | null; currency?: string; notes?: string; effective_from?: string }) {
    const db = this.db as any;
    const vals = {
      tenantId: user.tenantId ?? null, authorityArea: dto.authority_area, role: dto.role,
      approvalLimit: dto.approval_limit != null ? String(dto.approval_limit) : null,
      currency: dto.currency ?? 'THB', notes: dto.notes ?? null, effectiveFrom: dto.effective_from ?? null, createdBy: user.username,
    };
    await db.insert(delegationOfAuthority).values(vals).onConflictDoUpdate({
      target: [delegationOfAuthority.tenantId, delegationOfAuthority.authorityArea, delegationOfAuthority.role],
      set: { approvalLimit: vals.approvalLimit, currency: vals.currency, notes: vals.notes, effectiveFrom: vals.effectiveFrom, createdBy: vals.createdBy },
    });
    return { authority_area: dto.authority_area, role: dto.role, approval_limit: dto.approval_limit ?? null, currency: vals.currency };
  }

  async listAuthority() {
    const db = this.db as any;
    const rows = await db.select().from(delegationOfAuthority).orderBy(desc(delegationOfAuthority.id)).limit(500);
    return { matrix: rows.map((r: any) => ({ authority_area: r.authorityArea, role: r.role, approval_limit: n2(r.approvalLimit), currency: r.currency, notes: r.notes, effective_from: r.effectiveFrom })), count: rows.length };
  }

  // ───────────────── ELC-05 — Fraud-risk register ─────────────────
  async fileFraudRisk(user: JwtUser, dto: { area: string; description: string; likelihood?: string; impact?: string; mitigating_controls?: string; owner?: string }) {
    const db = this.db as any;
    const lk = LEVELS.includes((dto.likelihood ?? 'medium') as any) ? dto.likelihood : 'medium';
    const im = LEVELS.includes((dto.impact ?? 'medium') as any) ? dto.impact : 'medium';
    const riskRef = `FR-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [row] = await db.insert(fraudRisks).values({
      tenantId: user.tenantId ?? null, riskRef, area: dto.area, description: dto.description, likelihood: lk, impact: im,
      mitigatingControls: dto.mitigating_controls ?? null, owner: dto.owner ?? null, status: 'open', createdBy: user.username,
    }).returning({ riskRef: fraudRisks.riskRef, status: fraudRisks.status });
    return { risk_ref: row.riskRef, status: row.status };
  }

  async listFraudRisks(status?: string) {
    const db = this.db as any;
    const rows = await db.select().from(fraudRisks).where(status ? eq(fraudRisks.status, status) : undefined).orderBy(desc(fraudRisks.id)).limit(500);
    return { risks: rows.map((r: any) => ({ risk_ref: r.riskRef, area: r.area, description: r.description, likelihood: r.likelihood, impact: r.impact, mitigating_controls: r.mitigatingControls, owner: r.owner, status: r.status, last_reviewed_at: r.lastReviewedAt })), count: rows.length };
  }

  // Review a fraud risk: advance its status + stamp last_reviewed_at (the periodic review evidence).
  async reviewFraudRisk(riskRef: string, dto: { status: string; mitigating_controls?: string; owner?: string }, user: JwtUser) {
    const db = this.db as any;
    if (!RISK_STATUSES.includes(dto.status as any)) throw new BadRequestException({ code: 'BAD_STATUS', message: `status must be one of ${RISK_STATUSES.join(', ')}`, messageTh: 'สถานะไม่ถูกต้อง' });
    const [existing] = await db.select().from(fraudRisks).where(eq(fraudRisks.riskRef, riskRef)).limit(1);
    if (!existing) throw new NotFoundException({ code: 'RISK_NOT_FOUND', message: 'Fraud risk not found', messageTh: 'ไม่พบความเสี่ยงทุจริต' });
    await db.update(fraudRisks).set({
      status: dto.status, mitigatingControls: dto.mitigating_controls ?? existing.mitigatingControls, owner: dto.owner ?? existing.owner, lastReviewedAt: new Date(),
    }).where(eq(fraudRisks.riskRef, riskRef));
    return { risk_ref: riskRef, status: dto.status, reviewed_by: user.username };
  }

  // ───────────────── ELC-02 — Audit-committee / governance oversight log ─────────────────
  async recordOversight(user: JwtUser, dto: { meeting_date: string; kind?: string; topics?: string; icfr_reviewed?: boolean; findings_reviewed?: string; attendees?: string; minutes_ref?: string; signed_off_by?: string }) {
    const db = this.db as any;
    const [row] = await db.insert(governanceOversight).values({
      tenantId: user.tenantId ?? null, meetingDate: dto.meeting_date, kind: dto.kind ?? 'audit_committee', topics: dto.topics ?? null,
      icfrReviewed: dto.icfr_reviewed ?? false, findingsReviewed: dto.findings_reviewed ?? null, attendees: dto.attendees ?? null,
      minutesRef: dto.minutes_ref ?? null, signedOffBy: dto.signed_off_by ?? null, createdBy: user.username,
    }).returning({ id: governanceOversight.id });
    return { id: Number(row.id), meeting_date: dto.meeting_date, kind: dto.kind ?? 'audit_committee', icfr_reviewed: dto.icfr_reviewed ?? false };
  }

  async listOversight() {
    const db = this.db as any;
    const rows = await db.select().from(governanceOversight).orderBy(desc(governanceOversight.meetingDate)).limit(200);
    return { meetings: rows.map((m: any) => ({ id: Number(m.id), meeting_date: m.meetingDate, kind: m.kind, topics: m.topics, icfr_reviewed: m.icfrReviewed, findings_reviewed: m.findingsReviewed, attendees: m.attendees, minutes_ref: m.minutesRef, signed_off_by: m.signedOffBy })), count: rows.length };
  }
}
