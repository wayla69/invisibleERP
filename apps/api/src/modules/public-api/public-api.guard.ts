import { CanActivate, ExecutionContext, Injectable, SetMetadata, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, type JwtUser } from '../../common/decorators';
import { hitRateLimit } from '../../common/rate-limit-store';

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

// Fixed-window, per-key rate limiter. Backed by the SHARED rate-limit store (security review L-8): Redis when
// RATE_LIMIT_REDIS_URL/REALTIME_REDIS_URL is set so the limit holds across replicas, else per-process
// in-memory (unchanged default). Window/limit are env-tunable.
async function rateLimited(key: string, now: number): Promise<{ limited: boolean; max: number; windowMs: number; retryAfter: number }> {
  const max = Math.max(1, Number(process.env.PUBLIC_API_RATE_MAX ?? 120));
  const windowMs = Math.max(1000, Number(process.env.PUBLIC_API_RATE_WINDOW_MS ?? 60_000));
  const r = await hitRateLimit(key, max, windowMs, now);
  return { limited: r.limited, max, windowMs, retryAfter: r.retryAfter };
}

// Public API gate: the surface is API-KEY ONLY (human JWTs are rejected), scope-checked, and
// per-key rate-limited. Runs after the global JwtAuthGuard has set req.user. @Public() handlers
// (the discovery root + OpenAPI doc) are skipped.
@Injectable()
export class PublicApiGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
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
    const rl = await rateLimited(user.apiKeyPrefix, Date.now());
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
