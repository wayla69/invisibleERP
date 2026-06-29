import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { tenantALS } from './tenant-context';

const LOG = new Logger('TenantRun');
let warnedRole = false;

// Run `fn` inside a tenant-scoped transaction OUTSIDE of an HTTP request — the same SET LOCAL ROLE +
// app.tenant_id / app.bypass_rls / app.actor GUC setup the TenantTxInterceptor applies per request, so
// the DRIZZLE proxy routes every query through this tx and RLS is enforced. Used by the background-job
// worker, which has no request context of its own. Mirrors tenant-tx.interceptor.ts deliberately.
export async function runInTenantContext<T>(
  db: any,
  ctx: { tenantId: number | null; bypass: boolean; actor?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx: any) => {
    try {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
    } catch {
      // Dev/test (e.g. PGlite has no app_user role): RLS not enforced — same fail-soft as the interceptor.
      if (process.env.NODE_ENV === 'production') {
        LOG.error('SET ROLE app_user failed in worker — refusing job (RLS cannot be enforced).');
        throw new Error('RLS_UNAVAILABLE');
      }
      if (!warnedRole) { warnedRole = true; LOG.warn('Could not SET ROLE app_user — RLS not enforced (dev only).'); }
    }
    await tx.execute(sql`select
      set_config('app.bypass_rls', ${ctx.bypass ? 'on' : 'off'}, true),
      set_config('app.tenant_id', ${ctx.tenantId != null ? String(ctx.tenantId) : ''}, true),
      set_config('app.actor', ${ctx.actor ?? ''}, true)`);
    return tenantALS.run({ tx, tenantId: ctx.tenantId, bypass: ctx.bypass }, () => fn());
  });
}
