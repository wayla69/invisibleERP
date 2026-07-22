import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Inject, Logger, ServiceUnavailableException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, firstValueFrom, finalize } from 'rxjs';
import { sql } from 'drizzle-orm';
import { DRIZZLE, globalDbALS, type DrizzleDb } from '../database/database.module';
import { tenantALS } from './tenant-context';
import { AUDIT_READ_KEY, NO_TX_KEY, PLATFORM_ADMIN_KEY, isPlatformAdmin } from './decorators';
import { auditRequired } from './audit.interceptor';
import { txStart, txEnd } from '../observability/runtime-metrics';
import { logger as pino } from '../observability/logger';

// A request whose tenant DB transaction is held longer than this is logged as a slow path (operational
// visibility — a p95 regression or a missing index surfaces here without an external APM). Env-tunable.
const SLOW_TX_MS = Number(process.env.SLOW_TX_MS ?? 1000);

// ITGC-AC-16 completeness (migration 0465). AuditInterceptor writes the trail OUTSIDE the business
// transaction so a logging failure can never roll back a posted journal — the right trade-off, but it means
// a dropped row is invisible: `audit_log.seq` comes from the last SUCCESSFULLY written row, so an omission
// leaves no gap to find. The counter below is the missing half: bumped INSIDE the business transaction, it
// is durable exactly when the mutation committed, so `written >= expected` becomes a checkable invariant and
// a shortfall is provable loss (reconciled by GET /api/admin/audit/verify).
//
// Sharded because one row per tenant would hold a row lock for the whole business transaction and serialise
// that tenant's concurrent writes. The shard is picked per request; reconciliation sums the shards.
const AUDIT_EXPECT_SHARDS = 16;
let auditShardCursor = 0;

// Wraps each (non-SSE) request in a tenant-scoped transaction:
//   SET LOCAL ROLE app_user  +  set_config('app.tenant_id'|'app.bypass_rls')
// then runs the handler inside tenantALS so the DRIZZLE proxy routes all queries to this tx.
//
// Tenancy model (chosen): "HQ sees all, staff bound to their shop".
//   - Platform owner (PLATFORM_ADMIN_USERNAMES) = "god" -> global bypass on EVERY route, regardless of mode.
//   - Admin (head office / HQ)  -> bypass in single-company (sees every tenant); org-scoped in multi-company.
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
    // @NoTx() — opt out for handlers that touch no tenant-scoped data (health/config) or that resolve and
    // scope the tenant themselves (public webhooks, cross-tenant cron sweeps, member-auth). @NoTx is an
    // explicit "no per-request tenant tx — I manage scoping myself" contract, which is exactly what
    // runGlobalDb declares: run the handler inside globalDbALS so the fail-closed proxy (STRICT_TENANT_PROXY)
    // permits its intentional base-pool access instead of throwing TENANT_CONTEXT_MISSING. This covers every
    // @NoTx route at one choke point (harnesses that call the service directly still wrap at the method).
    const noTx = this.reflector.get<boolean>(NO_TX_KEY, ctx.getHandler());
    if (noTx) {
      const r = ctx.switchToHttp().getRequest();
      return from(globalDbALS.run(
        { reason: `@NoTx ${r?.method ?? ''} ${r?.url ?? ''}` },
        () => firstValueFrom(next.handle(), { defaultValue: undefined }),
      ));
    }

    const req = ctx.switchToHttp().getRequest();
    const user = req?.user;
    const tenantId: number | null = user?.tenantId ?? null;

    // Hybrid tenancy (0196). TENANCY_MODE selects the Admin bypass scope:
    //  - single-company (default): HQ (Admin) and pre-auth requests get a GLOBAL bypass — the legacy
    //    "HQ sees all branches" model, unchanged. We still flag the bypass on the request so the audit
    //    interceptor records that the mutation ran with cross-tenant visibility.
    //  - multi-company: only pre-auth (login/signup) keeps the global bypass; an Admin is instead
    //    ORG-scoped via app.org_id (sees only tenants sharing its org_id), and a missing org_id means
    //    the Admin sees nothing beyond its own tenant — fail-closed, not fail-open.
    const multiCompany = (process.env.TENANCY_MODE ?? 'single-company') === 'multi-company';
    const isAdmin = user?.role === 'Admin';
    const preAuth = !user;
    // Platform-admin bypass — set server-side by PlatformAdminGuard (never from client input) on a verified
    // @PlatformAdmin route, so it can provision a brand-new tenant regardless of tenancy mode.
    const platformBypass = req.__platformBypass === true;
    // Platform owner = "god": a user whose username is in PLATFORM_ADMIN_USERNAMES gets a GLOBAL RLS bypass on
    // EVERY route (not only the @PlatformAdmin management endpoints) — so an ops-designated owner can see and
    // operate across ALL tenants, while a per-tenant Admin stays org-scoped (multi-company). This is gated
    // purely by env (never an assignable DB role), so a tenant Admin who manages users cannot escalate into
    // it. Cross-tenant reads/writes it makes are still flagged to the audit interceptor via req.__rlsBypass.
    const isGod = isPlatformAdmin(user?.username);
    // God "act-as-company": the web company-switcher lets a platform owner narrow its global view to ONE
    // company. The client sends `X-Act-As-Tenant: <tenantId>`; we honour it ONLY for a god (never a normal
    // Admin/staff) and ONLY on non-provisioning routes (a @PlatformAdmin route keeps its full bypass so the
    // switcher's own directory still lists every company). It only ever REDUCES a god's visibility — god
    // already sees everything — so trusting a client header here is safe (no privilege escalation). An
    // invalid/absent value falls through to the normal global-god path.
    const actAsRaw = req.headers?.['x-act-as-tenant'];
    const actAsTenant = isGod && !platformBypass && actAsRaw != null && /^[0-9]+$/.test(String(actAsRaw))
      ? Number(actAsRaw)
      : null;
    // Read-only inspection — a god can enter a company to look without any risk of writing. When set, we
    // reject mutating requests (safe support view). GETs (incl. their incidental pref writes) still work.
    //
    // Keyed on `isGod`, NOT on `actAsTenant != null`. A @PlatformAdmin route deliberately keeps its full
    // bypass (so the switcher's own company directory still lists every company), which left actAsTenant
    // null there — so the read-only rail silently did NOT apply to the platform surface, and a god who had
    // entered "read-only company view" to inspect a customer could still fire POST /api/admin/tenants/:id/
    // purge or item-maintenance/force-purge. Since the flag is a client header a god can simply omit, this
    // is a SAFETY rail for the operator rather than a boundary against an attacker — but an operator firing
    // a destructive fleet action while believing they are in look-only mode is exactly the accident it
    // exists to prevent. Widening it is strictly more restrictive and the web only sends the header when a
    // company is selected read-only, so no existing flow changes.
    const actAsReadOnly = isGod && req.headers?.['x-act-as-read-only'] === '1';
    if (actAsReadOnly) {
      const method = String(req.method ?? '').toUpperCase();
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        throw new ForbiddenException({ code: 'READONLY_IMPERSONATION', message: 'Read-only company view — writing is disabled', messageTh: 'กำลังดูบริษัทแบบอ่านอย่างเดียว — แก้ไขข้อมูลไม่ได้' });
      }
    }
    let bypass: boolean;
    let orgScope: number | null = null;
    let effectiveTenantId: number | null = tenantId;
    if (actAsTenant != null) {
      // God scoped to a single chosen company: drop the bypass and pin app.tenant_id to that tenant so RLS
      // returns only its rows — exactly the visibility a per-tenant Admin of that company would have. Also
      // repoint the request's user.tenantId so services that derive the write tenant from the JWT (and the
      // incidental writes some GETs perform — dashboard auto-reorder, lazy config seed) act as that company
      // too, and don't trip the RLS WITH CHECK against the now-scoped app.tenant_id.
      bypass = false;
      effectiveTenantId = actAsTenant;
      if (user) user.tenantId = actAsTenant;
    } else if (!multiCompany) {
      bypass = preAuth || isAdmin || platformBypass || isGod; // legacy global HQ bypass (god implied)
    } else {
      bypass = preAuth || platformBypass || isGod; // god + login/signup + platform provisioning get the global bypass
      if (isAdmin && !bypass) orgScope = user?.orgId != null ? Number(user.orgId) : null; // org-scoped Admin (non-god)
    }
    // Expose the effective scope to the audit interceptor (records cross-tenant access on mutations).
    req.__rlsBypass = bypass;
    req.__rlsOrgScope = orgScope;
    req.__actAsTenant = actAsTenant; // audit: which company a god narrowed its view to (null = global)

    // Will AuditInterceptor write a row for this request? Same predicate, same metadata keys — read here so
    // the expectation is counted for exactly the set of requests the trail is supposed to contain.
    const auditOwed = auditRequired(
      String(req?.method ?? ''),
      this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN_KEY, [ctx.getHandler(), ctx.getClass()]) === true,
      !!this.reflector.getAllAndOverride<string>(AUDIT_READ_KEY, [ctx.getHandler(), ctx.getClass()]),
    );

    // Bracket the request's DB transaction for ops metrics + slow-path logging (operational visibility).
    const started = Date.now();
    txStart();
    const db = this.db;
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
          set_config('app.tenant_id', ${effectiveTenantId != null ? String(effectiveTenantId) : ''}, true),
          set_config('app.org_id', ${orgScope != null ? String(orgScope) : ''}, true),
          set_config('app.actor', ${user?.username ?? ''}, true)`);
        // Record that this request OWES an audit row — atomically with the business change it describes.
        // Best-effort in the same sense as the trail itself: if the counter cannot be bumped we do NOT fail
        // the business request (that would make an integrity ledger an availability risk); the reconciliation
        // then simply under-counts, which is the SAFE direction — it can only hide a loss, never invent one.
        if (auditOwed) {
          try {
            const shard = (auditShardCursor = (auditShardCursor + 1) % AUDIT_EXPECT_SHARDS);
            // Keyed on the tenant the AUDIT ROW will carry — AuditInterceptor snapshots req.user.tenantId
            // before this interceptor repoints it for act-as, so use the pre-repoint value, not the
            // effective one, or a god acting-as would bump a different tenant than it credits.
            await tx.execute(sql`insert into audit_expectations (tenant_id, shard, expected) values (${tenantId ?? 0}, ${shard}, 1)
              on conflict (tenant_id, shard) do update set expected = audit_expectations.expected + 1, updated_at = now()`);
          } catch (e) {
            pino.warn({ err: (e as Error)?.message }, 'audit expectation bump failed — reconciliation will under-count');
          }
        }
        // NB: we intentionally do NOT force the tx READ ONLY for GETs — several GET handlers perform
        // legitimate writes (dashboard auto-reorder, lazy loyalty-config seed), and Postgres rejects
        // changing access mode after the first query anyway (25001). @NoTx is the opt-out for non-tenant
        // handlers. defaultValue guards handlers that complete without emitting (would throw EmptyError).
        return tenantALS.run({ tx, tenantId: effectiveTenantId, bypass, req }, () => firstValueFrom(next.handle(), { defaultValue: undefined }));
      }),
    ).pipe(
      finalize(() => {
        const dur = Date.now() - started;
        txEnd(dur, SLOW_TX_MS);
        if (dur >= SLOW_TX_MS) {
          pino.warn({ event: 'slow_request', method: req?.method, route: req?.url, duration_ms: dur }, 'slow DB transaction');
        }
      }),
    );
  }
}
