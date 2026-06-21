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
    const user = req.user;

    return next.handle().pipe(
      tap({
        next: () => void this.record(action, user, ip, rid, 'success'),
        error: (err) =>
          void this.record(action, user, ip, rid, 'fail', {
            error: err?.message ?? String(err),
          }),
      }),
    );
  }

  // Fire-and-forget audit write. Swallows all errors.
  private async record(
    action: string,
    user: JwtUser | undefined,
    ip: string | null,
    rid: string,
    status: 'success' | 'fail',
    meta?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const db = this.db as any;
      await db.insert(auditLog).values({
        actor: user?.username ?? null,
        // tenantId is numeric; user.customerName is a string code → keep null unless it parses.
        tenantId: numericTenant(user?.customerName),
        action,
        ip,
        requestId: rid,
        status,
        meta: meta ?? null,
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

function numericTenant(customerName: string | null | undefined): number | null {
  if (customerName == null) return null;
  const v = Number(customerName);
  return Number.isInteger(v) ? v : null;
}
