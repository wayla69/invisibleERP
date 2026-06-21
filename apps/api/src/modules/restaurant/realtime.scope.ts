// Runs DB work inside an explicit tenant-scoped tx, mirroring TenantTxInterceptor, for code paths that
// run OUTSIDE the per-request tx: public diner (QR) endpoints (@NoTx) and SSE handlers (sse-exempt).
// The tenantALS.run wrapper makes the DRIZZLE proxy route a service's queries into this tx.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenantALS } from '../../common/tenant-context';

@Injectable()
export class RealtimeScope {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Run fn under RLS scoped to one tenant (bypass OFF) — a forged token can never read another tenant.
  async run<T>(tenantId: number, fn: () => Promise<T>): Promise<T> {
    return (this.db as any).transaction(async (tx: any) => {
      try { await tx.execute(sql`SET LOCAL ROLE app_user`); } catch { /* dev base role */ }
      await tx.execute(sql`select set_config('app.bypass_rls','off',true)`);
      await tx.execute(sql`select set_config('app.tenant_id', ${String(tenantId)}, true)`);
      return tenantALS.run({ tx, tenantId, bypass: false }, fn);
    });
  }

  // Controlled bypass: a single indexed lookup that reads NO tenant-private fields (qr_token → tenant),
  // used only to discover which tenant a printed QR belongs to before re-entering run(tenantId).
  async bypassQuery<T>(fn: () => Promise<T>): Promise<T> {
    return (this.db as any).transaction(async (tx: any) => {
      try { await tx.execute(sql`SET LOCAL ROLE app_user`); } catch { /* dev base role */ }
      await tx.execute(sql`select set_config('app.bypass_rls','on',true)`);
      return tenantALS.run({ tx, tenantId: null, bypass: true }, fn);
    });
  }
}
