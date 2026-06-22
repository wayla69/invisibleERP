import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { posHeldOrders, posOverrides } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface HoldDto { label?: string; customer_name?: string; cart?: any }
export interface OverrideDto { action: string; sale_no?: string; reason_code?: string; reason?: string; amount?: number; approved_by?: string }

// Park/recall held carts + manager-override audit. Cart is opaque JSON owned by the POS client.
@Injectable()
export class PosControlService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService) {}

  async hold(dto: HoldDto, user: JwtUser) {
    if (!dto.cart) throw new BadRequestException({ code: 'NO_CART', message: 'cart required', messageTh: 'ไม่มีตะกร้า' });
    const db = this.db as any;
    const holdNo = await this.docNo.nextDaily('HOLD');
    await db.insert(posHeldOrders).values({
      tenantId: user.tenantId ?? null, holdNo, label: dto.label ?? null, customerName: dto.customer_name ?? null,
      cart: dto.cart, status: 'Held', createdBy: user.username,
    });
    return { hold_no: holdNo, status: 'Held' };
  }

  async listHeld() {
    const db = this.db as any;
    const rows = await db.select().from(posHeldOrders).where(eq(posHeldOrders.status, 'Held')).orderBy(desc(posHeldOrders.id));
    return { held: rows.map((r: any) => ({ hold_no: r.holdNo, label: r.label, customer_name: r.customerName, created_by: r.createdBy, created_at: r.createdAt })), count: rows.length };
  }

  async recall(holdNo: string) {
    const db = this.db as any;
    const [h] = await db.select().from(posHeldOrders).where(eq(posHeldOrders.holdNo, holdNo)).limit(1);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Held order not found', messageTh: 'ไม่พบรายการที่พัก' });
    if (h.status !== 'Held') throw new BadRequestException({ code: 'NOT_HELD', message: `Order is ${h.status}`, messageTh: 'รายการนี้ถูกเรียกคืน/ยกเลิกแล้ว' });
    await db.update(posHeldOrders).set({ status: 'Recalled', recalledAt: new Date() }).where(eq(posHeldOrders.id, h.id));
    return { hold_no: holdNo, label: h.label, customer_name: h.customerName, cart: h.cart };
  }

  async discard(holdNo: string) {
    const db = this.db as any;
    await db.update(posHeldOrders).set({ status: 'Discarded' }).where(eq(posHeldOrders.holdNo, holdNo));
    return { hold_no: holdNo, status: 'Discarded' };
  }

  // Record (and thereby authorize) a manager override. Approver captured for the audit trail.
  async override(dto: OverrideDto, user: JwtUser) {
    const db = this.db as any;
    const overrideNo = await this.docNo.nextDaily('OVR');
    await db.insert(posOverrides).values({
      tenantId: user.tenantId ?? null, overrideNo, saleNo: dto.sale_no ?? null, action: dto.action,
      reasonCode: dto.reason_code ?? null, reason: dto.reason ?? null, amount: dto.amount != null ? String(dto.amount) : null,
      requestedBy: user.username, approvedBy: dto.approved_by ?? null,
    });
    return { override_no: overrideNo, action: dto.action, approved_by: dto.approved_by ?? null };
  }

  async listOverrides(limit = 50) {
    const db = this.db as any;
    const rows = await db.select().from(posOverrides).orderBy(desc(posOverrides.id)).limit(limit);
    return {
      overrides: rows.map((r: any) => ({ override_no: r.overrideNo, sale_no: r.saleNo, action: r.action, reason_code: r.reasonCode, reason: r.reason, amount: r.amount != null ? n(r.amount) : null, requested_by: r.requestedBy, approved_by: r.approvedBy, created_at: r.createdAt })),
      count: rows.length,
    };
  }
}
