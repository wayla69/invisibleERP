import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request tenant context (move #1). The TenantTxInterceptor opens a transaction,
// SET LOCAL ROLE app_user + sets app.tenant_id / app.bypass_rls, then runs the handler
// inside this store. The DRIZZLE provider is a Proxy that routes every query to store.tx,
// so a forgotten WHERE physically cannot return another tenant's row (DB-enforced RLS).
export interface TenantStore {
  tx: any;
  tenantId: number | null;
  bypass: boolean;
}

export const tenantALS = new AsyncLocalStorage<TenantStore>();

export const currentTenantStore = (): TenantStore | undefined => tenantALS.getStore();
