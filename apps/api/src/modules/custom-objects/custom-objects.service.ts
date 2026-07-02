import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customObjects, customObjectRecords } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';

// slugify: lowercase, non-alphanumerics → '_', trim '_' via a char loop (ReDoS-safe — no anchored regex).
const slug = (s: string) => {
  const r = (s ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
  let i = 0, j = r.length;
  while (i < j && r.charCodeAt(i) === 95) i++;
  while (j > i && r.charCodeAt(j - 1) === 95) j--;
  return r.slice(i, j);
};

// Custom objects (Phase 11 — A1). A tenant defines new record types with no code; each object's fields and
// typed values reuse the Phase 1 custom-fields store (entity = object_key). Records get their own registry
// (`custom_object_records`) so we can enumerate them. Pure metadata: RLS-scoped, audited, never hits the GL.
@Injectable()
export class CustomObjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly cf: CustomFieldsService,
  ) {}

  private shapeObj = (o: any) => ({ id: Number(o.id), object_key: o.objectKey, label: o.label, label_en: o.labelEn, icon: o.icon, active: o.active });

  private async findObject(key: string): Promise<any> {
    const db = this.db;
    const [o] = await db.select().from(customObjects).where(and(eq(customObjects.objectKey, key), eq(customObjects.active, true))).limit(1);
    if (!o) throw new NotFoundException({ code: 'OBJECT_NOT_FOUND', message: `No custom object '${key}'`, messageTh: 'ไม่พบออบเจ็กต์' });
    return o;
  }

  // first non-empty field value (defs are returned sorted) → a friendly label for list views.
  private displayFromFields(fields: any[]): string | null {
    for (const f of fields) if (f.value != null && f.value !== '') return String(f.value);
    return null;
  }

  // ── objects ──
  async defineObject(dto: { object_key?: string; label: string; label_en?: string; icon?: string }, user: JwtUser) {
    const db = this.db;
    const key = slug(dto.object_key ?? dto.label);
    if (!key) throw new BadRequestException({ code: 'BAD_OBJECT', message: 'object_key/label required', messageTh: 'ต้องระบุชื่อออบเจ็กต์' });
    const label = (dto.label ?? '').trim();
    if (!label) throw new BadRequestException({ code: 'BAD_LABEL', message: 'label required', messageTh: 'ต้องระบุชื่อที่แสดง' });
    const [dup] = await db.select({ id: customObjects.id }).from(customObjects).where(eq(customObjects.objectKey, key)).limit(1);
    if (dup) throw new BadRequestException({ code: 'OBJECT_EXISTS', message: `Object '${key}' already exists`, messageTh: 'มีออบเจ็กต์นี้อยู่แล้ว' });
    await db.insert(customObjects).values({ tenantId: user.tenantId ?? null, objectKey: key, label, labelEn: dto.label_en ?? null, icon: dto.icon ?? null, createdBy: user.username });
    return { object_key: key, label };
  }

  async listObjects(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(customObjects).where(eq(customObjects.active, true)).orderBy(desc(customObjects.id));
    return { objects: rows.map(this.shapeObj) };
  }

  async getObject(key: string, user: JwtUser) {
    const o = await this.findObject(slug(key));
    const fields = (await this.cf.listDefs(o.objectKey, user)).fields;
    return { object: this.shapeObj(o), fields };
  }

  async removeObject(key: string, user: JwtUser) {
    const db = this.db;
    const upd = await db.update(customObjects).set({ active: false }).where(and(eq(customObjects.objectKey, slug(key)), eq(customObjects.tenantId, user.tenantId as any))).returning({ id: customObjects.id });
    if (!upd.length) throw new NotFoundException({ code: 'OBJECT_NOT_FOUND', message: 'Object not found', messageTh: 'ไม่พบออบเจ็กต์' });
    return { object_key: slug(key), active: false };
  }

  // ── records ──
  async createRecord(key: string, values: Record<string, any>, user: JwtUser) {
    const db = this.db;
    const o = await this.findObject(slug(key));
    const [reg] = await db.insert(customObjectRecords).values({ tenantId: user.tenantId ?? null, objectKey: o.objectKey, recordId: '', createdBy: user.username, updatedBy: user.username }).returning({ id: customObjectRecords.id });
    const recordId = String(reg!.id);
    await this.cf.setValues(o.objectKey, recordId, values ?? {}, user); // validates types/required/options + stores
    const full = await this.cf.getValues(o.objectKey, recordId, user);
    const display = this.displayFromFields(full.fields);
    await db.update(customObjectRecords).set({ recordId, displayName: display }).where(eq(customObjectRecords.id, reg!.id));
    return { object_key: o.objectKey, record_id: recordId, display_name: display };
  }

  async listRecords(key: string, user: JwtUser) {
    const db = this.db;
    const o = await this.findObject(slug(key));
    const rows = await db.select().from(customObjectRecords).where(and(eq(customObjectRecords.objectKey, o.objectKey), eq(customObjectRecords.active, true))).orderBy(desc(customObjectRecords.id));
    const fields = (await this.cf.listDefs(o.objectKey, user)).fields;
    const bulk = await this.cf.getValuesBulk(o.objectKey, rows.map((r: any) => r.recordId), user);
    return {
      object_key: o.objectKey,
      fields,
      records: rows.map((r: any) => ({ record_id: r.recordId, display_name: r.displayName, values: bulk.records[r.recordId] ?? {}, created_at: r.createdAt, updated_at: r.updatedAt })),
    };
  }

  async getRecord(key: string, recordId: string, user: JwtUser) {
    const db = this.db;
    const o = await this.findObject(slug(key));
    const [reg] = await db.select().from(customObjectRecords).where(and(eq(customObjectRecords.objectKey, o.objectKey), eq(customObjectRecords.recordId, recordId), eq(customObjectRecords.active, true))).limit(1);
    if (!reg) throw new NotFoundException({ code: 'RECORD_NOT_FOUND', message: 'Record not found', messageTh: 'ไม่พบเรคคอร์ด' });
    const v = await this.cf.getValues(o.objectKey, recordId, user);
    return { object_key: o.objectKey, record_id: recordId, display_name: reg.displayName, fields: v.fields };
  }

  async updateRecord(key: string, recordId: string, values: Record<string, any>, user: JwtUser) {
    const db = this.db;
    const o = await this.findObject(slug(key));
    const [reg] = await db.select({ id: customObjectRecords.id }).from(customObjectRecords).where(and(eq(customObjectRecords.objectKey, o.objectKey), eq(customObjectRecords.recordId, recordId), eq(customObjectRecords.active, true))).limit(1);
    if (!reg) throw new NotFoundException({ code: 'RECORD_NOT_FOUND', message: 'Record not found', messageTh: 'ไม่พบเรคคอร์ด' });
    await this.cf.setValues(o.objectKey, recordId, values ?? {}, user);
    const full = await this.cf.getValues(o.objectKey, recordId, user);
    const display = this.displayFromFields(full.fields);
    await db.update(customObjectRecords).set({ displayName: display, updatedBy: user.username, updatedAt: new Date() }).where(eq(customObjectRecords.id, reg.id));
    return { object_key: o.objectKey, record_id: recordId, display_name: display, updated: true };
  }

  async removeRecord(key: string, recordId: string, user: JwtUser) {
    const db = this.db;
    const o = await this.findObject(slug(key));
    const upd = await db.update(customObjectRecords).set({ active: false, updatedBy: user.username, updatedAt: new Date() }).where(and(eq(customObjectRecords.objectKey, o.objectKey), eq(customObjectRecords.recordId, recordId))).returning({ id: customObjectRecords.id });
    if (!upd.length) throw new NotFoundException({ code: 'RECORD_NOT_FOUND', message: 'Record not found', messageTh: 'ไม่พบเรคคอร์ด' });
    return { object_key: o.objectKey, record_id: recordId, active: false };
  }
}
