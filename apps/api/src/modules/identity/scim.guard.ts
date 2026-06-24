import { CanActivate, ExecutionContext, Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenantIdentity } from '../../database/schema';
import { safeEqualHex } from '../../common/crypto';
import { resolvePermissions } from '@ierp/shared';
import type { JwtUser } from '../../common/decorators';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Authenticates a SCIM request by its per-tenant bearer token (`Authorization: Bearer scim_…`).
// Mirrors the api-key path: the token is looked up cross-tenant (bypass RLS), hash-compared
// constant-time, and — on success — a tenant-scoped machine principal is set on the request so the
// rest of the pipeline (RLS tenant tx) scopes every write to the SCIM tenant.
@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth: string | undefined = req.headers?.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!token || !token.startsWith('scim_')) {
      throw new UnauthorizedException({ code: 'SCIM_UNAUTHORIZED', message: 'SCIM bearer token required', messageTh: 'ต้องใช้ SCIM token' });
    }
    const prefix = token.slice(0, 12);
    const hashed = sha256(token);
    const db = this.db as any;
    const row = await db.transaction(async (tx: any) => {
      try { await tx.execute(sql`SET LOCAL ROLE app_user`); } catch { /* dev base role */ }
      await tx.execute(sql`select set_config('app.bypass_rls','on',true)`);
      const rows = await tx.select().from(tenantIdentity).where(and(eq(tenantIdentity.scimTokenPrefix, prefix), eq(tenantIdentity.scimEnabled, true)));
      return rows.find((r: any) => r.scimTokenHash && safeEqualHex(hashed, String(r.scimTokenHash))) ?? null;
    });
    if (!row) {
      throw new UnauthorizedException({ code: 'SCIM_UNAUTHORIZED', message: 'Invalid or disabled SCIM token', messageTh: 'SCIM token ไม่ถูกต้อง' });
    }
    // Tenant-scoped machine principal. Role 'AccessAdmin' carries user-management permissions but does
    // NOT bypass RLS (only 'Admin' does), so SCIM is confined to its own tenant.
    req.user = {
      username: `scim:${prefix}`,
      role: 'AccessAdmin',
      customerName: null,
      tenantId: Number(row.tenantId),
      permissions: resolvePermissions('AccessAdmin' as any),
    } satisfies JwtUser;
    return true;
  }
}
