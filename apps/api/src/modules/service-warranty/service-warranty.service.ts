import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { eq, and, sql, gte, lte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { warrantyTerms, installedBase, warrantyClaims } from '../../database/schema/service-warranty';
import { docCountersTenant } from '../../database/schema/system';
import { n, fx, ymd } from '../../database/queries';
import { isUniqueViolation } from '../../common/db-error';
import type { JwtUser } from '../../common/decorators';

// coverage_type / coverage_kind vocabulary. A 'full' term covers any claim kind; otherwise the term must
// match the kind being claimed (a parts-only warranty does not cover a labor claim).
const COVERAGE_TYPES = ['parts', 'labor', 'full'] as const;
type Coverage = (typeof COVERAGE_TYPES)[number];

// Add whole months to a YYYY-MM-DD date (UTC-safe; clamps to end-of-month like SQL date + interval).
function addMonths(ymdStr: string, months: number): string {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const base = new Date(Date.UTC(y!, (m! - 1) + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d!, lastDay);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// SVC-2 — Warranty & Entitlement registry (net-new; distinct from the #666 subscription/SLA ServiceService).
// Implements the SVC-01 coverage-authorization control: a warranty claim is coverage-checked at raise; an
// in-coverage claim auto-authorizes FREE, an out-of-coverage claim parks pending and can only be authorized
// (especially free-of-charge) by a DIFFERENT user than the requester (SOD_SELF_APPROVAL). Detective reads
// surface expiring warranties and an override register of authorized-free out-of-coverage claims.
@Injectable()
export class ServiceWarrantyService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Warranty terms (catalogue) ─────────────────────────────────────────────
  async createTerm(dto: { term_code: string; name: string; coverage_months: number; coverage_type?: string; active?: boolean }, user: JwtUser) {
    const coverageType = this.assertCoverage(dto.coverage_type ?? 'full');
    if (!Number.isInteger(dto.coverage_months) || dto.coverage_months <= 0)
      throw new BadRequestException({ code: 'BAD_COVERAGE_MONTHS', message: 'coverage_months must be a positive integer', messageTh: 'จำนวนเดือนรับประกันต้องเป็นจำนวนเต็มบวก' });
    try {
      const [row] = await this.db.insert(warrantyTerms).values({
        tenantId: user.tenantId!, termCode: dto.term_code, name: dto.name,
        coverageMonths: dto.coverage_months, coverageType, active: dto.active ?? true, createdBy: user.username,
      }).returning();
      return this.fmtTerm(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'TERM_EXISTS', message: `Warranty term ${dto.term_code} already exists`, messageTh: `รหัสเงื่อนไขรับประกัน ${dto.term_code} มีอยู่แล้ว` });
      throw e;
    }
  }

  async listTerms(user: JwtUser) {
    const rows = await this.db.select().from(warrantyTerms).where(eq(warrantyTerms.tenantId, user.tenantId!)).orderBy(sql`${warrantyTerms.id} DESC`);
    return { terms: rows.map((r: any) => this.fmtTerm(r)), count: rows.length };
  }

  // ── Installed base (serialized-unit registry) ──────────────────────────────
  async registerUnit(dto: { serial_no: string; item_code: string; item_id?: number; customer_id?: number; customer_name?: string; sold_date: string; warranty_term_id: number; warranty_start?: string }, user: JwtUser) {
    const term = await this.assertTerm(dto.warranty_term_id, user);
    const warrantyStart = dto.warranty_start ?? dto.sold_date;
    const warrantyEnd = addMonths(warrantyStart, Number(term.coverageMonths));
    try {
      const [row] = await this.db.insert(installedBase).values({
        tenantId: user.tenantId!, serialNo: dto.serial_no, itemCode: dto.item_code, itemId: dto.item_id ?? null,
        customerId: dto.customer_id ?? null, customerName: dto.customer_name ?? null,
        soldDate: dto.sold_date, warrantyTermId: term.id, warrantyStart, warrantyEnd,
        coverageType: term.coverageType, status: 'active', createdBy: user.username,
      }).returning();
      return this.fmtUnit(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'SERIAL_EXISTS', message: `Serial ${dto.serial_no} already registered`, messageTh: `หมายเลขเครื่อง ${dto.serial_no} ลงทะเบียนแล้ว` });
      throw e;
    }
  }

  async listUnits(user: JwtUser) {
    const rows = await this.db.select().from(installedBase).where(eq(installedBase.tenantId, user.tenantId!)).orderBy(sql`${installedBase.id} DESC`);
    return { units: rows.map((r: any) => this.fmtUnit(r)), count: rows.length };
  }

  async getUnit(id: number, user: JwtUser) {
    const unit = await this.assertUnit(id, user);
    const claims = await this.db.select().from(warrantyClaims).where(eq(warrantyClaims.installedBaseId, id)).orderBy(sql`${warrantyClaims.id} DESC`);
    return { ...this.fmtUnit(unit), claims: claims.map((c: any) => this.fmtClaim(c)) };
  }

  // ── Warranty claims + the SVC-01 coverage-authorization control ─────────────
  // A claim is coverage-checked at raise: in coverage = reported_date within the warranty_end window AND the
  // unit's coverage_type covers the claim kind ('full' covers all; else the kinds must match). An in-coverage
  // claim AUTO-AUTHORIZES free (charge 0). An out-of-coverage claim parks 'pending' — it can only be
  // authorized by authorizeClaim (a DIFFERENT user), which is where a free-of-charge override on a
  // non-covered unit is gated + recorded in the coverage-exceptions register.
  async createClaim(dto: { installed_base_id: number; fault: string; coverage_kind?: string; reported_date?: string }, user: JwtUser) {
    const unit = await this.assertUnit(dto.installed_base_id, user);
    const coverageKind = this.assertCoverage(dto.coverage_kind ?? 'full');
    const reportedDate = dto.reported_date ?? ymd();
    const inCoverage = this.isInCoverage(unit, coverageKind, reportedDate);

    const claimNo = await this.nextClaimNo(user.tenantId!);
    const base = {
      tenantId: user.tenantId!, claimNo, installedBaseId: unit.id, reportedDate, fault: dto.fault,
      coverageKind, isInCoverage: inCoverage, requestedBy: user.username,
    };
    // In coverage → auto-authorized free, no maker-checker needed (it is contractually covered).
    const [row] = await this.db.insert(warrantyClaims).values(
      inCoverage
        ? { ...base, status: 'authorized', disposition: 'repair', charge: fx(0, 4), authorizedBy: user.username, decidedAt: new Date() }
        : { ...base, status: 'pending', charge: fx(0, 4) },
    ).returning();
    return this.fmtClaim(row);
  }

  async listClaims(user: JwtUser, status?: string) {
    const where = status
      ? and(eq(warrantyClaims.tenantId, user.tenantId!), eq(warrantyClaims.status, status))
      : eq(warrantyClaims.tenantId, user.tenantId!);
    const rows = await this.db.select().from(warrantyClaims).where(where).orderBy(sql`${warrantyClaims.id} DESC`);
    return { claims: rows.map((c: any) => this.fmtClaim(c)), count: rows.length };
  }

  // Authorize a pending (out-of-coverage) claim. SVC-01 maker-checker: the authorizer MUST differ from the
  // requester (SOD_SELF_APPROVAL) — this is what prevents a single person granting themselves free service /
  // goods on a non-covered unit. charge=0 on an out-of-coverage claim is a deliberate override, recorded in
  // the coverage-exceptions register.
  async authorizeClaim(id: number, dto: { disposition?: string; charge?: number }, user: JwtUser) {
    const claim = await this.assertClaim(id, user);
    if (claim.status !== 'pending')
      throw new BadRequestException({ code: 'CLAIM_NOT_PENDING', message: `Claim ${claim.claimNo} is not pending (status=${claim.status})`, messageTh: `เคลม ${claim.claimNo} ไม่อยู่สถานะรออนุมัติ` });
    if (claim.requestedBy && claim.requestedBy === user.username)
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'The authorizer must differ from the claim requester (segregation of duties)', messageTh: 'ผู้อนุมัติต้องไม่ใช่ผู้ยื่นเคลม (แบ่งแยกหน้าที่)' });
    const disposition = dto.disposition ?? 'repair';
    if (!['repair', 'replace'].includes(disposition))
      throw new BadRequestException({ code: 'BAD_DISPOSITION', message: 'disposition must be repair or replace to authorize', messageTh: 'การจัดการต้องเป็น repair หรือ replace' });
    const charge = fx(Math.max(0, Number(dto.charge ?? 0)), 4);
    const [row] = await this.db.update(warrantyClaims)
      .set({ status: 'authorized', disposition, charge, authorizedBy: user.username, decidedAt: new Date() })
      .where(eq(warrantyClaims.id, id)).returning();
    return this.fmtClaim(row);
  }

  // Reject a pending claim. Also a distinct-user action (a requester cannot reject-close their own to hide it).
  async rejectClaim(id: number, dto: { reason?: string }, user: JwtUser) {
    const claim = await this.assertClaim(id, user);
    if (claim.status !== 'pending')
      throw new BadRequestException({ code: 'CLAIM_NOT_PENDING', message: `Claim ${claim.claimNo} is not pending (status=${claim.status})`, messageTh: `เคลม ${claim.claimNo} ไม่อยู่สถานะรออนุมัติ` });
    if (!dto.reason?.trim())
      throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A reject reason is required', messageTh: 'ต้องระบุเหตุผลการปฏิเสธ' });
    if (claim.requestedBy && claim.requestedBy === user.username)
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'The rejector must differ from the claim requester (segregation of duties)', messageTh: 'ผู้ปฏิเสธต้องไม่ใช่ผู้ยื่นเคลม (แบ่งแยกหน้าที่)' });
    const [row] = await this.db.update(warrantyClaims)
      .set({ status: 'closed', disposition: 'reject', rejectReason: dto.reason, authorizedBy: user.username, decidedAt: new Date() })
      .where(eq(warrantyClaims.id, id)).returning();
    return this.fmtClaim(row);
  }

  // ── Detective reads ────────────────────────────────────────────────────────
  // Units whose warranty_end falls within the next `days` days (renewal / proactive-service worklist).
  async expiring(days: number, user: JwtUser) {
    const d = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
    const today = ymd();
    const end = this.addDays(today, d);
    const rows = await this.db.select().from(installedBase)
      .where(and(
        eq(installedBase.tenantId, user.tenantId!),
        eq(installedBase.status, 'active'),
        gte(installedBase.warrantyEnd, today),
        lte(installedBase.warrantyEnd, end),
      )).orderBy(installedBase.warrantyEnd);
    return { as_of: today, horizon_days: d, units: rows.map((r: any) => this.fmtUnit(r)), count: rows.length };
  }

  // Override register: claims authorized FREE (charge 0) that were actually OUT of coverage — the SVC-01
  // exceptions an auditor samples (unauthorized free service/goods would surface here).
  async coverageExceptions(user: JwtUser) {
    const rows = await this.db.select().from(warrantyClaims)
      .where(and(
        eq(warrantyClaims.tenantId, user.tenantId!),
        eq(warrantyClaims.isInCoverage, false),
        eq(warrantyClaims.status, 'authorized'),
      )).orderBy(sql`${warrantyClaims.id} DESC`);
    const exceptions = rows.filter((r: any) => n(r.charge) === 0);
    return { exceptions: exceptions.map((c: any) => this.fmtClaim(c)), count: exceptions.length };
  }

  // ── Coverage logic + helpers ───────────────────────────────────────────────
  private isInCoverage(unit: typeof installedBase.$inferSelect, kind: Coverage, reportedDate: string): boolean {
    if (unit.status !== 'active') return false;
    const withinWindow = reportedDate <= unit.warrantyEnd && reportedDate >= unit.warrantyStart;
    const kindCovered = unit.coverageType === 'full' || unit.coverageType === kind;
    return withinWindow && kindCovered;
  }

  private assertCoverage(v: string): Coverage {
    if (!COVERAGE_TYPES.includes(v as Coverage))
      throw new BadRequestException({ code: 'BAD_COVERAGE_TYPE', message: `coverage must be one of ${COVERAGE_TYPES.join('/')}`, messageTh: 'ประเภทความคุ้มครองไม่ถูกต้อง' });
    return v as Coverage;
  }

  private addDays(ymdStr: string, days: number): string {
    const [y, m, d] = ymdStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
    return dt.toISOString().slice(0, 10);
  }

  private async nextClaimNo(tenantId: number) {
    const r = await this.db.insert(docCountersTenant)
      .values({ docType: 'WCL', tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `WCL-${String(Number(r[0]!.n)).padStart(5, '0')}`;
  }

  private async assertTerm(id: number, user: JwtUser) {
    const [t] = await this.db.select().from(warrantyTerms).where(and(eq(warrantyTerms.id, id), eq(warrantyTerms.tenantId, user.tenantId!))).limit(1);
    if (!t) throw new NotFoundException({ code: 'TERM_NOT_FOUND', message: `Warranty term ${id} not found`, messageTh: 'ไม่พบเงื่อนไขรับประกัน' });
    if (!t.active) throw new BadRequestException({ code: 'TERM_INACTIVE', message: `Warranty term ${t.termCode} is inactive`, messageTh: 'เงื่อนไขรับประกันถูกปิดใช้งาน' });
    return t;
  }

  private async assertUnit(id: number, user: JwtUser) {
    const [u] = await this.db.select().from(installedBase).where(and(eq(installedBase.id, id), eq(installedBase.tenantId, user.tenantId!))).limit(1);
    if (!u) throw new NotFoundException({ code: 'UNIT_NOT_FOUND', message: `Installed-base unit ${id} not found`, messageTh: 'ไม่พบเครื่องที่ลงทะเบียน' });
    return u;
  }

  private async assertClaim(id: number, user: JwtUser) {
    const [c] = await this.db.select().from(warrantyClaims).where(and(eq(warrantyClaims.id, id), eq(warrantyClaims.tenantId, user.tenantId!))).limit(1);
    if (!c) throw new NotFoundException({ code: 'CLAIM_NOT_FOUND', message: `Warranty claim ${id} not found`, messageTh: 'ไม่พบเคลม' });
    return c;
  }

  private fmtTerm(t: any) { return { id: Number(t.id), term_code: t.termCode, name: t.name, coverage_months: Number(t.coverageMonths), coverage_type: t.coverageType, active: t.active }; }
  private fmtUnit(u: any) { return { id: Number(u.id), serial_no: u.serialNo, item_code: u.itemCode, item_id: u.itemId != null ? Number(u.itemId) : null, customer_id: u.customerId != null ? Number(u.customerId) : null, customer_name: u.customerName, sold_date: u.soldDate, warranty_term_id: u.warrantyTermId != null ? Number(u.warrantyTermId) : null, warranty_start: u.warrantyStart, warranty_end: u.warrantyEnd, coverage_type: u.coverageType, status: u.status }; }
  private fmtClaim(c: any) { return { id: Number(c.id), claim_no: c.claimNo, installed_base_id: Number(c.installedBaseId), reported_date: c.reportedDate, fault: c.fault, coverage_kind: c.coverageKind, disposition: c.disposition, status: c.status, is_in_coverage: c.isInCoverage, charge: n(c.charge), requested_by: c.requestedBy, authorized_by: c.authorizedBy, reject_reason: c.rejectReason }; }
}
