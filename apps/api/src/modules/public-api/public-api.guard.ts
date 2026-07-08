import { CanActivate, ExecutionContext, Injectable, SetMetadata, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, type JwtUser } from '../../common/decorators';

// Required public-API scopes for a handler, e.g. @Scopes('catalog:read').
export const SCOPES_KEY = 'publicApiScopes';
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);

// Does a key's granted scopes satisfy a required scope? Exact match, the legacy
// 'read'/'write' aliases (satisfy any ':read'/':write' scope), or full ('*'/'admin').
export function scopeSatisfied(granted: string[], required: string): boolean {
  if (granted.includes('*') || granted.includes('admin')) return true;
  if (granted.includes(required)) return true;
  if (required.endsWith(':read') && granted.includes('read')) return true;
  if (required.endsWith(':write') && granted.includes('write')) return true;
  return false;
}

// Fixed-window, in-memory, per-key rate limiter. Per-process (mirrors the global @fastify/rate-limit
// edge limiter) — a distributed deployment would need a shared backend. Window/limit are env-tunable.
const buckets = new Map<string, { windowStart: number; count: number }>();
function rateLimited(key: string, now: number): { limited: boolean; max: number; windowMs: number; retryAfter: number } {
  const max = Math.max(1, Number(process.env.PUBLIC_API_RATE_MAX ?? 120));
  const windowMs = Math.max(1000, Number(process.env.PUBLIC_API_RATE_WINDOW_MS ?? 60_000));
  const b = buckets.get(key);
  if (!b || now - b.windowStart >= windowMs) {
    buckets.set(key, { windowStart: now, count: 1 });
    return { limited: false, max, windowMs, retryAfter: 0 };
  }
  b.count += 1;
  const limited = b.count > max;
  return { limited, max, windowMs, retryAfter: Math.ceil((b.windowStart + windowMs - now) / 1000) };
}

// Public API gate: the surface is API-KEY ONLY (human JWTs are rejected), scope-checked, and
// per-key rate-limited. Runs after the global JwtAuthGuard has set req.user. @Public() handlers
// (the discovery root + OpenAPI doc) are skipped.
@Injectable()
export class PublicApiGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const user: JwtUser | undefined = req.user;
    // API-key only: a machine principal is the ONLY principal that carries `scopes` (set by JwtAuthGuard
    // for `ierp_` keys). Its `username` is now the minting human (H-2), so identify it by `scopes`/prefix,
    // not the old `apikey:` username prefix.
    if (!user || user.scopes == null || user.apiKeyPrefix == null) {
      throw new ForbiddenException({ code: 'API_KEY_REQUIRED', message: 'The public API requires an API key (Bearer ierp_…)', messageTh: 'API สาธารณะต้องใช้ API key (Bearer ierp_…)' });
    }

    // Per-key fixed-window rate limit — keyed on the stable key prefix (not the shared minter identity).
    const rl = rateLimited(user.apiKeyPrefix, Date.now());
    const res = ctx.switchToHttp().getResponse();
    try { res?.header?.('X-RateLimit-Limit', String(rl.max)); } catch { /* header best-effort */ }
    if (rl.limited) {
      try { res?.header?.('Retry-After', String(rl.retryAfter)); } catch { /* */ }
      throw new HttpException({ code: 'RATE_LIMITED', message: `Rate limit exceeded (${rl.max}/window)`, messageTh: 'เรียกใช้บ่อยเกินกำหนด' }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const required = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [ctx.getHandler(), ctx.getClass()]) ?? [];
    const granted = user.scopes;
    const missing = required.filter((s) => !scopeSatisfied(granted, s));
    if (missing.length) {
      throw new ForbiddenException({ code: 'INSUFFICIENT_SCOPE', message: `Missing scope(s): ${missing.join(', ')}`, messageTh: `ขาดสิทธิ์ (scope): ${missing.join(', ')}`, missing });
    }
    return true;
  }
}
