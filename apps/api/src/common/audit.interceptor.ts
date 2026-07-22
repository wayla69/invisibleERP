// Global interceptor that writes an append-only audit_log row for every mutating request
// (POST/PATCH/PUT/DELETE) and for every request — read or write — on the platform-owner surface.
// Resilient: the audit write itself must NEVER throw — a logging failure must not break the business request.
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Inject,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import type { FastifyRequest } from 'fastify';
import { DRIZZLE, type DrizzleDb } from '../database/database.module';
import { auditAction, auditClientIp, auditRequestId, writeAuditRow } from './audit-writer';
import { AUDIT_READ_KEY, PLATFORM_ADMIN_KEY, type JwtUser } from './decorators';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// Which requests must leave an audit_log row. Mutations always do — a read normally does not, because
// ordinary tenant-scoped reads are RLS-confined and would drown the chain.
//
// A @PlatformAdmin route is the exception: it runs under a server-set FULL cross-tenant RLS bypass
// (PlatformAdminGuard → req.__platformBypass), so its READS are cross-tenant too.
// `GET /api/admin/tenants/:id/export` alone streams every row of every tenant-scoped table for any company.
// Leaving those unlogged would let the platform's strongest credential read the entire fleet with no trace —
// so the god surface is audited on EVERY method (ITGC-AC-16 / ITGC-AC-18; PDPA accountability).
// A third case joins them: a READ explicitly marked @AuditRead — a bulk export hands data OUT of the system
// (every customer row as a file; the audit trail itself as CSV), so the act of taking it is evidence in its
// own right. Ordinary reads stay unlogged: they are RLS-confined and would drown the chain.
export function auditRequired(method: string, isPlatformRoute: boolean, isAuditedRead = false): boolean {
  return MUTATING.has((method ?? '').toUpperCase()) || isPlatformRoute || isAuditedRead;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    // Fields set downstream by TenantTxInterceptor (RLS scope of this request) are declared here so the audit
    // trail can read them without an as-any cast.
    const req = ctx.switchToHttp().getRequest<FastifyRequest & {
      user?: JwtUser;
      __auditMeta?: Record<string, unknown>;
      __rlsBypass?: boolean;
      __rlsOrgScope?: number | null;
      __actAsTenant?: number | null;
    }>();
    const method = (req.method ?? '').toUpperCase();
    const isPlatformRoute = this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN_KEY, [ctx.getHandler(), ctx.getClass()]) === true;
    const auditReadReason = this.reflector.getAllAndOverride<string>(AUDIT_READ_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!auditRequired(method, isPlatformRoute, !!auditReadReason)) return next.handle();

    const rid = auditRequestId(req);
    const action = auditAction(req);
    const ip = auditClientIp(req);
    // Snapshot identity NOW — by the time tap() fires, the request tx/ALS has already exited.
    const actor = req.user?.username ?? null;
    const tenantId = req.user?.tenantId ?? null; // numeric; do NOT derive from customerName (a string code)
    // Hybrid tenancy (0196) — flag requests that ran with cross-tenant visibility (HQ global bypass or
    // org-scoped Admin), set by TenantTxInterceptor. Only attach when present so ordinary tenant-scoped
    // rows stay lean. This is the audit trail behind "HQ sees all branches".
    // A god that narrowed its view to one company via the switcher runs with bypass OFF but is still a
    // cross-tenant operator acting on a company that isn't its own — record which company for traceability.
    //
    // MUST be read LAZILY (at tap-time), exactly like svcMeta below. This interceptor is registered FIRST,
    // so it is the OUTERMOST: Nest's InterceptorsConsumer runs interceptors[0].intercept() before
    // interceptors[1]'s, and next.handle() only defers the rest of the chain. Reading these fields eagerly
    // here therefore always saw `undefined` — TenantTxInterceptor had not run yet — and the bypass marker
    // this control depends on was silently never written.
    const xtenant = (): Record<string, unknown> | undefined => {
      const actAs = req.__actAsTenant;
      return actAs != null ? { god_act_as_tenant: actAs }
        : req.__rlsBypass ? { rls_bypass: true }
        : req.__rlsOrgScope != null ? { rls_org_scope: req.__rlsOrgScope }
        : undefined;
    };
    // A god READ is only recorded because the route is @PlatformAdmin — mark it so the trail separates
    // "the platform owner looked at company X" from an ordinary mutation.
    const platformRead = isPlatformRoute && !MUTATING.has(method) ? { platform_read: true } : undefined;
    // A marked bulk export records WHAT left the system, not merely that a GET happened.
    const auditRead = auditReadReason && !MUTATING.has(method) ? { audit_read: auditReadReason } : undefined;

    // Service-attached audit metadata (appendAuditMeta) is read at tap-time — after the handler ran —
    // so a deep service's evidence (e.g. an SoD-override reason) lands in the same hash-chained row.
    const svcMeta = () => req.__auditMeta;
    return next.handle().pipe(
      tap({
        next: () => {
          const meta = { ...(xtenant() ?? {}), ...(platformRead ?? {}), ...(auditRead ?? {}), ...(svcMeta() ?? {}) };
          void writeAuditRow(this.db, { action, actor, tenantId, ip, requestId: rid, status: 'success', meta: Object.keys(meta).length ? meta : undefined });
        },
        error: (err) =>
          void writeAuditRow(this.db, {
            action, actor, tenantId, ip, requestId: rid, status: 'fail',
            meta: { error: err?.message ?? String(err), ...(xtenant() ?? {}), ...(platformRead ?? {}), ...(auditRead ?? {}), ...(svcMeta() ?? {}) },
          }),
      }),
    );
  }
}
