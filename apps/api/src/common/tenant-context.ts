import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request tenant context (move #1). The TenantTxInterceptor opens a transaction,
// SET LOCAL ROLE app_user + sets app.tenant_id / app.bypass_rls, then runs the handler
// inside this store. The DRIZZLE provider is a Proxy that routes every query to store.tx,
// so a forgotten WHERE physically cannot return another tenant's row (DB-enforced RLS).
export interface TenantStore {
  tx: any;
  tenantId: number | null;
  bypass: boolean;
  /** The underlying HTTP request — lets deep services attach audit metadata (see appendAuditMeta). */
  req?: any;
}

export const tenantALS = new AsyncLocalStorage<TenantStore>();

export const currentTenantStore = (): TenantStore | undefined => tenantALS.getStore();

/** Attach tamper-evident metadata to THIS request's audit_log row (docs/27 AUD-SEC-04 round-2).
 *  The AuditInterceptor merges `req.__auditMeta` into the hash-chained `meta` column, so anything a
 *  service records here (e.g. an SoD-override reason) becomes durable audit evidence — not just an
 *  ephemeral app log. No-op outside a request context (jobs, harness bootstraps). */
export function appendAuditMeta(patch: Record<string, unknown>): void {
  const req = tenantALS.getStore()?.req;
  if (!req) return;
  req.__auditMeta = { ...(req.__auditMeta ?? {}), ...patch };
}
