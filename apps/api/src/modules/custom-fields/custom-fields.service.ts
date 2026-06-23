import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customFieldDefs, customFieldValues } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

const DATA_TYPES = ['text', 'number', 'date', 'boolean', 'select'] as const;
type DataType = typeof DATA_TYPES[number];
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Custom fields (UDFs). A tenant defines fields per entity (customer, item, …); values are stored typed and
// validated server-side against the definition. Values are metadata (no GL); mutations ride the audit log.
@Injectable()
export class CustomFieldsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── definitions ──
  async defineField(dto: { entity: string; field_key?: string; label: string; label_en?: string; data_type?: DataType; options?: string[]; required?: boolean; default_value?: string; help_text?: string; sort?: number; active?: boolean }, user: JwtUser) {
    const db = this.db as any;
    const entity = slug(dto.entity);
    if (!entity) throw new BadRequestException({ code: 'BAD_ENTITY', message: 'entity required', messageTh: 'ต้องระบุประเภทข้อมูล' });
    const dataType = dto.data_type ?? 'text';
    if (!DATA_TYPES.includes(dataType)) throw new BadRequestException({ code: 'BAD_TYPE', message: `data_type must be one of ${DATA_TYPES.join(', ')}`, messageTh: 'ชนิดข้อมูลไม่ถูกต้อง' });
    if (dataType === 'select' && (!dto.options || !dto.options.length)) throw new BadRequestException({ code: 'NO_OPTIONS', message: 'select fields need options', messageTh: 'ฟิลด์ตัวเลือกต้องมีรายการให้เลือก' });
    const fieldKey = slug(dto.field_key ?? dto.label);
    if (!fieldKey) throw new BadRequestException({ code: 'BAD_KEY', message: 'field_key/label required', messageTh: 'ต้องระบุชื่อฟิลด์' });
    const row = {
      tenantId: user.tenantId ?? null, entity, fieldKey, label: dto.label, labelEn: dto.label_en ?? null,
      dataType, options: dataType === 'select' ? dto.options : null, required: dto.required ?? false,
      defaultValue: dto.default_value ?? null, helpText: dto.help_text ?? null, sort: dto.sort ?? 0, active: dto.active ?? true,
    };
    const [existing] = await db.select().from(customFieldDefs).where(and(eq(customFieldDefs.tenantId, user.tenantId as any), eq(customFieldDefs.entity, entity), eq(customFieldDefs.fieldKey, fieldKey))).limit(1);
    if (existing) {
      await db.update(customFieldDefs).set(row).where(eq(customFieldDefs.id, existing.id));
      return { id: Number(existing.id), entity, field_key: fieldKey, data_type: dataType, updated: true };
    }
    const [d] = await db.insert(customFieldDefs).values({ ...row, createdBy: user.username }).returning({ id: customFieldDefs.id });
    return { id: Number(d.id), entity, field_key: fieldKey, data_type: dataType, updated: false };
  }

  async listDefs(entity: string | undefined, _user: JwtUser, includeInactive = false) {
    const db = this.db as any;
    let rows = entity
      ? await db.select().from(customFieldDefs).where(eq(customFieldDefs.entity, slug(entity)))
      : await db.select().from(customFieldDefs);
    rows = rows.filter((r: any) => includeInactive || r.active).sort((a: any, b: any) => a.sort - b.sort || a.id - b.id);
    return { fields: rows.map(this.shapeDef) };
  }

  async removeField(id: number, user: JwtUser) {
    const db = this.db as any;
    const upd = await db.update(customFieldDefs).set({ active: false }).where(and(eq(customFieldDefs.tenantId, user.tenantId as any), eq(customFieldDefs.id, id))).returning({ id: customFieldDefs.id });
    if (!upd.length) throw new NotFoundException({ code: 'FIELD_NOT_FOUND', message: 'Field not found', messageTh: 'ไม่พบฟิลด์' });
    return { id, active: false };
  }

  // ── values ──
  // Set values for one record. Validates each against its definition (type, required, select options) and
  // stores it in the typed column. Unknown keys (no active def) are rejected.
  async setValues(entity: string, recordId: string, values: Record<string, any>, user: JwtUser) {
    const db = this.db as any;
    const ent = slug(entity);
    if (!recordId) throw new BadRequestException({ code: 'NO_RECORD', message: 'record_id required', messageTh: 'ต้องระบุรหัสเรคคอร์ด' });
    const defs = (await db.select().from(customFieldDefs).where(and(eq(customFieldDefs.tenantId, user.tenantId as any), eq(customFieldDefs.entity, ent), eq(customFieldDefs.active, true))));
    const defByKey = new Map<string, any>(defs.map((d: any) => [d.fieldKey, d]));
    // required-field enforcement across the whole record
    for (const d of defs) {
      if (d.required) {
        const provided = values[d.fieldKey];
        if (provided === undefined || provided === null || provided === '') throw new BadRequestException({ code: 'REQUIRED_FIELD', message: `${d.label} is required`, messageTh: `ต้องระบุ ${d.label}` });
      }
    }
    const out: Record<string, any> = {};
    for (const [key, raw] of Object.entries(values)) {
      const def = defByKey.get(slug(key));
      if (!def) throw new BadRequestException({ code: 'UNKNOWN_FIELD', message: `No custom field '${key}' on ${ent}`, messageTh: `ไม่พบฟิลด์ '${key}'` });
      const typed = this.coerce(def, raw);
      await this.upsertValue(user, ent, def.fieldKey, recordId, typed);
      out[def.fieldKey] = typed.display;
    }
    return { entity: ent, record_id: recordId, values: out };
  }

  async getValues(entity: string, recordId: string, _user: JwtUser) {
    const db = this.db as any;
    const ent = slug(entity);
    const defs = await db.select().from(customFieldDefs).where(and(eq(customFieldDefs.entity, ent), eq(customFieldDefs.active, true)));
    const vals = await db.select().from(customFieldValues).where(and(eq(customFieldValues.entity, ent), eq(customFieldValues.recordId, recordId)));
    const valByKey = new Map<string, any>(vals.map((v: any) => [v.fieldKey, v]));
    const fields = defs.sort((a: any, b: any) => a.sort - b.sort || a.id - b.id).map((d: any) => ({
      ...this.shapeDef(d),
      value: valByKey.has(d.fieldKey) ? this.readValue(d, valByKey.get(d.fieldKey)) : (d.defaultValue != null ? this.coerce(d, d.defaultValue).display : null),
    }));
    return { entity: ent, record_id: recordId, fields };
  }

  // Batch-load values for many records of one entity (for list views) → { recordId: { fieldKey: value } }.
  async getValuesBulk(entity: string, recordIds: string[], _user: JwtUser) {
    const db = this.db as any;
    const ent = slug(entity);
    if (!recordIds.length) return { entity: ent, records: {} };
    const defs = await db.select().from(customFieldDefs).where(and(eq(customFieldDefs.entity, ent), eq(customFieldDefs.active, true)));
    const defByKey = new Map<string, any>(defs.map((d: any) => [d.fieldKey, d]));
    const vals = await db.select().from(customFieldValues).where(and(eq(customFieldValues.entity, ent), inArray(customFieldValues.recordId, recordIds)));
    const records: Record<string, Record<string, any>> = {};
    for (const v of vals) {
      const def = defByKey.get(v.fieldKey); if (!def) continue;
      (records[v.recordId] ??= {})[v.fieldKey] = this.readValue(def, v);
    }
    return { entity: ent, records };
  }

  // ── helpers ──
  private async upsertValue(user: JwtUser, entity: string, fieldKey: string, recordId: string, typed: { valueText: any; valueNum: any; valueDate: any; valueBool: any }) {
    const db = this.db as any;
    const [existing] = await db.select({ id: customFieldValues.id }).from(customFieldValues).where(and(eq(customFieldValues.tenantId, user.tenantId as any), eq(customFieldValues.entity, entity), eq(customFieldValues.fieldKey, fieldKey), eq(customFieldValues.recordId, recordId))).limit(1);
    const cols = { valueText: typed.valueText, valueNum: typed.valueNum, valueDate: typed.valueDate, valueBool: typed.valueBool, updatedBy: user.username, updatedAt: new Date() };
    if (existing) await db.update(customFieldValues).set(cols).where(eq(customFieldValues.id, existing.id));
    else await db.insert(customFieldValues).values({ tenantId: user.tenantId ?? null, entity, fieldKey, recordId, ...cols });
  }

  // coerce a raw input into the typed columns + a display value, validating per data_type
  private coerce(def: any, raw: any): { valueText: string | null; valueNum: string | null; valueDate: string | null; valueBool: boolean | null; display: any } {
    const empty = { valueText: null, valueNum: null, valueDate: null, valueBool: null, display: null };
    if (raw === undefined || raw === null || raw === '') return empty;
    switch (def.dataType as DataType) {
      case 'number': {
        const num = Number(raw);
        if (!Number.isFinite(num)) throw new BadRequestException({ code: 'BAD_NUMBER', message: `${def.label} must be a number`, messageTh: `${def.label} ต้องเป็นตัวเลข` });
        return { ...empty, valueNum: String(num), display: num };
      }
      case 'boolean': {
        const b = raw === true || raw === 'true' || raw === 1 || raw === '1';
        return { ...empty, valueBool: b, display: b };
      }
      case 'date': {
        const s = String(raw);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new BadRequestException({ code: 'BAD_DATE', message: `${def.label} must be YYYY-MM-DD`, messageTh: `${def.label} ต้องเป็นวันที่ (YYYY-MM-DD)` });
        return { ...empty, valueDate: s, display: s };
      }
      case 'select': {
        const s = String(raw);
        const opts: string[] = Array.isArray(def.options) ? def.options : [];
        if (!opts.includes(s)) throw new BadRequestException({ code: 'BAD_OPTION', message: `${def.label}: '${s}' is not an allowed option`, messageTh: `${def.label}: ค่าที่เลือกไม่ถูกต้อง` });
        return { ...empty, valueText: s, display: s };
      }
      default: {
        const s = String(raw);
        return { ...empty, valueText: s, display: s };
      }
    }
  }

  private readValue(def: any, v: any) {
    switch (def.dataType as DataType) {
      case 'number': return v.valueNum != null ? Number(v.valueNum) : null;
      case 'boolean': return v.valueBool ?? null;
      case 'date': return v.valueDate ?? null;
      default: return v.valueText ?? null;
    }
  }

  private shapeDef = (d: any) => ({
    id: Number(d.id), entity: d.entity, field_key: d.fieldKey, label: d.label, label_en: d.labelEn,
    data_type: d.dataType, options: d.options ?? null, required: d.required, default_value: d.defaultValue,
    help_text: d.helpText, sort: d.sort, active: d.active,
  });
}
