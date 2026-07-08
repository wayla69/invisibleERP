import { Injectable, Inject, Optional } from '@nestjs/common';
import { PG_CLIENT, type PgClient } from '../../database/database.module';

// Records one billable business event per meter (e-Tax document, POS transaction), deduped by a natural key.
// Written via the AUTOCOMMIT PG_CLIENT (like AgentService.recordUsage) so the meter survives a request-tx
// rollback, and it is BEST-EFFORT — every path swallows errors so a metering hiccup never blocks the sale or
// e-Tax submission that triggered it. Idempotent per (tenant, meter, event_key) via the usage_events UNIQUE.
@Injectable()
export class UsageMeterService {
  constructor(@Optional() @Inject(PG_CLIENT) private readonly sql?: PgClient) {}

  async record(tenantId: number | null | undefined, meter: string, eventKey: string | null | undefined): Promise<void> {
    if (tenantId == null || !eventKey || !this.sql) return; // no tenant / no key / no autocommit client (harness) → unmetered
    try {
      await this.sql`
        INSERT INTO usage_events (tenant_id, meter, event_key, period)
        VALUES (${tenantId}, ${meter}, ${eventKey}, to_char((now() AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY-MM'))
        ON CONFLICT (tenant_id, meter, event_key) DO NOTHING`;
    } catch { /* best-effort meter — a failure must never break the underlying transaction */ }
  }
}
