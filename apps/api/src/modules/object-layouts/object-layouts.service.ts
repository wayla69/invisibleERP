import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { objectLayouts } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';

type StoredLayout = { sections: { title: string; columns: 1 | 2; fields: string[] }[]; hidden: string[] };

// Object layouts (Phase 12 — A2). A no-code form/layout for a custom object: sections, field order, columns
// and hidden fields, optionally per role. The stored config is PRESENTATION only and is resolved against the
// object's CURRENT field defs (Phase 1 store) at render time, so newly-added fields always surface and stale
// references are dropped. RLS-scoped, audited, never posts to the GL.
@Injectable()
export class ObjectLayoutsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly cf: CustomFieldsService,
  ) {}

  // ── config normalization (storage) ──
  private normalizeStored(config: any): StoredLayout {
    const c = config && typeof config === 'object' ? config : {};
    const sections = Array.isArray(c.sections)
      ? c.sections.slice(0, 20).map((s: any) => ({
          title: typeof s?.title === 'string' ? s.title.slice(0, 80) : '',
          columns: s?.columns === 2 ? 2 : 1,
          fields: Array.isArray(s?.fields) ? s.fields.filter((k: any) => typeof k === 'string').slice(0, 100) : [],
        }))
      : [];
    const hidden = Array.isArray(c.hidden) ? c.hidden.filter((k: any) => typeof k === 'string').slice(0, 100) : [];
    return { sections, hidden };
  }

  // ── resolution (render time) ── build ordered sections from a config + the object's live field defs.
  private buildSections(defs: any[], cfg: StoredLayout | null) {
    const byKey = new Map<string, any>(defs.map((d) => [d.field_key, d]));
    if (!cfg || !Array.isArray(cfg.sections) || cfg.sections.length === 0) {
      return { sections: [{ title: 'ข้อมูล', columns: 1 as const, fields: defs }], hidden: [] as any[] };
    }
    const hiddenKeys = (cfg.hidden ?? []).filter((k) => byKey.has(k));
    const hiddenSet = new Set(hiddenKeys);
    const placed = new Set<string>();
    const sections = cfg.sections.map((s) => {
      const fk = (s.fields ?? []).filter((k) => byKey.has(k) && !hiddenSet.has(k));
      fk.forEach((k) => placed.add(k));
      return { title: s.title ?? '', columns: s.columns === 2 ? 2 : 1, fields: fk.map((k) => byKey.get(k)) };
    });
    // any active field not placed and not hidden (e.g. added after the layout was saved) → append so it's never lost
    const unplaced = defs.filter((d) => !placed.has(d.field_key) && !hiddenSet.has(d.field_key));
    if (unplaced.length) {
      if (sections.length) sections[sections.length - 1].fields.push(...unplaced);
      else sections.push({ title: 'ข้อมูล', columns: 1, fields: unplaced });
    }
    return { sections, hidden: hiddenKeys.map((k) => byKey.get(k)) };
  }

  private async findDefault(objectKey: string, role: string | null): Promise<any | null> {
    const db = this.db as any;
    const rows = await db.select().from(objectLayouts).where(and(eq(objectLayouts.objectKey, objectKey), eq(objectLayouts.active, true)));
    let r = role != null ? rows.find((x: any) => x.isDefault && x.role === role) : undefined;
    if (!r) r = rows.find((x: any) => x.isDefault && x.role == null);
    return r ?? null;
  }

  private shape = (r: any) => ({ id: Number(r.id), object_key: r.objectKey, role: r.role, name: r.name, is_default: r.isDefault, active: r.active, config: r.config ?? {} });

  // ── public API ──
  async list(objectKey: string, _user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(objectLayouts).where(and(eq(objectLayouts.objectKey, objectKey), eq(objectLayouts.active, true)));
    return { object_key: objectKey, layouts: rows.map(this.shape) };
  }

  async resolve(objectKey: string, role: string | null, user: JwtUser) {
    const defs = (await this.cf.listDefs(objectKey, user)).fields;
    const row = await this.findDefault(objectKey, role);
    const built = this.buildSections(defs, row ? this.normalizeStored(row.config) : null);
    return { object_key: objectKey, role: row?.role ?? null, source: row ? (row.role != null ? 'role' : 'object') : 'builtin', ...built };
  }

  async preview(objectKey: string, config: any, role: string | null, user: JwtUser) {
    const defs = (await this.cf.listDefs(objectKey, user)).fields;
    return { object_key: objectKey, role: role ?? null, source: 'preview', ...this.buildSections(defs, this.normalizeStored(config)) };
  }

  async create(dto: { object_key: string; name: string; role?: string | null; config?: any; is_default?: boolean }, user: JwtUser) {
    const db = this.db as any;
    const objectKey = (dto.object_key ?? '').trim();
    const name = (dto.name ?? '').trim();
    if (!objectKey) throw new BadRequestException({ code: 'BAD_OBJECT', message: 'object_key required', messageTh: 'ต้องระบุออบเจ็กต์' });
    if (!name) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'name required', messageTh: 'ต้องระบุชื่อเลย์เอาต์' });
    const role = dto.role ? String(dto.role) : null;
    const [dup] = await db.select({ id: objectLayouts.id }).from(objectLayouts).where(and(eq(objectLayouts.objectKey, objectKey), eq(objectLayouts.name, name))).limit(1);
    if (dup) throw new BadRequestException({ code: 'NAME_EXISTS', message: 'A layout with this name already exists', messageTh: 'มีเลย์เอาต์ชื่อนี้อยู่แล้ว' });
    const siblings = await db.select({ id: objectLayouts.id, role: objectLayouts.role }).from(objectLayouts).where(and(eq(objectLayouts.objectKey, objectKey), eq(objectLayouts.active, true)));
    const makeDefault = dto.is_default === true || siblings.filter((s: any) => (s.role ?? null) === role).length === 0;
    if (makeDefault) {
      const roleCond = role == null ? isNull(objectLayouts.role) : eq(objectLayouts.role, role);
      await db.update(objectLayouts).set({ isDefault: false }).where(and(eq(objectLayouts.objectKey, objectKey), roleCond));
    }
    const [row] = await db.insert(objectLayouts).values({
      tenantId: user.tenantId ?? null, objectKey, role, name, config: this.normalizeStored(dto.config),
      isDefault: makeDefault, active: true, createdBy: user.username, updatedBy: user.username,
    }).returning({ id: objectLayouts.id });
    return { id: Number(row.id), object_key: objectKey, role, name, is_default: makeDefault };
  }

  async update(id: number, dto: { name?: string; config?: any }, user: JwtUser) {
    const db = this.db as any;
    const [row] = await db.select().from(objectLayouts).where(eq(objectLayouts.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'LAYOUT_NOT_FOUND', message: 'Layout not found', messageTh: 'ไม่พบเลย์เอาต์' });
    const patch: any = { updatedBy: user.username, updatedAt: new Date() };
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'name required', messageTh: 'ต้องระบุชื่อเลย์เอาต์' });
      patch.name = name;
    }
    if (dto.config !== undefined) patch.config = this.normalizeStored(dto.config);
    await db.update(objectLayouts).set(patch).where(eq(objectLayouts.id, id));
    return { id, updated: true };
  }

  async setDefault(id: number, _user: JwtUser) {
    const db = this.db as any;
    const [row] = await db.select().from(objectLayouts).where(eq(objectLayouts.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: 'LAYOUT_NOT_FOUND', message: 'Layout not found', messageTh: 'ไม่พบเลย์เอาต์' });
    const roleCond = row.role == null ? isNull(objectLayouts.role) : eq(objectLayouts.role, row.role);
    await db.update(objectLayouts).set({ isDefault: false }).where(and(eq(objectLayouts.objectKey, row.objectKey), roleCond));
    await db.update(objectLayouts).set({ isDefault: true, active: true }).where(eq(objectLayouts.id, id));
    return { id, object_key: row.objectKey, role: row.role ?? null, is_default: true };
  }

  async remove(id: number, _user: JwtUser) {
    const db = this.db as any;
    const upd = await db.update(objectLayouts).set({ isDefault: false, active: false }).where(eq(objectLayouts.id, id)).returning({ id: objectLayouts.id });
    if (!upd.length) throw new NotFoundException({ code: 'LAYOUT_NOT_FOUND', message: 'Layout not found', messageTh: 'ไม่พบเลย์เอาต์' });
    return { id, active: false };
  }
}
