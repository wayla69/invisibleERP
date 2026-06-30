import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, firstValueFrom } from 'rxjs';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../database/database.module';
import { tenantALS } from './tenant-context';
import { NO_TX_KEY } from './decorators';

// Wraps each (non-SSE) request in a tenant-scoped transaction:
//   SET LOCAL ROLE app_user  +  set_config('app.tenant_id'|'app.bypass_rls')
// then runs the handler inside tenantALS so the DRIZZLE proxy routes all queries to this tx.
//
// Tenancy model (chosen): "HQ sees all, staff bound to their shop".
//   - Admin (head office / HQ)  -> bypass: sees every tenant.
//   - public / pre-auth (login, signup) -> bypass: no user yet, needed to read users / create tenants.
//   - everyone else (Customer AND non-Admin staff: Sales/Warehouse/…) -> scoped to their own tenant_id.
// RLS is enforced in the DB; this only decides the per-request scope GUCs.
const RLS_LOGGER = new Logger('RLS');

@Injectable()
export class TenantTxInterceptor implements NestInterceptor {
  private warnedRole = false;
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    if (ctx.getType() !== 'http') return next.handle();
    // do not wrap SSE/streaming endpoints in a single transaction
    const isSse = this.reflector.get<boolean>('sse', ctx.getHandler());
    if (isSse) return next.handle();
    // @NoTx() — opt out for handlers that touch no tenant-scoped data (health/config).
    const noTx = this.reflector.get<boolean>(NO_TX_KEY, ctx.getHandler());
    if (noTx) return next.handle();

    const req = ctx.switchToHttp().getRequest();
    const user = req?.user;
    const tenantId: number | null = user?.tenantId ?? null;

    // Hybrid tenancy (0193). TENANCY_MODE selects the Admin bypass scope:
    //  - single-company (default): HQ (Admin) and pre-auth requests get a GLOBAL bypass — the legacy
    //    "HQ sees all branches" model, unchanged. We still flag the bypass on the request so the audit
    //    interceptor records that the mutation ran with cross-tenant visibility.
    //  - multi-company: only pre-auth (login/signup) keeps the global bypass; an Admin is instead
    //    ORG-scoped via app.org_id (sees only tenants sharing its org_id), and a missing org_id means
    //    the Admin sees nothing beyond its own tenant — fail-closed, not fail-open.
    const multiCompany = (process.env.TENANCY_MODE ?? 'single-company') === 'multi-company';
    const isAdmin = user?.role === 'Admin';
    const preAuth = !user;
    let bypass: boolean;
    let orgScope: number | null = null;
    if (!multiCompany) {
      bypass = preAuth || isAdmin; // legacy global HQ bypass
    } else {
      bypass = preAuth; // login/signup still need it to read users / create tenants
      if (isAdmin) orgScope = user?.orgId != null ? Number(user.orgId) : null; // org-scoped Admin
    }
    // Expose the effective scope to the audit interceptor (records cross-tenant access on mutations).
    req.__rlsBypass = bypass;
    req.__rlsOrgScope = orgScope;

    const db = this.db as any;
    return from(
      db.transaction(async (tx: any) => {
        try {
          await tx.execute(sql`SET LOCAL ROLE app_user`);
        } catch (e) {
          // Failing to assume app_user means RLS is NOT enforced (we'd run as the connection's
          // base role, typically the owner/superuser). In production that is a security failure —
          // fail the request closed rather than silently serving cross-tenant data.
          if (process.env.NODE_ENV === 'production') {
            RLS_LOGGER.error('SET ROLE app_user failed — refusing request (RLS cannot be enforced). Grant app_user membership or connect as app_user.');
            throw new ServiceUnavailableException({ code: 'RLS_UNAVAILABLE', message: 'Tenant isolation unavailable', messageTh: 'ระบบแยกข้อมูลผู้เช่าไม่พร้อมใช้งาน' });
          }
          if (!this.warnedRole) {
            this.warnedRole = true;
            RLS_LOGGER.warn('Could not SET ROLE app_user — RLS not enforced (dev only; grant membership or connect as app_user in prod).');
          }
        }
        // Set all three request GUCs in ONE round-trip (was three serial round-trips, on top of SET ROLE).
        // Batching measurably cuts per-request connection-hold time under load. `app.actor` identifies the
        // actor for the DB-level field change-log triggers (0116). All transaction-local (set_config …, true).
        await tx.execute(sql`select
          set_config('app.bypass_rls', ${bypass ? 'on' : 'off'}, true),
          set_config('app.tenant_id', ${tenantId != null ? String(tenantId) : ''}, true),
          set_config('app.org_id', ${orgScope != null ? String(orgScope) : ''}, true),
          set_config('app.actor', ${user?.username ?? ''}, true)`);
        // NB: we intentionally do NOT force the tx READ ONLY for GETs — several GET handlers perform
        // legitimate writes (dashboard auto-reorder, lazy loyalty-config seed), and Postgres rejects
        // changing access mode after the first query anyway (25001). @NoTx is the opt-out for non-tenant
        // handlers. defaultValue guards handlers that complete without emitting (would throw EmptyError).
        return tenantALS.run({ tx, tenantId, bypass }, () => firstValueFrom(next.handle(), { defaultValue: undefined }));
      }),
    );
  }
}
