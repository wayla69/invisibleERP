import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { orderClaims, orderLines, orders, grClaims } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface GrClaimDto { gr_no?: string; po_no?: string; vendor_id?: number; item_id?: string; item_description?: string; gr_qty?: number; claim_qty?: number; uom?: string; reason?: string }

// Sales claims (customer claims on order lines, via order_claims) + supplier GR/inbound claims (gr_claims).
@Injectable()
export class ClaimsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  // ── Sales claims ─────────────────────────────────────────────────────────
  async listSalesClaims(status?: string) {
    const db = this.db;
    const where = status ? eq(orderClaims.adminStatus, status as any) : undefined;
    const rows = await db
      .select({
        id: orderClaims.id, order_no: orders.orderNo, item_id: orderLines.itemId, item_description: orderLines.itemDescription,
        claimed_qty: orderClaims.claimedQty, reason: orderClaims.claimReason, image_key: orderClaims.claimImageKey,
        admin_status: orderClaims.adminStatus, reject_reason: orderClaims.rejectReason,
      })
      .from(orderClaims)
      .leftJoin(orderLines, eq(orderClaims.orderLineId, orderLines.id))
      .leftJoin(orders, eq(orderLines.orderId, orders.id))
      .where(where)
      .orderBy(desc(orderClaims.id));
    return { claims: rows.map((r: any) => ({ ...r, claimed_qty: n(r.claimed_qty) })), count: rows.length };
  }

  async decideSalesClaim(id: number, decision: 'approve' | 'reject', rejectReason: string | undefined, _user: JwtUser) {
    if (decision === 'reject' && !rejectReason?.trim()) {
      throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'Reject reason required', messageTh: 'ต้องระบุเหตุผลการปฏิเสธ' });
    }
    const db = this.db;
    const [c] = await db.select().from(orderClaims).where(eq(orderClaims.id, id)).limit(1);
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Claim not found', messageTh: 'ไม่พบรายการเคลม' });
    const adminStatus = decision === 'approve' ? 'Approved' : 'Rejected';
    await db.update(orderClaims).set({ adminStatus, rejectReason: decision === 'reject' ? rejectReason : null }).where(eq(orderClaims.id, id));
    return { id, admin_status: adminStatus };
  }

  // ── GR / supplier (inbound) claims ───────────────────────────────────────
  async createGrClaim(dto: GrClaimDto, _user: JwtUser) {
    const db = this.db;
    const claimNo = await this.docNo.nextDaily('GRC');
    await db.insert(grClaims).values({
      claimNo, claimDate: ymd(), grNo: dto.gr_no ?? null, poNo: dto.po_no ?? null, vendorId: dto.vendor_id ?? null,
      itemId: dto.item_id ?? null, itemDescription: dto.item_description ?? null,
      grQty: dto.gr_qty != null ? String(dto.gr_qty) : null, claimQty: dto.claim_qty != null ? String(dto.claim_qty) : null,
      uom: dto.uom ?? null, reason: dto.reason ?? null, status: 'Open',
    });
    return { claim_no: claimNo, status: 'Open' };
  }

  async listGrClaims(status?: string) {
    const db = this.db;
    const where = status ? eq(grClaims.status, status) : undefined;
    const rows = await db.select().from(grClaims).where(where).orderBy(desc(grClaims.id));
    return {
      claims: rows.map((r: any) => ({
        claim_no: r.claimNo, claim_date: r.claimDate, gr_no: r.grNo, po_no: r.poNo, vendor_id: r.vendorId, item_id: r.itemId, item_description: r.itemDescription,
        gr_qty: n(r.grQty), claim_qty: n(r.claimQty), uom: r.uom, reason: r.reason, status: r.status,
      })),
      count: rows.length,
    };
  }

  // Resolve/reject a GR claim. (gr_claims has no resolution column → resolution note appended to reason.)
  async resolveGrClaim(claimNo: string, status: 'Resolved' | 'Rejected', resolution: string | undefined, _user: JwtUser) {
    const db = this.db;
    const [c] = await db.select().from(grClaims).where(eq(grClaims.claimNo, claimNo)).limit(1);
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'GR claim not found', messageTh: 'ไม่พบเคลม' });
    const reason = resolution ? `${c.reason ? c.reason + ' | ' : ''}${status}: ${resolution}` : c.reason;
    await db.update(grClaims).set({ status, reason }).where(eq(grClaims.claimNo, claimNo));
    return { claim_no: claimNo, status };
  }
}
