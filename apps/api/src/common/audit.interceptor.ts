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
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { DRIZZLE, type DrizzleDb } from '../database/database.module';
import { auditLog } from '../database/schema';
import { logger, requestId } from '../observability/logger';
import type { JwtUser } from './decorators';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: JwtUser }>();
    const method = (req.method ?? '').toUpperCase();
    if (!MUTATING.has(method)) return next.handle();

    const rid = (req.headers?.['x-request-id'] as string) || requestId();
    const url = (req as any).originalUrl ?? req.url ?? '';
    const action = `${method} ${url}`;
    const ip = clientIp(req);
    // Snapshot identity NOW — by the time tap() fires, the request tx/ALS has already exited.
    const actor = req.user?.username ?? null;
    const tenantId = req.user?.tenantId ?? null; // numeric; do NOT derive from customerName (a string code)

    return next.handle().pipe(
      tap({
        next: () => void this.record(action, actor, tenantId, ip, rid, 'success'),
        error: (err) =>
          void this.record(action, actor, tenantId, ip, rid, 'fail', {
            error: err?.message ?? String(err),
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
      const db = this.db as any;
      // The request tx already committed/rolled back, so the proxy routes this to the base connection.
      // audit_log is FORCE-RLS (0002_rls.sql) — run in its own tx that sets app.bypass_rls so the
      // WITH CHECK policy admits the row even when tenant_id is NULL (system/pre-auth events). We do
      // NOT SET ROLE here: a swallowed SET-ROLE failure would leave the tx aborted (25P02) and drop
      // the audit row; the base connection role already holds INSERT and the bypass GUC satisfies RLS.
      await db.transaction(async (tx: any) => {
        await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
        await tx.insert(auditLog).values({ actor, tenantId, action, ip, requestId: rid, status, meta: meta ?? null });
      });
    } catch (e) {
      // Audit must never break the request. Log and move on.
      logger.warn({ err: (e as Error)?.message, action }, 'audit write failed');
    }
  }
}

function clientIp(req: FastifyRequest): string | null {
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  if (Array.isArray(fwd) && fwd.length) return String(fwd[0]).trim();
  return (req as any).ip ?? null;
}
