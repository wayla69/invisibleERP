import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lte, desc, ilike, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { auditLog, dataChangeLog } from '../../database/schema';

export interface ChangeFilters { table?: string; row_pk?: string; actor?: string; from?: string; to?: string; tenantId?: number | null }

export interface AuditFilters {
  actor?: string;
  action?: string;
  status?: string;
  entity?: string;
  from?: string;
  to?: string;
}

// Read-only viewer over the append-only audit_log. Tenant isolation is enforced by RLS (a tenant-scoped
// admin sees only their tenant's rows; HQ/Admin bypasses RLS and sees all). The append-only trigger (0062)
// guarantees these rows can never be mutated — this module only ever SELECTs.
@Injectable()
export class AuditViewerService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private where(f: AuditFilters): SQL | undefined {
    const c: SQL[] = [];
    if (f.actor) c.push(ilike(auditLog.actor, `%${f.actor}%`));
    if (f.action) c.push(ilike(auditLog.action, `%${f.action}%`));
    if (f.entity) c.push(ilike(auditLog.entity, `%${f.entity}%`));
    if (f.status) c.push(eq(auditLog.status, f.status));
    if (f.from) { const d = new Date(f.from); if (!isNaN(d.getTime())) c.push(gte(auditLog.ts, d)); }
    if (f.to) { const d = new Date(f.to); if (!isNaN(d.getTime())) c.push(lte(auditLog.ts, d)); }
    return c.length ? and(...c) : undefined;
  }

  private fmt(r: any) {
    return {
      id: Number(r.id), ts: r.ts, actor: r.actor, tenant_id: r.tenantId, action: r.action,
      entity: r.entity, entity_id: r.entityId, ip: r.ip, request_id: r.requestId, trace_id: r.traceId,
      status: r.status, meta: r.meta,
    };
  }

  async query(f: AuditFilters, limit: number, offset: number) {
    const db = this.db as any;
    const w = this.where(f);
    const rows = await db.select().from(auditLog).where(w).orderBy(desc(auditLog.ts)).limit(limit).offset(offset);
    const [c] = await db.select({ c: sql<number>`count(*)` }).from(auditLog).where(w);
    return { rows: rows.map((r: any) => this.fmt(r)), total: Number(c?.c ?? 0), limit, offset };
  }

  // CSV of the same filtered set (capped) — auditor-friendly export.
  async exportCsv(f: AuditFilters): Promise<string> {
    const db = this.db as any;
    const rows = await db.select().from(auditLog).where(this.where(f)).orderBy(desc(auditLog.ts)).limit(5000);
    const esc = (v: unknown) => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = ['id', 'ts', 'actor', 'tenant_id', 'action', 'entity', 'entity_id', 'ip', 'request_id', 'status', 'meta'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const v = this.fmt(r);
      lines.push([v.id, v.ts, v.actor, v.tenant_id, v.action, v.entity, v.entity_id, v.ip, v.request_id, v.status, v.meta].map(esc).join(','));
    }
    return lines.join('\n');
  }

  // Field-level OLD→NEW change log (ITGC-AC-14), captured by DB triggers on the financial tables. Append-only.
  // Tenant scoping is applied here (data_change_log opts out of RLS): a non-Admin caller sees only their tenant.
  async changes(f: ChangeFilters, limit: number, offset: number) {
    const db = this.db as any;
    const c: SQL[] = [];
    if (f.table) c.push(eq(dataChangeLog.tableName, f.table));
    if (f.row_pk) c.push(eq(dataChangeLog.rowPk, f.row_pk));
    if (f.actor) c.push(ilike(dataChangeLog.actor, `%${f.actor}%`));
    if (f.from) { const d = new Date(f.from); if (!isNaN(d.getTime())) c.push(gte(dataChangeLog.ts, d)); }
    if (f.to) { const d = new Date(f.to); if (!isNaN(d.getTime())) c.push(lte(dataChangeLog.ts, d)); }
    if (f.tenantId != null) c.push(eq(dataChangeLog.tenantRef, f.tenantId)); // non-Admin → own tenant only
    const w = c.length ? and(...c) : undefined;
    const rows = await db.select().from(dataChangeLog).where(w).orderBy(desc(dataChangeLog.ts)).limit(limit).offset(offset);
    const [n] = await db.select({ c: sql<number>`count(*)` }).from(dataChangeLog).where(w);
    return {
      rows: rows.map((r: any) => ({
        id: Number(r.id), ts: r.ts, table: r.tableName, op: r.op, row_pk: r.rowPk, tenant_id: r.tenantRef,
        actor: r.actor, old_value: r.oldValue, new_value: r.newValue, changed_columns: r.changedColumns,
      })),
      total: Number(n?.c ?? 0), limit, offset,
    };
  }
}
