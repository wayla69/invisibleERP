import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, type JwtUser } from './decorators';
import { ApiKeyService } from '../modules/platform/api-key.service';
import { resolvePermissions } from '@ierp/shared';

// Map api_keys.scopes (csv) → JwtUser.permissions. A scope is either a known alias,
// a wildcard ('*'/'admin' → full role-default set), or a literal permission key.
const SCOPE_ALIASES: Record<string, string[]> = {
  read: ['dashboard', 'exec', 'cust_dash', 'cust_inventory'],
  write: ['pos', 'order_mgt', 'warehouse', 'procurement'],
};

// Global guard: ทุก endpoint ต้องมี JWT (หรือ API key) ยกเว้น @Public (แก้ช่องโหว่ V1 ที่ data endpoints เปิดโล่ง)
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const auth: string | undefined = req.headers?.authorization;
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Missing token', messageTh: 'ไม่พบ token' });
    }
    const token = auth.slice(7);

    // ── API-key path: Bearer ierp_... ─────────────────────────────
    if (token.startsWith('ierp_')) {
      const row: any = await this.apiKeys.verify(token);
      if (!row) {
        throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Invalid or revoked API key', messageTh: 'API key ไม่ถูกต้องหรือถูกเพิกถอน' });
      }
      const tenantId: number | null = row.tenantId != null ? Number(row.tenantId) : null;
      const scopes: string[] = row.scopes ? String(row.scopes).split(',').filter(Boolean) : [];
      // A key is a machine principal — NEVER 'Admin' (no HQ bypass via key). role='Sales' + the key's
      // own tenantId keeps it RLS-scoped to its tenant.
      const role = 'Sales';
      let permissions: string[];
      if (scopes.includes('*') || scopes.includes('admin')) {
        permissions = resolvePermissions(role as any);
      } else {
        const expanded = scopes.flatMap((s) => SCOPE_ALIASES[s] ?? [s]);
        permissions = expanded.length ? expanded : resolvePermissions(role as any);
      }
      req.user = { username: `apikey:${row.prefix}`, role, customerName: null, tenantId, permissions } satisfies JwtUser;
      return true;
    }

    // ── JWT path ──────────────────────────────────────────────────
    try {
      const payload = await this.jwt.verifyAsync(token);
      req.user = {
        username: payload.sub,
        role: payload.role,
        customerName: payload.customerName ?? null,
        tenantId: payload.tenantId ?? null,
        permissions: payload.permissions ?? [],
      } satisfies JwtUser;
      return true;
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Invalid or expired token', messageTh: 'token ไม่ถูกต้องหรือหมดอายุ' });
    }
  }
}

// ตรวจ @Permissions(...) เทียบกับ user.permissions (Admin มีครบอยู่แล้วจาก resolvePermissions)
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required || required.length === 0) return true;
    const user: JwtUser | undefined = ctx.switchToHttp().getRequest().user;
    const perms = user?.permissions ?? [];
    // ผ่านถ้ามีสิทธิ์อย่างน้อยหนึ่งใน required (ตรง logic เมนู V1 ที่โชว์ถ้ามี perm ใด ๆ)
    const ok = required.some((p) => perms.includes(p));
    if (!ok) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: `Access denied: ${required.join(',')}`, messageTh: 'คุณไม่มีสิทธิ์เข้าถึงส่วนนี้' });
    }
    return true;
  }
}
