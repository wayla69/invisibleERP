import { Inject, Injectable, BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { eq, and, desc, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { orderClaims, orderLines, orders, grClaims, goodsReceipts, receivingSettings, docAttachments } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface GrClaimDto { gr_no?: string; po_no?: string; vendor_id?: number; item_id?: string; item_description?: string; gr_qty?: number; claim_qty?: number; uom?: string; reason?: string; image_data_url?: string }

const MAX_CLAIM_IMAGE = 3_000_000; // ~2MB binary as a data-URL — mirrors doc_attachments' cap

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
    const where = status ? eq(orderClaims.adminStatus, status as NonNullable<typeof orderClaims.$inferSelect.adminStatus>) : undefined;
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
  // EXP-12 claim window: a claim tied to a GR must be opened within receiving_settings.claim_window_hours
  // (default 24) of the receipt — after that the window has auto-closed and the system refuses the claim
  // (CLAIM_WINDOW_CLOSED). Enforced against goods_receipts.created_at so a defect must be raised while the
  // delivery is still verifiable. An optional photo is stored as a GRC doc_attachment (evidence).
  async createGrClaim(dto: GrClaimDto, user: JwtUser) {
    const db = this.db;
    if (dto.image_data_url != null) {
      if (!dto.image_data_url.startsWith('data:image/')) throw new BadRequestException({ code: 'BAD_IMAGE', message: 'image_data_url must be a data:image/* URL', messageTh: 'ไฟล์รูปไม่ถูกต้อง' });
      if (dto.image_data_url.length > MAX_CLAIM_IMAGE) throw new BadRequestException({ code: 'IMAGE_TOO_LARGE', message: 'Image too large (max ~2MB)', messageTh: 'รูปใหญ่เกินไป (สูงสุด ~2MB)' });
    }
    if (dto.gr_no) {
      const [gr] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.grNo, dto.gr_no)).limit(1);
      if (!gr) throw new NotFoundException({ code: 'NOT_FOUND', message: 'GR not found', messageTh: 'ไม่พบใบรับสินค้า' });
      const windowHours = await this.claimWindowHours(user.tenantId ?? null);
      const receivedAt = gr.createdAt ? new Date(gr.createdAt) : (gr.grDate ? new Date(`${gr.grDate}T00:00:00+07:00`) : null);
      if (receivedAt && Date.now() - receivedAt.getTime() > windowHours * 3600_000) {
        throw new UnprocessableEntityException({
          code: 'CLAIM_WINDOW_CLOSED',
          message: `Claim window closed — claims must be opened within ${windowHours}h of the goods receipt`,
          messageTh: `เกินกำหนดแจ้งเคลม — ต้องแจ้งภายใน ${windowHours} ชั่วโมงหลังรับสินค้า (ระบบปิดรับเคลมอัตโนมัติ)`,
        });
      }
    }
    const claimNo = await this.docNo.nextDaily('GRC');
    let imageKey: string | null = null;
    if (dto.image_data_url) {
      const [att] = await db.insert(docAttachments).values({
        tenantId: user.tenantId ?? null, docType: 'GRC', docNo: claimNo, kind: 'other',
        filename: `${claimNo}.jpg`, dataUrl: dto.image_data_url, note: dto.reason ?? null, source: 'web', createdBy: user.username,
      }).returning({ id: docAttachments.id });
      imageKey = String(att!.id);
    }
    await db.insert(grClaims).values({
      claimNo, claimDate: ymd(), grNo: dto.gr_no ?? null, poNo: dto.po_no ?? null, vendorId: dto.vendor_id ?? null,
      itemId: dto.item_id ?? null, itemDescription: dto.item_description ?? null,
      grQty: dto.gr_qty != null ? String(dto.gr_qty) : null, claimQty: dto.claim_qty != null ? String(dto.claim_qty) : null,
      uom: dto.uom ?? null, reason: dto.reason ?? null, imageKey, status: 'Open',
    });
    return { claim_no: claimNo, status: 'Open', image_attachment_id: imageKey ? Number(imageKey) : null };
  }

  // Claim window (hours) from receiving_settings, defaulting to 24 — same tenant-scoped read discipline as
  // the receiving service (never RLS+limit(1); an Admin/HQ request bypasses RLS).
  private async claimWindowHours(tenantId: number | null): Promise<number> {
    const [s] = tenantId != null
      ? await this.db.select().from(receivingSettings).where(eq(receivingSettings.tenantId, tenantId)).limit(1)
      : await this.db.select().from(receivingSettings).where(isNull(receivingSettings.tenantId)).limit(1);
    return s ? Number(s.claimWindowHours) : 24;
  }

  async listGrClaims(status?: string) {
    const db = this.db;
    const where = status ? eq(grClaims.status, status) : undefined;
    const rows = await db.select().from(grClaims).where(where).orderBy(desc(grClaims.id));
    return {
      claims: rows.map((r: any) => ({
        claim_no: r.claimNo, claim_date: r.claimDate, gr_no: r.grNo, po_no: r.poNo, vendor_id: r.vendorId, item_id: r.itemId, item_description: r.itemDescription,
        gr_qty: n(r.grQty), claim_qty: n(r.claimQty), uom: r.uom, reason: r.reason, status: r.status,
        image_attachment_id: r.imageKey ? Number(r.imageKey) : null, created_at: r.createdAt ?? null,
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
