// Global interceptor that writes an append-only audit_log row for every
// mutating request (POST/PATCH/PUT/DELETE). Resilient: the audit write itself
// must NEVER throw — a logging failure must not break the business request.
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Inject,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { sql, eq, isNull, desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { DRIZZLE, type DrizzleDb } from '../database/database.module';
import { auditLog } from '../database/schema';
import { logger, requestId } from '../observability/logger';
import type { JwtUser } from './decorators';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// ITGC-AC-16 — bind each audit row to the previous one. Altering/removing any past row breaks every later hash.
export function auditRowHash(prevHash: string | null, seq: number, r: { actor: string | null; tenantId: number | null; action: string | null; ip: string | null; requestId: string | null; status: string | null; meta: unknown }): string {
  const metaStr = r.meta == null ? '' : stableStringify(r.meta);
  return createHash('sha256').update(`${prevHash ?? ''}|${seq}|${r.tenantId ?? ''}|${r.actor ?? ''}|${r.action ?? ''}|${r.ip ?? ''}|${r.requestId ?? ''}|${r.status ?? ''}|${metaStr}`).digest('hex');
}
function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    // Fields set upstream by TenantTxInterceptor (RLS scope of this request) are declared here so the audit
    // trail can read them without an `as any` cast.
    const req = ctx.switchToHttp().getRequest<FastifyRequest & {
      user?: JwtUser;
      __auditMeta?: Record<string, unknown>;
      __rlsBypass?: boolean;
      __rlsOrgScope?: number | null;
      __actAsTenant?: number | null;
    }>();
    const method = (req.method ?? '').toUpperCase();
    if (!MUTATING.has(method)) return next.handle();

    const rid = (req.headers?.['x-request-id'] as string) || requestId();
    const url = (req as any).originalUrl ?? req.url ?? '';
    const action = `${method} ${url}`;
    const ip = clientIp(req);
    // Snapshot identity NOW — by the time tap() fires, the request tx/ALS has already exited.
    const actor = req.user?.username ?? null;
    const tenantId = req.user?.tenantId ?? null; // numeric; do NOT derive from customerName (a string code)
    // Hybrid tenancy (0196) — flag mutations that ran with cross-tenant visibility (HQ global bypass or
    // org-scoped Admin), set by TenantTxInterceptor. Only attach when present so ordinary tenant-scoped
    // rows stay lean. This is the audit trail behind "HQ sees all branches".
    // A god that narrowed its view to one company via the switcher runs with bypass OFF but is still a
    // cross-tenant operator acting on a company that isn't its own — record which company for traceability.
    const actAs = req.__actAsTenant;
    const xtenant: Record<string, unknown> | undefined =
      actAs != null ? { god_act_as_tenant: actAs }
      : req.__rlsBypass ? { rls_bypass: true }
      : req.__rlsOrgScope != null ? { rls_org_scope: req.__rlsOrgScope }
      : undefined;

    // Service-attached audit metadata (appendAuditMeta) is read at tap-time — after the handler ran —
    // so a deep service's evidence (e.g. an SoD-override reason) lands in the same hash-chained row.
    const svcMeta = () => req.__auditMeta;
    return next.handle().pipe(
      tap({
        next: () => {
          const extra = svcMeta();
          void this.record(action, actor, tenantId, ip, rid, 'success', xtenant || extra ? { ...(xtenant ?? {}), ...(extra ?? {}) } : undefined);
        },
        error: (err) =>
          void this.record(action, actor, tenantId, ip, rid, 'fail', {
            error: err?.message ?? String(err),
            ...(xtenant ?? {}),
            ...(svcMeta() ?? {}),
          }),
      }),
    );
  }

  // Fire-and-forget audit write. Swallows all errors.
  private async record(
    action: string,
    actor: string | null,
    tenantId: number | null,
    ip: string | null,
    rid: string,
    status: 'success' | 'fail',
    meta?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const db = this.db;
      // The request tx already committed/rolled back, so the proxy routes this to the base connection.
      // audit_log is FORCE-RLS (0002_rls.sql) — run in its own tx that sets app.bypass_rls so the
      // WITH CHECK policy admits the row even when tenant_id is NULL (system/pre-auth events). We do
      // NOT SET ROLE here: a swallowed SET-ROLE failure would leave the tx aborted (25P02) and drop
      // the audit row; the base connection role already holds INSERT and the bypass GUC satisfies RLS.
      await db.transaction(async (tx: any) => {
        await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
        // ITGC-AC-16 — append to the per-tenant hash chain. Lock the latest row (FOR UPDATE) so concurrent
        // audit writes can't fork the chain; each hash binds the previous hash + this row's content.
        const [last] = await tx.select({ seq: auditLog.seq, hash: auditLog.hash }).from(auditLog)
          .where(tenantId == null ? isNull(auditLog.tenantId) : eq(auditLog.tenantId, tenantId))
          .orderBy(desc(auditLog.seq)).limit(1).for('update');
        const seq = (last?.seq ?? 0) + 1;
        const prevHash = last?.hash ?? null;
        const hash = auditRowHash(prevHash, seq, { actor, tenantId, action, ip, requestId: rid, status, meta: meta ?? null });
        await tx.insert(auditLog).values({ actor, tenantId, action, ip, requestId: rid, status, meta: meta ?? null, seq, prevHash, hash });
      });
    } catch (e) {
      // Audit must never break the request. Log and move on.
      logger.warn({ err: (e as Error)?.message, action }, 'audit write failed');
    }
  }
}

// Derive the client IP for the audit trail. The X-Forwarded-For chain is client-appendable at the LEFT, so
// taking the first (leftmost) hop trusts a value the client controls — a spoofable audit IP (security review
// L-12). Instead trust only the rightmost `TRUSTED_PROXY_HOPS` entries (the ones your own reverse proxies
// prepend) and read the entry the OUTERMOST trusted proxy saw as the peer. Default 0 ⇒ trust no XFF and use
// the direct socket peer (`req.ip`); set it to the number of proxies in front of the API (e.g. 1 behind a
// single load balancer) so the real client IP is recovered without honoring a forged prefix.
function clientIp(req: FastifyRequest): string | null {
  const hops = Math.max(0, Math.floor(Number(process.env.TRUSTED_PROXY_HOPS ?? 0)) || 0);
  const peer = (req as any).ip ?? null;
  if (hops === 0) return peer; // no trusted proxy → a client-supplied XFF is not trustworthy
  const fwd = req.headers?.['x-forwarded-for'];
  const chain = (typeof fwd === 'string' ? fwd.split(',') : Array.isArray(fwd) ? fwd.flatMap((v) => String(v).split(',')) : [])
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chain.length) return peer;
  // The last `hops` entries were added by trusted proxies; the client-most trusted entry is at length-hops.
  return chain[Math.max(0, chain.length - hops)] ?? peer;
}
