import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { dsarRequests, pdpaErasures, posMembers, memberConsents, loyaltyReceiptSubmissions } from '../../database/schema';
import { posMemberLedger } from '../../database/schema/loyalty-members';
import type { JwtUser } from '../../common/decorators';

const REQUEST_TYPES = ['access', 'rectification', 'erasure', 'portability', 'objection'] as const;
const SUBJECT_TYPES = ['member', 'customer', 'employee', 'user'] as const;
const DSAR_SLA_DAYS = 30; // PDPA statutory response window

export interface CreateDsarDto {
  subject_type: string;
  subject_ref: string;
  request_type: string;
  details?: string;
}

// PDPA (Thailand) compliance service: Data Subject Access Request lifecycle, subject-data export
// (access/portability), and erasure with read-time pseudonymisation of the immutable audit trail.
@Injectable()
export class PdpaService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private ymd(d: Date) { return d.toISOString().slice(0, 10); }

  async createDsar(dto: CreateDsarDto, user: JwtUser) {
    if (!SUBJECT_TYPES.includes(dto.subject_type as any)) throw new BadRequestException({ code: 'BAD_SUBJECT_TYPE', message: `subject_type must be one of ${SUBJECT_TYPES.join('/')}`, messageTh: 'ประเภทเจ้าของข้อมูลไม่ถูกต้อง' });
    if (!REQUEST_TYPES.includes(dto.request_type as any)) throw new BadRequestException({ code: 'BAD_REQUEST_TYPE', message: `request_type must be one of ${REQUEST_TYPES.join('/')}`, messageTh: 'ประเภทคำขอไม่ถูกต้อง' });
    if (!dto.subject_ref?.trim()) throw new BadRequestException({ code: 'SUBJECT_REQUIRED', message: 'subject_ref is required', messageTh: 'ต้องระบุเจ้าของข้อมูล' });
    const db = this.db as any;
    const due = new Date(Date.now() + DSAR_SLA_DAYS * 86400_000);
    const [row] = await db.insert(dsarRequests).values({
      tenantId: user.tenantId ?? null, subjectType: dto.subject_type, subjectRef: dto.subject_ref.trim(),
      requestType: dto.request_type, status: 'received', details: dto.details ?? null,
      requestedBy: user.username, dueDate: this.ymd(due),
    }).returning();
    return this.view(row);
  }

  async listDsar(status: string | undefined, user: JwtUser) {
    const db = this.db as any;
    const where = status ? eq(dsarRequests.status, status) : undefined;
    const rows = await db.select().from(dsarRequests).where(where).orderBy(desc(dsarRequests.id)).limit(200);
    return { requests: rows.map((r: any) => this.view(r)), count: rows.length };
  }

  async getDsar(id: number, _user: JwtUser) {
    const db = this.db as any;
    const [r] = await db.select().from(dsarRequests).where(eq(dsarRequests.id, id)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'DSAR not found', messageTh: 'ไม่พบคำขอ' });
    return this.view(r);
  }

  private async loadDsar(id: number) {
    const db = this.db as any;
    const [r] = await db.select().from(dsarRequests).where(eq(dsarRequests.id, id)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'DSAR not found', messageTh: 'ไม่พบคำขอ' });
    return r;
  }

  // Access / portability: assemble everything held about the subject into a portable bundle, attach it to
  // the DSAR result, and close the request. Currently implemented for loyalty members (the main PII store).
  async exportSubject(id: number, user: JwtUser) {
    const db = this.db as any;
    const r = await this.loadDsar(id);
    const bundle = await this.collectMember(r.subjectType, r.subjectRef, user);
    await db.update(dsarRequests).set({ status: 'completed', result: bundle, handledBy: user.username, completedAt: new Date() }).where(eq(dsarRequests.id, id));
    return { id, status: 'completed', export: bundle };
  }

  private async collectMember(subjectType: string, subjectRef: string, _user: JwtUser) {
    if (subjectType !== 'member') {
      return { subject_type: subjectType, subject_ref: subjectRef, note: 'No structured PII store wired for this subject type; compile manually.' };
    }
    const db = this.db as any;
    const m = await this.resolveMember(subjectRef);
    if (!m) return { subject_type: subjectType, subject_ref: subjectRef, found: false };
    const consents = await db.select().from(memberConsents).where(eq(memberConsents.memberId, Number(m.id)));
    const ledger = await db.select().from(posMemberLedger).where(eq(posMemberLedger.memberId, Number(m.id))).limit(500);
    // Member-submitted receipt photos (LYL-17) are personal data the subject uploaded themselves — an access
    // request must return them, same as the points ledger.
    const receipts = await db.select().from(loyaltyReceiptSubmissions).where(eq(loyaltyReceiptSubmissions.memberId, Number(m.id))).limit(200);
    return {
      subject_type: 'member', found: true,
      profile: { id: Number(m.id), member_code: m.memberCode, name: m.name, phone: m.phone, email: m.email, line_user_id: m.lineUserId, birthday: m.birthday, tier: m.tier, balance: m.balance, marketing_opt_in: m.marketingOptIn, enrolled_at: m.enrolledAt },
      consents: consents.map((c: any) => ({ purpose: c.purpose, granted: c.granted, granted_at: c.grantedAt, withdrawn_at: c.withdrawnAt })),
      points_ledger: ledger.map((l: any) => ({ ts: l.txnDate, type: l.txnType, points: l.points, balance_after: l.balanceAfter })),
      receipt_submissions: receipts.map((r: any) => ({ id: Number(r.id), status: r.status, receipt_image: r.receiptImage, purchase_amount: r.purchaseAmount, store_name: r.storeName, purchase_date: r.purchaseDate, note: r.note, submitted_at: r.submittedAt, reviewed_at: r.reviewedAt })),
    };
  }

  private async resolveMember(subjectRef: string) {
    const db = this.db as any;
    const asId = Number(subjectRef);
    if (Number.isFinite(asId) && String(asId) === subjectRef.trim()) {
      const [m] = await db.select().from(posMembers).where(eq(posMembers.id, asId)).limit(1);
      if (m) return m;
    }
    const [byCode] = await db.select().from(posMembers).where(eq(posMembers.memberCode, subjectRef.trim())).limit(1);
    return byCode ?? null;
  }

  // Erasure (right to be forgotten): redact the subject's PII in the operational store and record an
  // erasure-ledger row that drives read-time pseudonymisation of the immutable audit trail. The audit_log
  // rows are NOT mutated (hash chain stays intact) — the PII is simply never shown again.
  async eraseSubject(id: number, user: JwtUser) {
    const db = this.db as any;
    const r = await this.loadDsar(id);
    if (r.requestType !== 'erasure') throw new BadRequestException({ code: 'NOT_ERASURE', message: 'This DSAR is not an erasure request', messageTh: 'คำขอนี้ไม่ใช่การลบข้อมูล' });
    if (r.status === 'completed') throw new BadRequestException({ code: 'ALREADY_DONE', message: 'Already completed', messageTh: 'ดำเนินการแล้ว' });
    if (r.subjectType !== 'member') throw new BadRequestException({ code: 'UNSUPPORTED_SUBJECT', message: 'Automated erasure currently supports member subjects', messageTh: 'รองรับการลบเฉพาะสมาชิก' });

    const m = await this.resolveMember(r.subjectRef);
    if (!m) throw new NotFoundException({ code: 'SUBJECT_NOT_FOUND', message: 'Subject not found', messageTh: 'ไม่พบเจ้าของข้อมูล' });

    // The PII strings to scrub from any audit-trail rendering (keep only non-empty).
    const erasedValues = [m.name, m.phone, m.email, m.lineUserId, m.lineDisplayName, m.cardNo].filter((v: any) => !!v && String(v).trim());
    const pseudonym = `PDPA-ERASED-${Number(m.id)}`;

    // 1. Redact PII in the operational record (keep id + member_code for referential integrity; keep
    //    aggregate balance/tier which are not direct identifiers).
    await db.update(posMembers).set({
      name: '[erased]', phone: null, email: null, cardNo: null, lineUserId: null, lineDisplayName: null,
      birthday: null, marketingOptIn: false, active: false, lastUpdated: new Date(),
    }).where(eq(posMembers.id, Number(m.id)));
    // 2. Withdraw all consents.
    await db.update(memberConsents).set({ granted: false, withdrawnAt: new Date() }).where(eq(memberConsents.memberId, Number(m.id)));
    // 2b. Redact receipt-upload submissions (LYL-17) — the photo + freeform fields are personal data, redacted
    //    in place (not append-only, unlike audit_log) directly on the row. purchase_amount/status/ref_doc stay
    //    (transactional facts already reflected in the points ledger, not identifiers), same as balance/tier.
    await db.update(loyaltyReceiptSubmissions).set({ receiptImage: '[erased]', storeName: null, note: null }).where(eq(loyaltyReceiptSubmissions.memberId, Number(m.id)));
    // 3. Record the erasure ledger row (drives audit pseudonymisation).
    await db.insert(pdpaErasures).values({
      tenantId: user.tenantId ?? null, subjectType: 'member', subjectId: Number(m.id),
      pseudonym, erasedValues, dsarId: id, erasedBy: user.username,
    });
    // 4. Close the DSAR.
    await db.update(dsarRequests).set({ status: 'completed', handledBy: user.username, completedAt: new Date(), result: { erased: true, pseudonym, fields_redacted: ['name', 'phone', 'email', 'card_no', 'line_user_id', 'line_display_name', 'birthday', 'receipt_image', 'receipt_store_name', 'receipt_note'] } }).where(eq(dsarRequests.id, id));

    return { id, status: 'completed', erased: true, pseudonym };
  }

  async rejectDsar(id: number, reason: string | undefined, user: JwtUser) {
    const db = this.db as any;
    await this.loadDsar(id);
    await db.update(dsarRequests).set({ status: 'rejected', handledBy: user.username, completedAt: new Date(), result: { rejected: true, reason: reason ?? null } }).where(eq(dsarRequests.id, id));
    return { id, status: 'rejected' };
  }

  // ── Read-time audit pseudonymisation ────────────────────────────────────────
  // Build the tenant's PII→pseudonym replacement map. Used by the audit viewer/exports to mask erased
  // subjects without touching the immutable, hash-chained stored rows. RLS scopes the read to the caller's
  // tenant (runs inside the request tx), so no explicit tenant arg is needed.
  async erasureMap(): Promise<Array<{ pseudonym: string; values: string[] }>> {
    const db = this.db as any;
    const rows = await db.select({ pseudonym: pdpaErasures.pseudonym, erasedValues: pdpaErasures.erasedValues }).from(pdpaErasures);
    return rows.map((r: any) => ({ pseudonym: r.pseudonym, values: Array.isArray(r.erasedValues) ? r.erasedValues : [] }));
  }

  // Apply the erasure map to audit rows in place of the raw stored PII.
  async maskAuditRows<T extends Record<string, any>>(rows: T[]): Promise<T[]> {
    const map = await this.erasureMap();
    if (!map.length || !rows.length) return rows;
    const subs: Array<[string, string]> = [];
    for (const e of map) for (const v of e.values) if (v) subs.push([v, e.pseudonym]);
    if (!subs.length) return rows;
    const maskStr = (s: string) => subs.reduce((acc, [from, to]) => acc.split(from).join(to), s);
    return rows.map((r) => {
      const out: any = { ...r };
      for (const k of ['actor', 'entity', 'entity_id', 'entityId']) if (typeof out[k] === 'string') out[k] = maskStr(out[k]);
      if (out.meta != null) {
        try { out.meta = JSON.parse(maskStr(JSON.stringify(out.meta))); } catch { /* leave meta as-is */ }
      }
      return out;
    });
  }

  private view(r: any) {
    return {
      id: Number(r.id), subject_type: r.subjectType, subject_ref: r.subjectRef, request_type: r.requestType,
      status: r.status, details: r.details ?? null, result: r.result ?? null, requested_by: r.requestedBy,
      handled_by: r.handledBy ?? null, due_date: r.dueDate, created_at: r.createdAt, completed_at: r.completedAt ?? null,
    };
  }
}
