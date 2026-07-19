import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { posHeldOrders, posOverrides, posDiscountSettings } from '../../../database/schema';
import { DocNumberService } from '../../../common/doc-number.service';
import { PosAuditService } from '../audit/pos-audit.service';
import { n } from '../../../database/queries';
import type { JwtUser } from '../../../common/decorators';
import { assertMakerChecker } from '../../../common/control-profile';

export interface HoldDto { label?: string; customer_name?: string; cart?: any }
export interface OverrideDto { action: string; sale_no?: string; reason_code?: string; reason?: string; amount?: number; approved_by?: string }
export interface DiscountSettingsDto { max_line_discount_pct?: number | null; max_bill_discount_pct?: number | null }
export interface AuthorizeDiscountDto { max_pct: number; reason?: string; cashier?: string }
export interface DiscountCaps { maxLinePct: number | null; maxBillPct: number | null }

// Park/recall held carts + manager-override audit. Cart is opaque JSON owned by the POS client.
@Injectable()
export class PosControlService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService, private readonly audit: PosAuditService) {}

  async hold(dto: HoldDto, user: JwtUser) {
    if (!dto.cart) throw new BadRequestException({ code: 'NO_CART', message: 'cart required', messageTh: 'ไม่มีตะกร้า' });
    const db = this.db;
    const holdNo = await this.docNo.nextDaily('HOLD');
    await db.insert(posHeldOrders).values({
      tenantId: user.tenantId ?? null, holdNo, label: dto.label ?? null, customerName: dto.customer_name ?? null,
      cart: dto.cart, status: 'Held', createdBy: user.username,
    });
    return { hold_no: holdNo, status: 'Held' };
  }

  async listHeld() {
    const db = this.db;
    const rows = await db.select().from(posHeldOrders).where(eq(posHeldOrders.status, 'Held')).orderBy(desc(posHeldOrders.id));
    return { held: rows.map((r: any) => ({ hold_no: r.holdNo, label: r.label, customer_name: r.customerName, created_by: r.createdBy, created_at: r.createdAt })), count: rows.length };
  }

  async recall(holdNo: string) {
    const db = this.db;
    const [h] = await db.select().from(posHeldOrders).where(eq(posHeldOrders.holdNo, holdNo)).limit(1);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Held order not found', messageTh: 'ไม่พบรายการที่พัก' });
    if (h.status !== 'Held') throw new BadRequestException({ code: 'NOT_HELD', message: `Order is ${h.status}`, messageTh: 'รายการนี้ถูกเรียกคืน/ยกเลิกแล้ว' });
    await db.update(posHeldOrders).set({ status: 'Recalled', recalledAt: new Date() }).where(eq(posHeldOrders.id, h.id));
    return { hold_no: holdNo, label: h.label, customer_name: h.customerName, cart: h.cart };
  }

  async discard(holdNo: string) {
    const db = this.db;
    await db.update(posHeldOrders).set({ status: 'Discarded' }).where(eq(posHeldOrders.holdNo, holdNo));
    return { hold_no: holdNo, status: 'Discarded' };
  }

  // Record (and thereby authorize) a manager override. Approver captured for the audit trail.
  async override(dto: OverrideDto, user: JwtUser) {
    const db = this.db;
    const overrideNo = await this.docNo.nextDaily('OVR');
    await db.insert(posOverrides).values({
      tenantId: user.tenantId ?? null, overrideNo, saleNo: dto.sale_no ?? null, action: dto.action,
      reasonCode: dto.reason_code ?? null, reason: dto.reason ?? null, amount: dto.amount != null ? String(dto.amount) : null,
      requestedBy: user.username, approvedBy: dto.approved_by ?? null,
    });
    // central, cross-module POS audit trail
    await this.audit.record({ action: dto.action, entity: 'sale', entityId: dto.sale_no, meta: { override_no: overrideNo, reason_code: dto.reason_code, reason: dto.reason, amount: dto.amount, approved_by: dto.approved_by } }, user);
    return { override_no: overrideNo, action: dto.action, approved_by: dto.approved_by ?? null };
  }

  async listOverrides(limit = 50) {
    const db = this.db;
    const rows = await db.select().from(posOverrides).orderBy(desc(posOverrides.id)).limit(limit);
    return {
      overrides: rows.map((r: any) => ({ override_no: r.overrideNo, sale_no: r.saleNo, action: r.action, reason_code: r.reasonCode, reason: r.reason, amount: r.amount != null ? n(r.amount) : null, authorized_pct: r.authorizedPct != null ? n(r.authorizedPct) : null, requested_by: r.requestedBy, approved_by: r.approvedBy, created_at: r.createdAt })),
      count: rows.length,
    };
  }

  // ── docs/52 Phase 4b — discount-authority policy + supervisor authorization ────────────────────────────
  // Per-tenant caps: both NULL = no cap (the till applies discounts freely — the pre-4b behaviour). A shop
  // opts into discount governance by setting a cap.
  async getDiscountSettings(tenantId?: number | null): Promise<DiscountCaps> {
    const db = this.db;
    const rows = tenantId != null
      ? await db.select().from(posDiscountSettings).where(eq(posDiscountSettings.tenantId, tenantId)).limit(1)
      : await db.select().from(posDiscountSettings).limit(1);
    const r: any = rows[0];
    return { maxLinePct: r?.maxLineDiscountPct != null ? n(r.maxLineDiscountPct) : null, maxBillPct: r?.maxBillDiscountPct != null ? n(r.maxBillDiscountPct) : null };
  }

  async setDiscountSettings(dto: DiscountSettingsDto, user: JwtUser) {
    const db = this.db;
    const norm = (v: number | null | undefined) => {
      if (v == null) return null;
      if (!(v >= 0 && v <= 100)) throw new BadRequestException({ code: 'BAD_DISCOUNT_CAP', message: 'A discount cap must be between 0 and 100', messageTh: 'เพดานส่วนลดต้องอยู่ระหว่าง 0 ถึง 100' });
      return String(v);
    };
    const vals = { maxLineDiscountPct: norm(dto.max_line_discount_pct), maxBillDiscountPct: norm(dto.max_bill_discount_pct), updatedBy: user.username, updatedAt: new Date() };
    const [existing] = await db.select({ id: posDiscountSettings.id }).from(posDiscountSettings).where(eq(posDiscountSettings.tenantId, user.tenantId ?? 0)).limit(1);
    if (existing) await db.update(posDiscountSettings).set(vals).where(eq(posDiscountSettings.id, existing.id));
    else await db.insert(posDiscountSettings).values({ tenantId: user.tenantId ?? null, ...vals });
    return { max_line_discount_pct: dto.max_line_discount_pct ?? null, max_bill_discount_pct: dto.max_bill_discount_pct ?? null };
  }

  // A SUPERVISOR (authenticated — the route is gated to the refund/override duty, segregated from selling)
  // authorizes an over-cap discount up to `max_pct`. Recorded as a single-use `discount` override with the
  // authorizer as `approved_by`; the cashier references its `override_no` on the sale (consumed there).
  async authorizeDiscount(dto: AuthorizeDiscountDto, user: JwtUser) {
    if (!(n(dto.max_pct) > 0 && n(dto.max_pct) <= 100)) throw new BadRequestException({ code: 'BAD_DISCOUNT_PCT', message: 'max_pct must be between 0 and 100', messageTh: 'เปอร์เซ็นต์ส่วนลดต้องอยู่ระหว่าง 0 ถึง 100' });
    const db = this.db;
    const overrideNo = await this.docNo.nextDaily('OVR');
    await db.insert(posOverrides).values({
      tenantId: user.tenantId ?? null, overrideNo, saleNo: null, action: 'discount',
      reason: dto.reason ?? null, authorizedPct: String(dto.max_pct), requestedBy: dto.cashier ?? null, approvedBy: user.username,
    });
    await this.audit.record({ action: 'discount_authorize', entity: 'sale', entityId: undefined, meta: { override_no: overrideNo, max_pct: dto.max_pct, cashier: dto.cashier, approved_by: user.username } }, user);
    return { override_no: overrideNo, action: 'discount', max_pct: n(dto.max_pct), approved_by: user.username };
  }

  // Validate + CONSUME a discount authorization inside the caller's sale transaction (so a rolled-back sale
  // doesn't burn the authorization). Fail-closed: the authorization must exist, be a `discount` override, be
  // approved by someone OTHER than the selling cashier (the canonical maker-checker gate — SoD R08), cover the
  // requested over-cap %, and be unconsumed — the guarded UPDATE (WHERE sale_no IS NULL) makes consumption
  // atomic against a concurrent sale. `user` is the selling cashier.
  async consumeDiscountApproval(tx: any, opts: { tenantId: number; user: JwtUser; overrideNo: string; requestedPct: number; saleNo: string }): Promise<void> {
    const [ov] = await tx.select().from(posOverrides).where(and(eq(posOverrides.tenantId, opts.tenantId), eq(posOverrides.overrideNo, opts.overrideNo))).limit(1);
    if (!ov) throw new BadRequestException({ code: 'DISCOUNT_APPROVAL_NOT_FOUND', message: `Discount authorization ${opts.overrideNo} not found`, messageTh: 'ไม่พบใบอนุมัติส่วนลด' });
    if (ov.action !== 'discount' || ov.authorizedPct == null || !ov.approvedBy)
      throw new BadRequestException({ code: 'DISCOUNT_APPROVAL_INVALID', message: `${opts.overrideNo} is not a valid discount authorization`, messageTh: 'ใบอนุมัติส่วนลดไม่ถูกต้อง' });
    // Maker-checker (SoD R08): the discount approver (ov.approvedBy) must differ from the selling cashier.
    await assertMakerChecker(tx, { user: opts.user, maker: ov.approvedBy, event: 'pos.discount.consume', ref: opts.overrideNo, code: 'SOD_VIOLATION', message: 'The discount approver must differ from the selling cashier', messageTh: 'ผู้อนุมัติส่วนลดต้องไม่ใช่แคชเชียร์ที่ขาย (แบ่งแยกหน้าที่)' });
    if (n(ov.authorizedPct) + 1e-6 < opts.requestedPct)
      throw new BadRequestException({ code: 'DISCOUNT_APPROVAL_INSUFFICIENT', message: `Authorization covers ${n(ov.authorizedPct)}% but the discount is ${opts.requestedPct.toFixed(2)}%`, messageTh: `ใบอนุมัติครอบคลุม ${n(ov.authorizedPct)}% แต่ส่วนลดคือ ${opts.requestedPct.toFixed(2)}%` });
    const claimed = await tx.update(posOverrides).set({ saleNo: opts.saleNo }).where(and(eq(posOverrides.id, ov.id), isNull(posOverrides.saleNo))).returning({ id: posOverrides.id });
    if (!claimed.length)
      throw new BadRequestException({ code: 'DISCOUNT_APPROVAL_CONSUMED', message: `Discount authorization ${opts.overrideNo} was already used`, messageTh: 'ใบอนุมัติส่วนลดนี้ถูกใช้ไปแล้ว' });
  }
}
