import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc, gte, ne, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { ethicsAcknowledgements, whistleblowerCases, delegationOfAuthority, fraudRisks, governanceOversight, users, selfApprovals } from '../../database/schema';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const STATUSES = ['received', 'investigating', 'resolved', 'dismissed'] as const;
const RISK_STATUSES = ['open', 'mitigated', 'accepted', 'closed'] as const;
const LEVELS = ['low', 'medium', 'high'] as const;
const OPEN_CASE = ['received', 'investigating'] as const;
const OVERSIGHT_CADENCE_DAYS = 92;   // quarterly audit-committee cadence (≈ one quarter)
const HOTLINE_SLA_DAYS = 30;          // a whistleblower case open beyond this is overdue
const n2 = (v: any) => (v == null ? null : Number(v));
const addDays = (ymdStr: string, days: number) => { const d = new Date(`${ymdStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const toYmd = (ts: any) => { const d = ts instanceof Date ? ts : new Date(ts); return d.toISOString().slice(0, 10); };

// Entity-level governance evidence capture (ELC-01 ethics-acknowledgement register, ELC-04 whistleblower
// case log). Tenant-scoped by RLS; the policy + governance bodies remain an org/PMO process.
@Injectable()
export class GovernanceService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ELC-01 — record a staff member's acknowledgement of a code-of-conduct version (idempotent per version).
  async acknowledgeEthics(user: JwtUser, policyVersion: string) {
    const db = this.db;
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
    const db = this.db;
    const rows = await db.select().from(ethicsAcknowledgements)
      .where(policyVersion ? eq(ethicsAcknowledgements.policyVersion, policyVersion) : undefined)
      .orderBy(desc(ethicsAcknowledgements.acknowledgedAt)).limit(1000);
    return { register: rows.map((r: any) => ({ username: r.username, policy_version: r.policyVersion, acknowledged_at: r.acknowledgedAt })), count: rows.length };
  }

  // ELC-04 — file a whistleblower report (any authenticated staff). Anonymous by default: the reporter is
  // recorded only when the submitter opts OUT of anonymity (non-retaliation).
  async fileCase(user: JwtUser, dto: { allegation: string; category?: string; anonymous?: boolean }) {
    const db = this.db;
    const anonymous = dto.anonymous !== false; // default anonymous
    const caseRef = `WB-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [row] = await db.insert(whistleblowerCases).values({
      tenantId: user.tenantId ?? null, caseRef, category: dto.category ?? null, allegation: dto.allegation,
      reporter: anonymous ? null : user.username, anonymous, status: 'received',
    }).returning({ caseRef: whistleblowerCases.caseRef, status: whistleblowerCases.status });
    return { case_ref: row!.caseRef, status: row!.status, anonymous };
  }

  // ELC-04 — the case log (audit committee / compliance). Tenant-scoped by RLS.
  async listCases(status?: string) {
    const db = this.db;
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
    const db = this.db;
    if (!(STATUSES as readonly string[]).includes(dto.status)) throw new BadRequestException({ code: 'BAD_STATUS', message: `status must be one of ${STATUSES.join(', ')}`, messageTh: 'สถานะไม่ถูกต้อง' });
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
    const db = this.db;
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
    const db = this.db;
    const rows = await db.select().from(delegationOfAuthority).orderBy(desc(delegationOfAuthority.id)).limit(500);
    return { matrix: rows.map((r: any) => ({ authority_area: r.authorityArea, role: r.role, approval_limit: n2(r.approvalLimit), currency: r.currency, notes: r.notes, effective_from: r.effectiveFrom })), count: rows.length };
  }

  // ───────────────── ELC-05 — Fraud-risk register ─────────────────
  async fileFraudRisk(user: JwtUser, dto: { area: string; description: string; likelihood?: string; impact?: string; mitigating_controls?: string; owner?: string }) {
    const db = this.db;
    const lk = (LEVELS as readonly string[]).includes(dto.likelihood ?? 'medium') ? dto.likelihood : 'medium';
    const im = (LEVELS as readonly string[]).includes(dto.impact ?? 'medium') ? dto.impact : 'medium';
    const riskRef = `FR-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [row] = await db.insert(fraudRisks).values({
      tenantId: user.tenantId ?? null, riskRef, area: dto.area, description: dto.description, likelihood: lk, impact: im,
      mitigatingControls: dto.mitigating_controls ?? null, owner: dto.owner ?? null, status: 'open', createdBy: user.username,
    }).returning({ riskRef: fraudRisks.riskRef, status: fraudRisks.status });
    return { risk_ref: row!.riskRef, status: row!.status };
  }

  async listFraudRisks(status?: string) {
    const db = this.db;
    const rows = await db.select().from(fraudRisks).where(status ? eq(fraudRisks.status, status) : undefined).orderBy(desc(fraudRisks.id)).limit(500);
    return { risks: rows.map((r: any) => ({ risk_ref: r.riskRef, area: r.area, description: r.description, likelihood: r.likelihood, impact: r.impact, mitigating_controls: r.mitigatingControls, owner: r.owner, status: r.status, last_reviewed_at: r.lastReviewedAt })), count: rows.length };
  }

  // Review a fraud risk: advance its status + stamp last_reviewed_at (the periodic review evidence).
  async reviewFraudRisk(riskRef: string, dto: { status: string; mitigating_controls?: string; owner?: string }, user: JwtUser) {
    const db = this.db;
    if (!(RISK_STATUSES as readonly string[]).includes(dto.status)) throw new BadRequestException({ code: 'BAD_STATUS', message: `status must be one of ${RISK_STATUSES.join(', ')}`, messageTh: 'สถานะไม่ถูกต้อง' });
    const [existing] = await db.select().from(fraudRisks).where(eq(fraudRisks.riskRef, riskRef)).limit(1);
    if (!existing) throw new NotFoundException({ code: 'RISK_NOT_FOUND', message: 'Fraud risk not found', messageTh: 'ไม่พบความเสี่ยงทุจริต' });
    await db.update(fraudRisks).set({
      status: dto.status, mitigatingControls: dto.mitigating_controls ?? existing.mitigatingControls, owner: dto.owner ?? existing.owner, lastReviewedAt: new Date(),
    }).where(eq(fraudRisks.riskRef, riskRef));
    return { risk_ref: riskRef, status: dto.status, reviewed_by: user.username };
  }

  // ───────────────── ELC-02 — Audit-committee / governance oversight log ─────────────────
  async recordOversight(user: JwtUser, dto: { meeting_date: string; kind?: string; topics?: string; icfr_reviewed?: boolean; findings_reviewed?: string; attendees?: string; minutes_ref?: string; signed_off_by?: string }) {
    const db = this.db;
    const [row] = await db.insert(governanceOversight).values({
      tenantId: user.tenantId ?? null, meetingDate: dto.meeting_date, kind: dto.kind ?? 'audit_committee', topics: dto.topics ?? null,
      icfrReviewed: dto.icfr_reviewed ?? false, findingsReviewed: dto.findings_reviewed ?? null, attendees: dto.attendees ?? null,
      minutesRef: dto.minutes_ref ?? null, signedOffBy: dto.signed_off_by ?? null, createdBy: user.username,
    }).returning({ id: governanceOversight.id });
    return { id: Number(row!.id), meeting_date: dto.meeting_date, kind: dto.kind ?? 'audit_committee', icfr_reviewed: dto.icfr_reviewed ?? false };
  }

  async listOversight() {
    const db = this.db;
    const rows = await db.select().from(governanceOversight).orderBy(desc(governanceOversight.meetingDate)).limit(200);
    return { meetings: rows.map((m: any) => ({ id: Number(m.id), meeting_date: m.meetingDate, kind: m.kind, topics: m.topics, icfr_reviewed: m.icfrReviewed, findings_reviewed: m.findingsReviewed, attendees: m.attendees, minutes_ref: m.minutesRef, signed_off_by: m.signedOffBy })), count: rows.length };
  }

  // ───────────────── Governance readiness (operating signals across ELC-01/02/04) ─────────────────
  // The operating dashboard the audit committee / compliance lead watches: code-of-conduct acknowledgement
  // COVERAGE (ELC-01), audit-committee oversight CADENCE / overdue (ELC-02), and whistleblower case AGEING
  // vs SLA (ELC-04). `ready` is true only when none of the three has an outstanding signal. Tenant-scoped by
  // RLS (HQ/bypass sees the aggregate). Exposed at GET /api/governance/readiness AND as the schedulable BI
  // report type `governance_readiness`, so the existing scheduler + notifications give the cadence reminders.
  async readiness(_user: JwtUser, policyVersion = '1.0') {
    const db = this.db;
    const today = ymd(); // business date (Asia/Bangkok)

    // ELC-01 — acknowledgement coverage (active staff, excluding customer/portal accounts).
    const staffRows = await db.select({ u: users.username }).from(users).where(and(eq(users.isActive, true), ne(users.role, 'Customer')));
    const ackRows = await db.select({ u: ethicsAcknowledgements.username }).from(ethicsAcknowledgements).where(eq(ethicsAcknowledgements.policyVersion, policyVersion));
    const acked = new Set(ackRows.map((r: any) => r.u));
    const staff = staffRows.map((r: any) => r.u);
    const outstanding = staff.filter((u: string) => !acked.has(u));
    const total = staff.length;
    const coveragePct = total > 0 ? Math.round((total - outstanding.length) / total * 1000) / 10 : 0;

    // ELC-02 — audit-committee oversight cadence (quarterly). Track last meeting + last ICFR review + next due.
    const [lastMeeting] = await db.select().from(governanceOversight).orderBy(desc(governanceOversight.meetingDate)).limit(1);
    const [lastIcfr] = await db.select().from(governanceOversight).where(eq(governanceOversight.icfrReviewed, true)).orderBy(desc(governanceOversight.meetingDate)).limit(1);
    const lastDate: string | null = lastMeeting?.meetingDate ?? null;
    const lastIcfrDate: string | null = lastIcfr?.meetingDate ?? null;
    const nextDue = lastDate ? addDays(lastDate, OVERSIGHT_CADENCE_DAYS) : null;
    const oversightOverdue = !lastDate || (nextDue != null && today > nextDue);

    // ELC-04 — open whistleblower cases + ageing vs the SLA.
    const openCases = await db.select({ ref: whistleblowerCases.caseRef, submittedAt: whistleblowerCases.submittedAt }).from(whistleblowerCases).where(inArray(whistleblowerCases.status, [...OPEN_CASE]));
    const ages = openCases.map((c: any) => daysBetween(toYmd(c.submittedAt), today));
    const oldestOpen = ages.length ? Math.max(...ages) : 0;
    const overdueCases = ages.filter((d: number) => d > HOTLINE_SLA_DAYS).length;

    const alerts: string[] = [];
    if (outstanding.length) alerts.push(`ELC-01: ${outstanding.length} of ${total} staff have not acknowledged code-of-conduct v${policyVersion} (coverage ${coveragePct}%)`);
    if (oversightOverdue) alerts.push(`ELC-02: audit-committee ICFR oversight is overdue (last meeting ${lastDate ?? 'never'})`);
    if (overdueCases) alerts.push(`ELC-04: ${overdueCases} whistleblower case(s) open beyond the ${HOTLINE_SLA_DAYS}-day SLA (oldest ${oldestOpen}d)`);

    return {
      as_of: today, policy_version: policyVersion, ready: alerts.length === 0, alerts,
      ethics: { coverage_pct: coveragePct, acknowledged: total - outstanding.length, total_active_staff: total, outstanding },
      oversight: { last_meeting: lastDate, last_icfr_review: lastIcfrDate, next_due: nextDue, overdue: oversightOverdue, cadence_days: OVERSIGHT_CADENCE_DAYS },
      hotline: { open_cases: openCases.length, oldest_open_age_days: oldestOpen, overdue_cases: overdueCases, sla_days: HOTLINE_SLA_DAYS },
    };
  }

  // SME-01 (docs/49) — the detective compensating control for the SME single-user edition: every ALLOWED
  // self-approval (maker === checker under control_profile='sme', recorded by assertMakerChecker) in the
  // review window, for independent review by the external accountant + the platform owner. Tenant-scoped
  // by RLS + the explicit filter; a caller with no self-approvals gets a clean, affirmative empty report.
  async selfApprovalReview(user: JwtUser, days = 31) {
    const db = this.db;
    const today = ymd();
    const since = new Date(Date.now() - Math.min(Math.max(Number(days) || 31, 1), 366) * 86400000);
    const conds = [gte(selfApprovals.createdAt, since)];
    if (user.tenantId != null) conds.push(eq(selfApprovals.tenantId, user.tenantId));
    const rows = await db.select().from(selfApprovals).where(and(...conds)).orderBy(desc(selfApprovals.createdAt)).limit(1000);
    const totalAmount = rows.reduce((s: number, r: any) => s + (r.amount != null ? Number(r.amount) : 0), 0);
    const byEvent = new Map<string, number>();
    for (const r of rows) byEvent.set(r.event, (byEvent.get(r.event) ?? 0) + 1);
    return {
      as_of: today,
      window_days: Math.min(Math.max(Number(days) || 31, 1), 366),
      count: rows.length,
      total_amount: Math.round(totalAmount * 100) / 100,
      by_event: [...byEvent.entries()].map(([event, count]) => ({ event, count })),
      items: rows.map((r: any) => ({
        at: r.createdAt, event: r.event, ref: r.ref, username: r.username,
        amount: r.amount != null ? Number(r.amount) : null, reason: r.reason,
      })),
    };
  }
}
