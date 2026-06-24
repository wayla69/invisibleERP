import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Permission } from '@ierp/shared';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'permissions';
export const Permissions = (...perms: Permission[]) => SetMetadata(PERMISSIONS_KEY, perms);

export const NO_TX_KEY = 'noTx';
// Skip the per-request RLS transaction. ONLY for handlers that touch NO tenant-scoped data
// (static config/health) — applying this to a tenant-reading handler reintroduces cross-tenant leaks.
export const NoTx = () => SetMetadata(NO_TX_KEY, true);

export interface JwtUser {
  username: string;
  role: string;
  customerName: string | null;
  tenantId: number | null;
  permissions: string[];
  // Raw API-key scopes (only set for `ierp_` machine principals; undefined for human JWTs).
  // Used by the public API (/api/v1) scope guard; the permission system is unaffected.
  scopes?: string[];
}

// แนบ user จาก JWT (ตั้งโดย JwtAuthGuard) เข้า request
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): JwtUser => {
  const req = ctx.switchToHttp().getRequest();
  return req.user as JwtUser;
});
