import { NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, ne, isNull, desc, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { apDiscountTerms, vendors } from '../../database/schema';
import type { StatusLogService } from '../../common/status-log.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import type { DiscountTermDto } from './ap-payment-run.service';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// Early-payment discount POLICY register (FIN-9 / EXP-14) — a PLAIN class built in the
// ApPaymentRunService ctor body (not a DI provider; the god-service ratchet pattern), extracted from the
// run facade. A sliding-scale prompt-payment discount schedule, per-vendor or global (vendor_id NULL):
// created Draft by a 'creditors' maker; activated by a DIFFERENT approvals/gl_close checker
// (self-approval → SOD_VIOLATION); approving one supersedes the prior Active policy for the same vendor
// scope so at most one Active policy governs a vendor at a time. Policy RESOLUTION at propose/execute time
// (resolveDiscountPolicy/computeDiscount) stays on the run service — this file owns only the register.
export class ApDiscountTermsService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly statusLog: StatusLogService,
  ) {}

  async createDiscountTerm(dto: DiscountTermDto, user: JwtUser) {
    const tenantId = user.tenantId ?? null;
    const pct = round4(dto.discount_pct);
    if (!(pct > 0 && pct <= 0.30)) throw new BadRequestException({ code: 'INVALID_DISCOUNT_PCT', message: 'discount_pct must be between 0 and 0.30', messageTh: 'อัตราส่วนลดต้องอยู่ระหว่าง 0 ถึง 0.30' });
    const minDays = Math.max(1, Math.floor(Number(dto.min_days_early ?? 1)));
    const fullDays = Math.max(minDays, Math.floor(Number(dto.full_discount_days ?? 20)));
    if (dto.vendor_id != null) {
      const [v] = await this.db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, Number(dto.vendor_id))).limit(1);
      if (!v) throw new NotFoundException({ code: 'VENDOR_NOT_FOUND', message: 'Vendor not found', messageTh: 'ไม่พบผู้ขาย' });
    }
    const [row] = await this.db.insert(apDiscountTerms).values({
      tenantId, vendorId: dto.vendor_id != null ? Number(dto.vendor_id) : null, name: dto.name,
      discountPct: String(pct), minDaysEarly: minDays, fullDiscountDays: fullDays,
      prorate: dto.prorate ?? true, discountAccount: dto.discount_account ?? '4600',
      activeFrom: dto.active_from ?? null, activeTo: dto.active_to ?? null, status: 'Draft', createdBy: user.username,
    }).returning({ id: apDiscountTerms.id });
    await this.statusLog.log('APDISC', String(row!.id), '', 'Draft', user.username, `Discount policy '${dto.name}' ${pct * 100}%`);
    return this.getDiscountTerm(Number(row!.id));
  }

  async approveDiscountTerm(id: number, approver: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [t] = await db.select().from(apDiscountTerms).where(eq(apDiscountTerms.id, Number(id))).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Discount policy not found', messageTh: 'ไม่พบนโยบายส่วนลด' });
    if (t.status !== 'Draft') throw new BadRequestException({ code: 'NOT_DRAFT', message: `Policy ${id} is ${t.status}, not pending activation`, messageTh: 'นโยบายนี้ไม่ได้อยู่ในสถานะร่าง' });
    await assertMakerChecker(db, { user: approver, maker: t.createdBy, event: 'ap.discount-term.approve', ref: String(id), reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot activate a discount policy you created', messageTh: 'ผู้จัดทำนโยบายส่วนลดอนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)' });
    // Supersede the prior Active policy for the SAME vendor scope so only one Active policy governs a vendor.
    const scope = t.vendorId != null ? eq(apDiscountTerms.vendorId, Number(t.vendorId)) : isNull(apDiscountTerms.vendorId);
    const scopeConds: SQL[] = [eq(apDiscountTerms.status, 'Active'), scope, ne(apDiscountTerms.id, Number(id))];
    if (t.tenantId != null) scopeConds.push(eq(apDiscountTerms.tenantId, Number(t.tenantId)));
    await db.update(apDiscountTerms).set({ status: 'Inactive' }).where(and(...scopeConds));
    await db.update(apDiscountTerms).set({ status: 'Active', approvedBy: approver.username, approvedAt: new Date() }).where(eq(apDiscountTerms.id, Number(id)));
    await this.statusLog.log('APDISC', String(id), 'Draft', 'Active', approver.username);
    return this.getDiscountTerm(Number(id));
  }

  async rejectDiscountTerm(id: number, approver: JwtUser, reason?: string) {
    const [t] = await this.db.select().from(apDiscountTerms).where(eq(apDiscountTerms.id, Number(id))).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Discount policy not found', messageTh: 'ไม่พบนโยบายส่วนลด' });
    if (t.status !== 'Draft') throw new BadRequestException({ code: 'NOT_DRAFT', message: `Policy ${id} is ${t.status}, not pending activation`, messageTh: 'นโยบายนี้ไม่ได้อยู่ในสถานะร่าง' });
    await this.db.update(apDiscountTerms).set({ status: 'Rejected', approvedBy: approver.username, approvedAt: new Date(), rejectReason: reason ?? null }).where(eq(apDiscountTerms.id, Number(id)));
    await this.statusLog.log('APDISC', String(id), 'Draft', 'Rejected', approver.username, reason);
    return this.getDiscountTerm(Number(id));
  }

  async deactivateDiscountTerm(id: number, user: JwtUser) {
    const [t] = await this.db.select().from(apDiscountTerms).where(eq(apDiscountTerms.id, Number(id))).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Discount policy not found', messageTh: 'ไม่พบนโยบายส่วนลด' });
    if (t.status !== 'Active') throw new BadRequestException({ code: 'NOT_ACTIVE', message: `Policy ${id} is ${t.status}, not active`, messageTh: 'นโยบายนี้ไม่ได้เปิดใช้งานอยู่' });
    await this.db.update(apDiscountTerms).set({ status: 'Inactive' }).where(eq(apDiscountTerms.id, Number(id)));
    await this.statusLog.log('APDISC', String(id), 'Active', 'Inactive', user.username);
    return this.getDiscountTerm(Number(id));
  }

  async getDiscountTerm(id: number) {
    const [t] = await this.db.select().from(apDiscountTerms).where(eq(apDiscountTerms.id, Number(id))).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Discount policy not found', messageTh: 'ไม่พบนโยบายส่วนลด' });
    return shapeDiscountTerm(t);
  }

  async listDiscountTerms(user: JwtUser, status?: string) {
    const conds: SQL[] = [];
    if (user.tenantId != null) conds.push(eq(apDiscountTerms.tenantId, user.tenantId));
    if (status) conds.push(eq(apDiscountTerms.status, status));
    const rows = await this.db.select().from(apDiscountTerms).where(conds.length ? and(...conds) : undefined).orderBy(desc(apDiscountTerms.id)).limit(200);
    return { terms: rows.map(shapeDiscountTerm), count: rows.length };
  }
}

function shapeDiscountTerm(t: typeof apDiscountTerms.$inferSelect) {
  return {
    id: Number(t.id), vendor_id: t.vendorId != null ? Number(t.vendorId) : null, name: t.name,
    discount_pct: n(t.discountPct), min_days_early: Number(t.minDaysEarly ?? 1), full_discount_days: Number(t.fullDiscountDays ?? 20),
    prorate: !!t.prorate, discount_account: t.discountAccount, active_from: t.activeFrom, active_to: t.activeTo,
    status: t.status, created_by: t.createdBy, created_at: t.createdAt, approved_by: t.approvedBy, approved_at: t.approvedAt, reject_reason: t.rejectReason,
  };
}
