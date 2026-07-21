import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { DRIZZLE, runGlobalDb, type DrizzleDb } from '../../database/database.module';
import * as schema from '../../database/schema';
import { tenants } from '../../database/schema';
import { logger } from '../../observability/logger';

// ── Wave D2: full tenant data export (offboarding / PDPA portability) ──────────────────────────────────
// One god-only read that dumps EVERYTHING the platform holds about one company as a single JSON document:
// the tenant row plus every row in every table scoped to it — discovered automatically from the drizzle
// schema (any table with a `tenant_id` column, plus the platform-level `about_tenant_id` tables such as
// receipts/claims/lifecycle events, so the customer's billing history travels too). Auto-discovery means
// a future tenant-scoped table is included the day it is added — an offboarding export can never silently
// omit a table the way a hand-maintained list would. Per-table rows are capped (an offboarding dump, not
// a streaming replica); a capped table is flagged `truncated` so the operator knows to follow up.

const ROW_CAP = 50_000;

interface TenantTable { name: string; table: PgTable; col: unknown }

// Resolved once at module load — the schema is static.
function discoverTenantTables(): TenantTable[] {
  const found: TenantTable[] = [];
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    try {
      const cfg = getTableConfig(value);
      const col = cfg.columns.find((c) => c.name === 'tenant_id' || c.name === 'about_tenant_id');
      if (col) found.push({ name: cfg.name, table: value, col });
    } catch { /* not a queryable table — skip */ }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
const TENANT_TABLES = discoverTenantTables();

@Injectable()
export class TenantExportService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async exportTenant(tenantId: number) {
    return runGlobalDb('tenant-export', async () => {
      const [tenant] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      if (!tenant) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Tenant not found', messageTh: 'ไม่พบบริษัท' });
      const tables: Record<string, { count: number; truncated: boolean; rows: unknown[] }> = {};
      let rowTotal = 0;
      for (const t of TENANT_TABLES) {
        const rows = await this.db.select().from(t.table).where(eq(t.col as never, tenantId)).limit(ROW_CAP + 1);
        const truncated = rows.length > ROW_CAP;
        const kept = truncated ? rows.slice(0, ROW_CAP) : rows;
        if (kept.length === 0) continue; // keep the document readable — empty tables carry no data to port
        tables[t.name] = { count: kept.length, truncated, rows: kept };
        rowTotal += kept.length;
      }
      logger.info({ tenant_id: tenantId, tables: Object.keys(tables).length, rows: rowTotal }, 'tenant export generated');
      return {
        exported_at: new Date().toISOString(),
        tenant,
        table_count: Object.keys(tables).length,
        row_total: rowTotal,
        tables,
      };
    });
  }
}
