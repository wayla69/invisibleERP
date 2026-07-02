import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, desc, isNull, or } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { docAttachments, purchaseOrders, purchaseRequests } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

export interface AddAttachmentDto { doc_type: string; doc_no: string; data_url: string; kind?: string; filename?: string; note?: string; source?: string }

const KINDS = ['invoice', 'receipt', 'other'] as const;
const MAX_DATA_URL = 3_000_000; // ~2MB binary — mirrors the item_images cap

// Document evidence attachments (0228): invoice/receipt photos pinned to a PO (doc_type extensible to
// PR/GR/AP later). In-DB data-URLs, tenant-scoped (RLS + explicit tenant column). Deleting evidence is
// restricted to the uploader or Admin — attachments back the 3-way match (EXP-01 documentation).
@Injectable()
export class AttachmentsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Public so the LINE chat `attach` command can validate the target BEFORE asking the user for a photo.
  async assertDocExists(docType: string, docNo: string) {
    const db = this.db;
    if (docType === 'PO') {
      const [po] = await db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.poNo, docNo)).limit(1);
      if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบ PO' });
    } else if (docType === 'PR') {
      const [pr] = await db.select({ id: purchaseRequests.id }).from(purchaseRequests).where(eq(purchaseRequests.prNo, docNo)).limit(1);
      if (!pr) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PR not found', messageTh: 'ไม่พบ PR' });
    } else {
      throw new BadRequestException({ code: 'BAD_DOC_TYPE', message: `Unsupported doc_type: ${docType}`, messageTh: 'ประเภทเอกสารไม่รองรับ' });
    }
  }

  async add(dto: AddAttachmentDto, user: JwtUser) {
    if (!dto.data_url?.startsWith('data:image/') && !dto.data_url?.startsWith('data:application/pdf')) {
      throw new BadRequestException({ code: 'BAD_IMAGE', message: 'data_url must be a data:image/* or data:application/pdf URL', messageTh: 'ไฟล์ไม่ถูกต้อง (รองรับรูปภาพ/PDF)' });
    }
    if (dto.data_url.length > MAX_DATA_URL) throw new BadRequestException({ code: 'IMAGE_TOO_LARGE', message: 'File too large (max ~2MB)', messageTh: 'ไฟล์ใหญ่เกินไป (สูงสุด ~2MB)' });
    const kind = dto.kind ?? 'invoice';
    if (!KINDS.includes(kind as any)) throw new BadRequestException({ code: 'BAD_KIND', message: `kind must be one of ${KINDS.join('/')}`, messageTh: 'ชนิดเอกสารไม่ถูกต้อง' });
    const docNo = dto.doc_no.toUpperCase();
    const docType = dto.doc_type.toUpperCase();
    await this.assertDocExists(docType, docNo);
    const [row] = await this.db.insert(docAttachments).values({
      tenantId: user.tenantId ?? null, docType, docNo, kind,
      filename: dto.filename ?? null, dataUrl: dto.data_url, note: dto.note ?? null,
      source: dto.source === 'line' ? 'line' : 'web', createdBy: user.username,
    }).returning({ id: docAttachments.id });
    const count = await this.count(docType, docNo, user);
    return { id: Number(row!.id), doc_type: docType, doc_no: docNo, kind, count };
  }

  private tenantCond(user: JwtUser) {
    // caller's tenant rows plus legacy NULL-tenant rows; HQ (null tenant) sees everything via RLS bypass
    return user.tenantId != null ? or(eq(docAttachments.tenantId, user.tenantId), isNull(docAttachments.tenantId))! : undefined;
  }

  async count(docType: string, docNo: string, user: JwtUser): Promise<number> {
    const conds = [eq(docAttachments.docType, docType), eq(docAttachments.docNo, docNo)];
    const t = this.tenantCond(user);
    if (t) conds.push(t);
    const rows = await this.db.select({ id: docAttachments.id }).from(docAttachments).where(and(...conds));
    return rows.length;
  }

  // List metadata only (no data_url payloads — a PO with several photos would be megabytes).
  async list(docType: string, docNo: string, user: JwtUser) {
    const conds = [eq(docAttachments.docType, docType.toUpperCase()), eq(docAttachments.docNo, docNo.toUpperCase())];
    const t = this.tenantCond(user);
    if (t) conds.push(t);
    const rows = await this.db.select({
      id: docAttachments.id, kind: docAttachments.kind, filename: docAttachments.filename, note: docAttachments.note,
      source: docAttachments.source, createdBy: docAttachments.createdBy, createdAt: docAttachments.createdAt,
    }).from(docAttachments).where(and(...conds)).orderBy(desc(docAttachments.id));
    return { doc_type: docType.toUpperCase(), doc_no: docNo.toUpperCase(), attachments: rows.map((r: any) => ({ id: Number(r.id), kind: r.kind, filename: r.filename, note: r.note, source: r.source, created_by: r.createdBy, created_at: r.createdAt })), count: rows.length };
  }

  async get(id: number, user: JwtUser) {
    const conds = [eq(docAttachments.id, id)];
    const t = this.tenantCond(user);
    if (t) conds.push(t);
    const [r] = await this.db.select().from(docAttachments).where(and(...conds)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Attachment not found', messageTh: 'ไม่พบไฟล์แนบ' });
    return { id: Number(r.id), doc_type: r.docType, doc_no: r.docNo, kind: r.kind, filename: r.filename, note: r.note, source: r.source, data_url: r.dataUrl, created_by: r.createdBy, created_at: r.createdAt };
  }

  // Evidence integrity: only the uploader or Admin may remove an attachment.
  async remove(id: number, user: JwtUser) {
    const conds = [eq(docAttachments.id, id)];
    const t = this.tenantCond(user);
    if (t) conds.push(t);
    const [r] = await this.db.select({ id: docAttachments.id, createdBy: docAttachments.createdBy }).from(docAttachments).where(and(...conds)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Attachment not found', messageTh: 'ไม่พบไฟล์แนบ' });
    if (r.createdBy !== user.username && user.role !== 'Admin') {
      throw new ForbiddenException({ code: 'NOT_UPLOADER', message: 'Only the uploader or Admin can delete an attachment', messageTh: 'ลบได้เฉพาะผู้แนบหรือผู้ดูแล' });
    }
    await this.db.delete(docAttachments).where(eq(docAttachments.id, id));
    return { id, deleted: true };
  }
}
