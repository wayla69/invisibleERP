import { BadRequestException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { invWriteoffRequests } from '../../database/schema';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import { round4, EPS } from './inventory-cost-layers';
import type { AdjustDto } from './inventory-ledger.service';

const bad = (code: string, message: string, messageTh: string) =>
  new BadRequestException({ code, message, messageTh });

// INV-07 write-off maker-checker sub-service — a PLAIN class built in the InventoryLedgerService ctor body
// (not a DI provider; the god-service ratchet pattern). A NEGATIVE adjustment (a write-off) never posts
// directly: it becomes a REQUEST (no JE, no layer consumption, no balance move) that a DIFFERENT user
// approves; only then does the real valued adjustment run — through the facade's applyAdjust port, so the
// GL/balance/layer mechanics stay in one place.
export class InventoryWriteoffService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly ports: {
      tenantOf: (user: JwtUser) => number;
      locFor: (tenantId: number, itemId: string, explicit?: string | null) => Promise<string>;
      balanceRow: (tenantId: number, itemId: string, locationId: string) => Promise<any>;
      applyAdjust: (dto: AdjustDto, user: JwtUser) => Promise<any>;
    },
  ) {}

  // INV-07: a write-off REQUEST — validates (incl. NEG_STOCK against current stock) and records the intent;
  // posts no JE, consumes no layer, moves no balance. One write-off may be pending per item/location.
  async requestWriteOff(dto: AdjustDto, delta: number, user: JwtUser) {
    const tenantId = this.ports.tenantOf(user);
    const db = this.db;
    const loc = await this.ports.locFor(tenantId, dto.item_id, dto.location_id);
    const cur = await this.ports.balanceRow(tenantId, dto.item_id, loc);
    const oldQty = n(cur?.onHandQty), avg = n(cur?.avgCost);
    if (round4(oldQty + delta) < -EPS) throw bad('NEG_STOCK', `Adjustment would drive ${dto.item_id} below zero (${round4(oldQty + delta)})`, 'การปรับทำให้สต๊อกติดลบ');
    const [pending] = await db.select().from(invWriteoffRequests).where(and(eq(invWriteoffRequests.tenantId, tenantId), eq(invWriteoffRequests.itemId, dto.item_id), eq(invWriteoffRequests.locationId, loc), eq(invWriteoffRequests.status, 'PendingApproval'))).limit(1);
    if (pending) throw bad('WRITEOFF_PENDING', `A write-off of ${dto.item_id} is already pending approval`, 'มีรายการตัดสต๊อกของรายการนี้รออนุมัติอยู่แล้ว');
    const estValue = round4(Math.abs(delta) * avg);
    const [row] = await db.insert(invWriteoffRequests).values({ tenantId, itemId: dto.item_id, locationId: loc, qtyDelta: String(delta), estValue: String(estValue), reason: dto.reason!, status: 'PendingApproval', requestedBy: user.username }).returning({ id: invWriteoffRequests.id });
    return { request_id: Number(row!.id), item_id: dto.item_id, location_id: loc, qty_delta: delta, estimated_value: -estValue, status: 'pending_approval' };
  }

  // INV-07: a DIFFERENT user approves → the real valued adjustment runs atomically against current state.
  async approveWriteOff(requestId: number, user: JwtUser, selfApprovalReason?: string | null) {
    const tenantId = this.ports.tenantOf(user); const db = this.db;
    const [req] = await db.select().from(invWriteoffRequests).where(and(eq(invWriteoffRequests.id, requestId), eq(invWriteoffRequests.tenantId, tenantId))).limit(1);
    if (!req || req.status !== 'PendingApproval') throw bad('NO_PENDING_WRITEOFF', `No write-off pending approval (#${requestId})`, 'ไม่พบรายการตัดสต๊อกที่รออนุมัติ');
    await assertMakerChecker(db, { user, maker: req.requestedBy, event: 'inv.writeoff.approve', ref: String(requestId), amount: n(req.estValue), reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a write-off you requested', messageTh: 'ผู้บันทึกอนุมัติรายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    const res = await this.ports.applyAdjust({ item_id: req.itemId, location_id: req.locationId, qty_delta: n(req.qtyDelta), reason: req.reason }, user);
    await db.update(invWriteoffRequests).set({ status: 'Posted', approvedBy: user.username, approvedAt: new Date(), moveNo: res.move_no, glEntryNo: res.gl_entry_no ?? null }).where(eq(invWriteoffRequests.id, requestId));
    return { ...res, request_id: requestId, status: 'Posted', approved_by: user.username, requested_by: req.requestedBy };
  }

  async rejectWriteOff(requestId: number, user: JwtUser, reason?: string) {
    const tenantId = this.ports.tenantOf(user);
    const db = this.db;
    const [req] = await db.select().from(invWriteoffRequests).where(and(eq(invWriteoffRequests.id, requestId), eq(invWriteoffRequests.tenantId, tenantId))).limit(1);
    if (!req || req.status !== 'PendingApproval') throw bad('NO_PENDING_WRITEOFF', `No write-off pending approval (#${requestId})`, 'ไม่พบรายการตัดสต๊อกที่รออนุมัติ');
    await db.update(invWriteoffRequests).set({ status: 'Rejected', reason: reason ? `${req.reason} [REJECTED: ${reason}]` : req.reason }).where(eq(invWriteoffRequests.id, requestId));
    return { request_id: requestId, status: 'Rejected', rejected_by: user.username };
  }

  // Write-off register: pending + history for the caller's tenant, with the outstanding-pending count.
  async listWriteOffs(user: JwtUser, status?: string) {
    const tenantId = this.ports.tenantOf(user);
    const conds: any[] = [eq(invWriteoffRequests.tenantId, tenantId)];
    if (status) conds.push(eq(invWriteoffRequests.status, status));
    const rows = await this.db.select().from(invWriteoffRequests).where(and(...conds)).orderBy(desc(invWriteoffRequests.id)).limit(200);
    const writeoffs = rows.map((r: any) => ({ request_id: Number(r.id), item_id: r.itemId, location_id: r.locationId, qty_delta: n(r.qtyDelta), est_value: n(r.estValue), reason: r.reason, status: r.status, requested_by: r.requestedBy, approved_by: r.approvedBy, move_no: r.moveNo, gl_entry_no: r.glEntryNo, created_at: r.createdAt }));
    return { writeoffs, count: writeoffs.length, pending: writeoffs.filter((r: any) => r.status === 'PendingApproval').length };
  }
}
