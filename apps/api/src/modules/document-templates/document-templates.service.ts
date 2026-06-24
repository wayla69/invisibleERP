import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { documentTemplates, tenants } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { buildSampleReceiptData, renderReceiptHtml, normalizeReceiptTemplate, type ReceiptData } from '../printing/receipt-render';

// Catalog of customizable document types. `receipt` is wired to the live render (Platform Phase 10 — A3);
// the rest can be authored + stored now and are rendered as the wiring lands in later increments.
const DOC_TYPES = [
  { key: 'receipt', label_th: 'ใบเสร็จรับเงิน', label_en: 'Sales receipt', status: 'live' },
  { key: 'tax_invoice_abbreviated', label_th: 'ใบกำกับภาษีอย่างย่อ', label_en: 'Abbreviated tax invoice', status: 'planned' },
  { key: 'tax_invoice_full', label_th: 'ใบกำกับภาษีเต็มรูป', label_en: 'Full tax invoice', status: 'planned' },
  { key: 'quotation', label_th: 'ใบเสนอราคา', label_en: 'Quotation', status: 'planned' },
  { key: 'purchase_order', label_th: 'ใบสั่งซื้อ', label_en: 'Purchase order', status: 'planned' },
  { key: 'payslip', label_th: 'สลิปเงินเดือน', label_en: 'Payslip', status: 'planned' },
] as const;
const DOC_TYPE_KEYS = DOC_TYPES.map((d) => d.key) as readonly string[];

// Document templates (Platform Phase 10 — A3). A tenant authors no-code, presentation-only templates for
// customer-facing documents. Templates carry NO amounts and post NOTHING to the ledger; one per (tenant,
// doc_type) is the active default consumed at render time. RLS isolates every row to the caller's tenant.
@Injectable()
export class DocumentTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  docTypes() {
    return { doc_types: DOC_TYPES.map((d) => ({ ...d })) };
  }

  private assertDocType(docType: string) {
    if (!DOC_TYPE_KEYS.includes(docType)) {
      throw new BadRequestException({ code: 'BAD_DOC_TYPE', message: `Unknown doc_type '${docType}'`, messageTh: 'ประเภทเอกสารไม่ถูกต้อง' });
    }
  }

  // Normalize a config blob per doc_type. Receipt gets the full typed/clamped shape; others are stored as a
  // plain object placeholder until their render wiring lands.
  private normalize(docType: string, config: any) {
    if (docType === 'receipt') return normalizeReceiptTemplate(config);
    return config && typeof config === 'object' ? config : {};
  }

  private shape = (r: any) => ({
    id: Number(r.id), doc_type: r.docType, name: r.name, is_default: r.isDefault, active: r.active,
    config: r.config ?? {}, created_at: r.createdAt, updated_at: r.updatedAt,
  });

  async list(docType: string | undefined, _user: JwtUser) {
    const db = this.db as any;
    if (docType) this.assertDocType(docType);
    let rows = docType
      ? await db.select().from(documentTemplates).where(and(eq(documentTemplates.docType, docType), eq(documentTemplates.active, true)))
      : await db.select().from(documentTemplates).where(eq(documentTemplates.active, true));
    rows = rows.sort((a: any, b: any) => Number(b.isDefault) - Number(a.isDefault) || Number(b.id) - Number(a.id));
    return { templates: rows.map(this.shape) };
  }

  // The active config for a doc_type (default row → else most-recent active → else {}). Called at render time.
  // RLS already scopes the read to the caller's tenant. Returns the raw config; callers normalize per doc_type.
  async resolveActive(docType: string): Promise<any> {
    const db = this.db as any;
    const rows = await db.select().from(documentTemplates).where(and(eq(documentTemplates.docType, docType), eq(documentTemplates.active, true)));
    if (!rows.length) return {};
    const def = rows.find((r: any) => r.isDefault) ?? rows.sort((a: any, b: any) => Number(b.id) - Number(a.id))[0];
    return def?.config ?? {};
  }

  async create(dto: { doc_type: string; name: string; config?: any; is_default?: boolean }, user: JwtUser) {
    const db = this.db as any;
    this.assertDocType(dto.doc_type);
    const name = (dto.name ?? '').trim();
    if (!name) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'name required', messageTh: 'ต้องระบุชื่อเทมเพลต' });
    const [dup] = await db.select({ id: documentTemplates.id }).from(documentTemplates)
      .where(and(eq(documentTemplates.docType, dto.doc_type), eq(documentTemplates.name, name))).limit(1);
    if (dup) throw new BadRequestException({ code: 'NAME_EXISTS', message: 'A template with this name already exists', messageTh: 'มีเทมเพลตชื่อนี้อยู่แล้ว' });
    const existing = await db.select({ id: documentTemplates.id }).from(documentTemplates)
      .where(and(eq(documentTemplates.docType, dto.doc_type), eq(documentTemplates.active, true)));
    const makeDefault = dto.is_default === true || existing.length === 0; // first template for a type is the default
    if (makeDefault) await db.update(documentTemplates).set({ isDefault: false }).where(eq(documentTemplates.docType, dto.doc_type));
    const [row] = await db.insert(documentTemplates).values({
      tenantId: user.tenantId ?? null, docType: dto.doc_type, name, config: this.normalize(dto.doc_type, dto.config),
      isDefault: makeDefault, active: true, createdBy: user.username, updatedBy: user.username,
    }).returning({ id: documentTemplates.id });
    return { id: Number(row.id), doc_type: dto.doc_type, name, is_default: makeDefault };
  }

  async update(id: number, dto: { name?: string; config?: any }, user: JwtUser) {
    const db = this.db as any;
    const [row] = await db.select().from(documentTemplates).where(eq(documentTemplates.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Template not found', messageTh: 'ไม่พบเทมเพลต' });
    const patch: any = { updatedBy: user.username, updatedAt: new Date() };
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'name required', messageTh: 'ต้องระบุชื่อเทมเพลต' });
      patch.name = name;
    }
    if (dto.config !== undefined) patch.config = this.normalize(row.docType, dto.config);
    await db.update(documentTemplates).set(patch).where(eq(documentTemplates.id, id));
    return { id, updated: true };
  }

  async setDefault(id: number, _user: JwtUser) {
    const db = this.db as any;
    const [row] = await db.select().from(documentTemplates).where(eq(documentTemplates.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Template not found', messageTh: 'ไม่พบเทมเพลต' });
    await db.update(documentTemplates).set({ isDefault: false }).where(eq(documentTemplates.docType, row.docType));
    await db.update(documentTemplates).set({ isDefault: true, active: true }).where(eq(documentTemplates.id, id));
    return { id, doc_type: row.docType, is_default: true };
  }

  async remove(id: number, _user: JwtUser) {
    const db = this.db as any;
    const upd = await db.update(documentTemplates).set({ isDefault: false, active: false }).where(eq(documentTemplates.id, id)).returning({ id: documentTemplates.id });
    if (!upd.length) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Template not found', messageTh: 'ไม่พบเทมเพลต' });
    return { id, active: false };
  }

  // Live preview: render representative data through the posted config WITHOUT touching any real document.
  async preview(docType: string, config: any, user: JwtUser): Promise<{ doc_type: string; html: string }> {
    this.assertDocType(docType);
    if (docType !== 'receipt') {
      const dt = DOC_TYPES.find((d) => d.key === docType);
      const html = `<!doctype html><meta charset="utf-8"><div style="font-family:sans-serif;padding:24px;color:#475569;text-align:center">`
        + `<p style="font-size:14px"><b>${dt?.label_th ?? docType}</b> — ตัวอย่างยังไม่พร้อมในรุ่นนี้</p>`
        + `<p style="font-size:12px">Live preview for this document type is not available yet (the template is saved and will apply when its rendering lands).</p></div>`;
      return { doc_type: docType, html };
    }
    const db = this.db as any;
    let t: any = null;
    if (user.tenantId != null) [t] = await db.select().from(tenants).where(eq(tenants.id, Number(user.tenantId))).limit(1);
    const addr = t ? [t.addressLine1, t.addressLine2, t.subDistrict, t.district, t.province, t.postalCode].filter(Boolean).join(' ') : '';
    const seller: ReceiptData['seller'] = {
      name: t?.name ?? 'ร้านตัวอย่าง', legal_name: t?.legalName ?? null, branch_label: t?.branchLabelTh ?? 'สำนักงานใหญ่',
      tax_id: t?.taxId ?? '0000000000000', address: addr || 'ที่อยู่ร้าน', vat_registered: !!t?.vatRegistered,
      logo_url: t?.logoUrl ?? null, tagline: t?.tagline ?? null, show_logo: (t?.brandingPrefs?.show_logo_on_receipt) !== false,
    };
    const sample = buildSampleReceiptData(seller, t?.defaultLanguage === 'en' ? 'en' : 'th');
    return { doc_type: docType, html: renderReceiptHtml(sample, normalizeReceiptTemplate(config)) };
  }
}
