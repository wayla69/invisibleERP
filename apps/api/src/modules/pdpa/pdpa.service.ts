import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { dsarRequests, pdpaErasures, ropaActivities, posMembers, memberConsents, loyaltyReceiptSubmissions, employees, payslips } from '../../database/schema';
import { posMemberLedger } from '../../database/schema/loyalty-members';
import { objectUrl, deleteObject } from '../../common/object-storage';
import type { JwtUser } from '../../common/decorators';

const REQUEST_TYPES = ['access', 'rectification', 'erasure', 'portability', 'objection'] as const;
const SUBJECT_TYPES = ['member', 'customer', 'employee', 'user'] as const;
const DSAR_SLA_DAYS = 30; // PDPA statutory response window
const ROPA_LEGAL_BASES = ['consent', 'contract', 'legal_obligation', 'legitimate_interest', 'vital_interest', 'public_task'] as const;

export interface CreateDsarDto {
  subject_type: string;
  subject_ref: string;
  request_type: string;
  details?: string;
}

export interface CreateRopaDto {
  name: string;
  purpose: string;
  legal_basis: string;
  data_categories?: string[];
  data_subjects?: string[];
  recipients?: string[];
  sub_processors?: string[];
  retention_period?: string | null;
  cross_border?: string | null;
  security_measures?: string | null;
}

// PDPA (Thailand) compliance service: Data Subject Access Request lifecycle, subject-data export
// (access/portability), and erasure with read-time pseudonymisation of the immutable audit trail.
@Injectable()
export class PdpaService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private ymd(d: Date) { return d.toISOString().slice(0, 10); }

  async createDsar(dto: CreateDsarDto, user: JwtUser) {
    if (!(SUBJECT_TYPES as readonly string[]).includes(dto.subject_type)) throw new BadRequestException({ code: 'BAD_SUBJECT_TYPE', message: `subject_type must be one of ${SUBJECT_TYPES.join('/')}`, messageTh: 'ประเภทเจ้าของข้อมูลไม่ถูกต้อง' });
    if (!(REQUEST_TYPES as readonly string[]).includes(dto.request_type)) throw new BadRequestException({ code: 'BAD_REQUEST_TYPE', message: `request_type must be one of ${REQUEST_TYPES.join('/')}`, messageTh: 'ประเภทคำขอไม่ถูกต้อง' });
    if (!dto.subject_ref?.trim()) throw new BadRequestException({ code: 'SUBJECT_REQUIRED', message: 'subject_ref is required', messageTh: 'ต้องระบุเจ้าของข้อมูล' });
    const db = this.db;
    const due = new Date(Date.now() + DSAR_SLA_DAYS * 86400_000);
    const [row] = await db.insert(dsarRequests).values({
      tenantId: user.tenantId ?? null, subjectType: dto.subject_type, subjectRef: dto.subject_ref.trim(),
      requestType: dto.request_type, status: 'received', details: dto.details ?? null,
      requestedBy: user.username, dueDate: this.ymd(due),
    }).returning();
    return this.view(row);
  }

  // ───────────────────── RoPA — Records of Processing Activities (PDPA-03, มาตรา 39 / GDPR Art.30) ─────────────────────
  private ropaView(r: any) {
    return {
      id: Number(r.id), name: r.name, purpose: r.purpose, legal_basis: r.legalBasis,
      data_categories: r.dataCategories ?? [], data_subjects: r.dataSubjects ?? [], recipients: r.recipients ?? [],
      sub_processors: r.subProcessors ?? [], retention_period: r.retentionPeriod ?? null, cross_border: r.crossBorder ?? null,
      security_measures: r.securityMeasures ?? null, active: r.active, created_by: r.createdBy, updated_by: r.updatedBy,
      created_at: r.createdAt, updated_at: r.updatedAt,
    };
  }
  private validateRopa(dto: CreateRopaDto) {
    if (!dto.name?.trim()) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'name is required', messageTh: 'ต้องระบุชื่อกิจกรรม' });
    if (!dto.purpose?.trim()) throw new BadRequestException({ code: 'PURPOSE_REQUIRED', message: 'purpose is required', messageTh: 'ต้องระบุวัตถุประสงค์' });
    if (!(ROPA_LEGAL_BASES as readonly string[]).includes(dto.legal_basis)) throw new BadRequestException({ code: 'BAD_LEGAL_BASIS', message: `legal_basis must be one of ${ROPA_LEGAL_BASES.join('/')}`, messageTh: 'ฐานทางกฎหมายไม่ถูกต้อง' });
  }
  async listRopa(user: JwtUser, activeOnly?: boolean) {
    const db = this.db;
    const where = activeOnly ? eq(ropaActivities.active, true) : undefined;
    const rows = await db.select().from(ropaActivities).where(where).orderBy(desc(ropaActivities.id)).limit(500);
    return { activities: rows.map((r: any) => this.ropaView(r)), count: rows.length };
  }
  async getRopa(id: number, _user: JwtUser) {
    const [r] = await this.db.select().from(ropaActivities).where(eq(ropaActivities.id, id)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'RoPA activity not found', messageTh: 'ไม่พบกิจกรรมการประมวลผล' });
    return this.ropaView(r);
  }
  async createRopa(dto: CreateRopaDto, user: JwtUser) {
    this.validateRopa(dto);
    const [row] = await this.db.insert(ropaActivities).values({
      tenantId: user.tenantId ?? null, name: dto.name.trim(), purpose: dto.purpose.trim(), legalBasis: dto.legal_basis,
      dataCategories: dto.data_categories ?? [], dataSubjects: dto.data_subjects ?? [], recipients: dto.recipients ?? [],
      subProcessors: dto.sub_processors ?? [], retentionPeriod: dto.retention_period ?? null, crossBorder: dto.cross_border ?? null,
      securityMeasures: dto.security_measures ?? null, createdBy: user.username, updatedBy: user.username,
    }).returning();
    return this.ropaView(row);
  }
  async updateRopa(id: number, dto: Partial<CreateRopaDto> & { active?: boolean }, user: JwtUser) {
    const db = this.db;
    const [existing] = await db.select().from(ropaActivities).where(eq(ropaActivities.id, id)).limit(1);
    if (!existing) throw new NotFoundException({ code: 'NOT_FOUND', message: 'RoPA activity not found', messageTh: 'ไม่พบกิจกรรมการประมวลผล' });
    if (dto.legal_basis !== undefined && !(ROPA_LEGAL_BASES as readonly string[]).includes(dto.legal_basis)) throw new BadRequestException({ code: 'BAD_LEGAL_BASIS', message: `legal_basis must be one of ${ROPA_LEGAL_BASES.join('/')}`, messageTh: 'ฐานทางกฎหมายไม่ถูกต้อง' });
    const patch: Record<string, unknown> = { updatedBy: user.username, updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.purpose !== undefined) patch.purpose = dto.purpose.trim();
    if (dto.legal_basis !== undefined) patch.legalBasis = dto.legal_basis;
    if (dto.data_categories !== undefined) patch.dataCategories = dto.data_categories;
    if (dto.data_subjects !== undefined) patch.dataSubjects = dto.data_subjects;
    if (dto.recipients !== undefined) patch.recipients = dto.recipients;
    if (dto.sub_processors !== undefined) patch.subProcessors = dto.sub_processors;
    if (dto.retention_period !== undefined) patch.retentionPeriod = dto.retention_period;
    if (dto.cross_border !== undefined) patch.crossBorder = dto.cross_border;
    if (dto.security_measures !== undefined) patch.securityMeasures = dto.security_measures;
    if (dto.active !== undefined) patch.active = dto.active;
    await db.update(ropaActivities).set(patch).where(eq(ropaActivities.id, id));
    return this.getRopa(id, user);
  }

  async listDsar(status: string | undefined, user: JwtUser) {
    const db = this.db;
    const where = status ? eq(dsarRequests.status, status) : undefined;
    const rows = await db.select().from(dsarRequests).where(where).orderBy(desc(dsarRequests.id)).limit(200);
    return { requests: rows.map((r: any) => this.view(r)), count: rows.length };
  }

  async getDsar(id: number, _user: JwtUser) {
    const db = this.db;
    const [r] = await db.select().from(dsarRequests).where(eq(dsarRequests.id, id)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'DSAR not found', messageTh: 'ไม่พบคำขอ' });
    return this.view(r);
  }

  private async loadDsar(id: number) {
    const db = this.db;
    const [r] = await db.select().from(dsarRequests).where(eq(dsarRequests.id, id)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'DSAR not found', messageTh: 'ไม่พบคำขอ' });
    return r;
  }

  // Access / portability: assemble everything held about the subject into a portable bundle, attach it to
  // the DSAR result, and close the request. Currently implemented for loyalty members (the main PII store).
  async exportSubject(id: number, user: JwtUser) {
    const db = this.db;
    const r = await this.loadDsar(id);
    const bundle = r.subjectType === 'employee'
      ? await this.collectEmployee(r.subjectRef)
      : await this.collectMember(r.subjectType, r.subjectRef, user);
    await db.update(dsarRequests).set({ status: 'completed', result: bundle, handledBy: user.username, completedAt: new Date() }).where(eq(dsarRequests.id, id));
    return { id, status: 'completed', export: bundle };
  }

  private async collectMember(subjectType: string, subjectRef: string, _user: JwtUser) {
    if (subjectType !== 'member') {
      return { subject_type: subjectType, subject_ref: subjectRef, note: 'No structured PII store wired for this subject type; compile manually.' };
    }
    const db = this.db;
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
      receipt_submissions: receipts.map((r: any) => ({ id: Number(r.id), status: r.status, receipt_image: objectUrl(r.receiptImage), purchase_amount: r.purchaseAmount, store_name: r.storeName, purchase_date: r.purchaseDate, note: r.note, submitted_at: r.submittedAt, reviewed_at: r.reviewedAt })),
    };
  }

  // Employee data subject (docs/27 AUD-LGL-03 — deferred from R0-1). An ACCESS/PORTABILITY request must
  // return the identifiers the employer actually holds — the encryptedText columns decrypt on this read
  // (ITGC-AC-19), which is correct: the subject is entitled to their own citizen ID / bank account.
  private async collectEmployee(subjectRef: string) {
    const db = this.db;
    const e = await this.resolveEmployee(subjectRef);
    if (!e) return { subject_type: 'employee', subject_ref: subjectRef, found: false };
    const slips = await db.select().from(payslips).where(eq(payslips.employeeId, Number(e.id))).limit(500);
    return {
      subject_type: 'employee', found: true,
      profile: {
        id: Number(e.id), emp_code: e.empCode, name: e.name, national_id: e.nationalId, sso_no: e.ssoNo,
        bank_account: e.bankAccount, position: e.position, department: e.department,
        monthly_salary: e.monthlySalary, start_date: e.startDate, active: e.active !== false,
      },
      payslips: slips.map((s2: any) => ({ payrun_id: Number(s2.payrunId), gross: s2.gross, sso_employee: s2.ssoEmployee, wht: s2.wht, net: s2.net, created_at: s2.createdAt })),
      retention_note: 'Payroll/payslip records are retained per Thai statutory periods (Revenue Code / Accounting Act) even after an erasure request — see PDPA-02.',
    };
  }

  private async resolveEmployee(subjectRef: string) {
    const db = this.db;
    const asId = Number(subjectRef);
    if (Number.isFinite(asId) && String(asId) === subjectRef.trim()) {
      const [e] = await db.select().from(employees).where(eq(employees.id, asId)).limit(1);
      if (e) return e;
    }
    const [byCode] = await db.select().from(employees).where(eq(employees.empCode, subjectRef.trim())).limit(1);
    return byCode ?? null;
  }

  private async resolveMember(subjectRef: string) {
    const db = this.db;
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
    const db = this.db;
    const r = await this.loadDsar(id);
    if (r.requestType !== 'erasure') throw new BadRequestException({ code: 'NOT_ERASURE', message: 'This DSAR is not an erasure request', messageTh: 'คำขอนี้ไม่ใช่การลบข้อมูล' });
    if (r.status === 'completed') throw new BadRequestException({ code: 'ALREADY_DONE', message: 'Already completed', messageTh: 'ดำเนินการแล้ว' });
    if (r.subjectType === 'employee') return this.eraseEmployee(r, id, user);
    if (r.subjectType !== 'member') throw new BadRequestException({ code: 'UNSUPPORTED_SUBJECT', message: 'Automated erasure currently supports member and employee subjects', messageTh: 'รองรับการลบเฉพาะสมาชิกและพนักงาน' });

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
    //    When the photo bytes were offloaded to object storage, also delete the object (best-effort) so erasure
    //    is complete — not just the DB reference.
    const imgs = await db.select({ img: loyaltyReceiptSubmissions.receiptImage }).from(loyaltyReceiptSubmissions).where(eq(loyaltyReceiptSubmissions.memberId, Number(m.id)));
    for (const row of imgs) await deleteObject(row.img);
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

  // Employee erasure (AUD-LGL-03): redact the master-record identifiers; PAYSLIPS AND PAYRUNS ARE KEPT —
  // payroll/withholding records are statutory accounting records (Revenue Code / Accounting Act retention),
  // squarely inside PDPA's legal-obligation exemption. Mirrors PDPA-02's reconcile-don't-destroy design:
  // the erasure ledger read-time-pseudonymises the audit trail, the hash chain stays intact.
  private async eraseEmployee(r: any, id: number, user: JwtUser) {
    const db = this.db;
    const e = await this.resolveEmployee(r.subjectRef);
    if (!e) throw new NotFoundException({ code: 'SUBJECT_NOT_FOUND', message: 'Subject not found', messageTh: 'ไม่พบเจ้าของข้อมูล' });
    // Decrypted identifier values (schema read) → the audit-masking substitution list.
    const erasedValues = [e.name, e.nationalId, e.ssoNo, e.bankAccount].filter((v: any) => !!v && String(v).trim());
    const pseudonym = `PDPA-ERASED-EMP-${Number(e.id)}`;
    await db.update(employees).set({
      name: '[erased]', nationalId: null, ssoNo: null, bankAccount: null, userName: null, active: false,
    }).where(eq(employees.id, Number(e.id)));
    await db.insert(pdpaErasures).values({
      tenantId: user.tenantId ?? null, subjectType: 'employee', subjectId: Number(e.id),
      pseudonym, erasedValues, dsarId: id, erasedBy: user.username,
    });
    await db.update(dsarRequests).set({
      status: 'completed', handledBy: user.username, completedAt: new Date(),
      result: { erased: true, pseudonym, fields_redacted: ['name', 'national_id', 'sso_no', 'bank_account', 'user_name'], retained_statutory: ['payslips', 'payruns'], retention_basis: 'Revenue Code / Accounting Act (PDPA legal-obligation exemption)' },
    }).where(eq(dsarRequests.id, id));
    return { id, status: 'completed', erased: true, pseudonym };
  }

  async rejectDsar(id: number, reason: string | undefined, user: JwtUser) {
    const db = this.db;
    await this.loadDsar(id);
    await db.update(dsarRequests).set({ status: 'rejected', handledBy: user.username, completedAt: new Date(), result: { rejected: true, reason: reason ?? null } }).where(eq(dsarRequests.id, id));
    return { id, status: 'rejected' };
  }

  // ── Read-time audit pseudonymisation ────────────────────────────────────────
  // Build the tenant's PII→pseudonym replacement map. Used by the audit viewer/exports to mask erased
  // subjects without touching the immutable, hash-chained stored rows. RLS scopes the read to the caller's
  // tenant (runs inside the request tx), so no explicit tenant arg is needed.
  async erasureMap(): Promise<Array<{ pseudonym: string; values: string[] }>> {
    const db = this.db;
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
