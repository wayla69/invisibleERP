import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { loyaltyReceiptSubmissions, posMembers } from '../../database/schema';
import { n } from '../../database/queries';
import { isUniqueViolation } from '../../common/db-error';
import { objectStoreConfigured, putObject, objectUrl } from '../../common/object-storage';
import type { JwtUser } from '../../common/decorators';
import { MemberService } from './member.service';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// LYL-17 — receipt-upload-for-points review queue. A member (self-service) submits a photo of a purchase
// made outside our POS; staff (crm_points_adjust) approve/reject. Approval grants points through the SAME
// earnInTx path POS checkout uses (member.service.ts) — this service never touches balances/ledger/GL
// itself, it only gates the transition and delegates.
@Injectable()
export class ReceiptSubmissionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly member: MemberService,
  ) {}

  // ── Member self-service: submit + list own submissions ──
  async submit(dto: { receipt_image: string; purchase_amount: number; store_name?: string; purchase_date?: string; note?: string }, user: JwtUser) {
    if (user.tenantId == null || user.memberId == null) throw new BadRequestException({ code: 'MEMBER_ONLY', message: 'Member login required', messageTh: 'ต้องเข้าสู่ระบบสมาชิก' });
    if (!dto.receipt_image?.startsWith('data:image/')) throw new BadRequestException({ code: 'BAD_IMAGE', message: 'receipt_image must be a data:image/* URL', messageTh: 'รูปใบเสร็จไม่ถูกต้อง' });
    if (dto.receipt_image.length > 3_000_000) throw new BadRequestException({ code: 'IMAGE_TOO_LARGE', message: 'Image too large (max ~2MB)', messageTh: 'รูปใหญ่เกินไป' });
    const amount = round2(dto.purchase_amount);
    if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'purchase_amount must be > 0', messageTh: 'ยอดซื้อต้องมากกว่าศูนย์' });
    const db = this.db;
    const cfg = await this.member.config();
    const claimedPreview = cfg.enabled ? Math.floor(amount * cfg.pointsPerBaht) : 0;
    // Offload the image bytes to object storage when configured, persisting only a compact `objstore:<key>`
    // reference (keeps the megabyte blob out of the frequently-queried submissions table). Falls back to the
    // inline data URL when storage is unset or the upload fails — no behaviour change for existing deploys.
    let stored = dto.receipt_image;
    if (objectStoreConfigured()) {
      const key = `receipts/${user.tenantId}/${user.memberId}/${randomUUID()}`;
      const ref = await putObject(key, dto.receipt_image);
      if (ref) stored = ref;
    }
    try {
      const [row] = await db.insert(loyaltyReceiptSubmissions).values({
        tenantId: user.tenantId, memberId: user.memberId, receiptImage: stored, purchaseAmount: String(amount),
        storeName: dto.store_name ?? null, purchaseDate: dto.purchase_date ?? null, note: dto.note ?? null,
        claimedPointsPreview: String(claimedPreview), status: 'Pending', createdBy: user.username,
      }).returning();
      return shape(row);
    } catch (e: any) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'DUPLICATE_RECEIPT', message: 'A receipt with this date and amount is already pending or approved', messageTh: 'มีใบเสร็จวันที่และยอดนี้อยู่ในระบบแล้ว' });
      throw e;
    }
  }

  async myList(user: JwtUser) {
    if (user.memberId == null) throw new BadRequestException({ code: 'MEMBER_ONLY', message: 'Member login required', messageTh: 'ต้องเข้าสู่ระบบสมาชิก' });
    const db = this.db;
    const rows = await db.select().from(loyaltyReceiptSubmissions).where(eq(loyaltyReceiptSubmissions.memberId, user.memberId)).orderBy(desc(loyaltyReceiptSubmissions.id));
    return { submissions: rows.map(shape), count: rows.length };
  }

  // ── Staff: review queue + approve/reject ──
  async queue(user: JwtUser, opts: { status?: string }) {
    const db = this.db;
    const conds: any[] = [];
    if (user.tenantId != null) conds.push(eq(loyaltyReceiptSubmissions.tenantId, user.tenantId));
    conds.push(eq(loyaltyReceiptSubmissions.status, opts.status ?? 'Pending'));
    const rows = await db.select().from(loyaltyReceiptSubmissions).where(and(...conds)).orderBy(desc(loyaltyReceiptSubmissions.id));
    return { submissions: rows.map(shape), count: rows.length };
  }

  private async pending(id: number, user: JwtUser) {
    const db = this.db;
    const conds = [eq(loyaltyReceiptSubmissions.id, id)];
    if (user.tenantId != null) conds.push(eq(loyaltyReceiptSubmissions.tenantId, user.tenantId));
    const [row] = await db.select().from(loyaltyReceiptSubmissions).where(and(...conds)).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Receipt submission not found', messageTh: 'ไม่พบรายการใบเสร็จ' });
    if (row.status !== 'Pending') throw new ConflictException({ code: 'RECEIPT_ALREADY_REVIEWED', message: `Already ${row.status}`, messageTh: 'รายการนี้ถูกตรวจสอบแล้ว' });
    return row;
  }

  async approve(id: number, user: JwtUser) {
    const db = this.db;
    const row = await this.pending(id, user);
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, Number(row.memberId))).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const tenantId = Number(row.tenantId ?? m.tenantId);
    const refDoc = `RCT-${id}`;
    const pointsGranted = await db.transaction(async (tx: any) => {
      const pts = await this.member.earnInTx(tx, tenantId, Number(row.memberId), n(row.purchaseAmount), refDoc, user.username);
      await tx.update(loyaltyReceiptSubmissions).set({ status: 'Approved', reviewedBy: user.username, reviewedAt: new Date(), refDoc }).where(eq(loyaltyReceiptSubmissions.id, id));
      return pts;
    });
    return { id, status: 'Approved', points_granted: pointsGranted, ref_doc: refDoc, reviewed_by: user.username };
  }

  async reject(id: number, user: JwtUser, reason?: string) {
    const db = this.db;
    await this.pending(id, user);
    await db.update(loyaltyReceiptSubmissions).set({ status: 'Rejected', reviewedBy: user.username, reviewedAt: new Date(), rejectReason: reason ?? null }).where(eq(loyaltyReceiptSubmissions.id, id));
    return { id, status: 'Rejected', reject_reason: reason ?? null, reviewed_by: user.username };
  }
}

function shape(r: any) {
  return {
    // Resolve an `objstore:<key>` reference to a retrievable URL; inline data URLs pass through unchanged.
    id: Number(r.id), member_id: Number(r.memberId), receipt_image: objectUrl(r.receiptImage), purchase_amount: n(r.purchaseAmount),
    store_name: r.storeName, purchase_date: r.purchaseDate, note: r.note, claimed_points_preview: n(r.claimedPointsPreview),
    status: r.status, submitted_at: r.submittedAt, reviewed_by: r.reviewedBy, reviewed_at: r.reviewedAt,
    reject_reason: r.rejectReason, ref_doc: r.refDoc,
  };
}
