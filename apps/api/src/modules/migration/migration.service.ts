import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { migrationJobs } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// E2 (Platform Phase 27) — data-migration toolkit. A source adapter maps a vendor export → canonical rows;
// per-row validation (mirroring the Phase-7 importer) reports errors WITHOUT writing. The job is recorded for
// preview; the tenant then commits through the proven Phase-7 import flow. RLS-scoped; no GL.
const SOURCES = [
  { key: 'csv', label: 'Generic CSV / Excel' },
  { key: 'loyverse', label: 'Loyverse' },
  { key: 'flowaccount', label: 'FlowAccount' },
];
const ENTITIES = [
  { key: 'customers', required: ['code', 'name'] },
  { key: 'products', required: ['code', 'name'] },
];
// Per-source field mapping (vendor field → canonical field). Generic CSV is assumed already-canonical.
const MAPS: Record<string, Record<string, Record<string, string>>> = {
  loyverse: { customers: { customer_name: 'name', phone_number: 'phone' }, products: { item_name: 'name', sku: 'code' } },
  flowaccount: { customers: { contact_name: 'name' }, products: { product_name: 'name' } },
  csv: {},
};

@Injectable()
export class MigrationService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  sources() { return { sources: SOURCES.map((s) => ({ ...s })), entities: ENTITIES.map((e) => ({ key: e.key, required: e.required })) }; }

  private normalize(source: string, entity: string, rows: any[]) {
    const map = MAPS[source]?.[entity] ?? {};
    return rows.map((r) => {
      const o: any = { ...r };
      for (const [from, to] of Object.entries(map)) if (from in r && !(to in o && String(o[to]).trim())) o[to] = r[from];
      return o;
    });
  }

  async dryRun(user: JwtUser, source: string, entity: string, rows: any[]) {
    if (!SOURCES.some((s) => s.key === source)) throw new BadRequestException({ code: 'BAD_SOURCE', message: `source must be one of ${SOURCES.map((s) => s.key).join(', ')}`, messageTh: 'แหล่งข้อมูลไม่ถูกต้อง' });
    const ent = ENTITIES.find((e) => e.key === entity);
    if (!ent) throw new BadRequestException({ code: 'BAD_ENTITY', message: `entity must be one of ${ENTITIES.map((e) => e.key).join(', ')}`, messageTh: 'ประเภทข้อมูลไม่ถูกต้อง' });
    if (!Array.isArray(rows)) throw new BadRequestException({ code: 'BAD_ROWS', message: 'rows must be an array', messageTh: 'ข้อมูลต้องเป็นรายการ' });
    const canon = this.normalize(source, entity, rows);
    const errors: { row: number; missing: string[] }[] = [];
    canon.forEach((r, i) => {
      const missing = ent.required.filter((f) => !String(r[f] ?? '').trim());
      if (missing.length) errors.push({ row: i + 1, missing });
    });
    const total = canon.length;
    const rowsError = errors.length;
    const rowsValid = total - rowsError;
    await this.db.insert(migrationJobs).values({ tenantId: user.tenantId ?? null, source, entity, status: 'validated', rowsTotal: total, rowsValid, rowsError, detail: { errors: errors.slice(0, 50) }, createdBy: user.username });
    return { source, entity, total, valid: rowsValid, errors };
  }

  async jobs(_user: JwtUser) {
    const rows = await this.db.select().from(migrationJobs).orderBy(desc(migrationJobs.createdAt));
    return { jobs: rows.map((j: any) => ({ id: Number(j.id), source: j.source, entity: j.entity, status: j.status, total: j.rowsTotal, valid: j.rowsValid, errors: j.rowsError, created_at: j.createdAt })) };
  }
}
