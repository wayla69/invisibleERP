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

export const AUDIT_READ_KEY = 'auditRead';
// Mark a READ route as a data-EGRESS act that must leave an audit_log row, even though reads are otherwise
// unlogged. Ordinary reads are RLS-confined and logging them would drown the per-tenant hash chain — but a
// BULK EXPORT is not an ordinary read: `GET /api/masterdata/customers/export` hands over every customer row
// as a file, `GET /api/admin/audit/export` hands over the audit trail itself. Those leave the system, so the
// act of taking them is itself evidence an auditor needs (and PDPA accountability requires for personal
// data). The reason string is recorded as meta.audit_read so the trail says WHAT left, not merely that a GET
// happened. Read the flag via Reflector in AuditInterceptor — same seam as @PlatformAdmin, so no service
// needs to hand-write an audit row (cf. the one-off CRM.CDP_EXPORT insert this generalises).
export const AuditRead = (reason: string) => SetMetadata(AUDIT_READ_KEY, reason);

export const PLATFORM_ADMIN_KEY = 'platformAdmin';
// Restrict a route to a PLATFORM owner (cross-tenant operator, not a per-tenant Admin) and grant it an RLS
// bypass so it can provision a brand-new tenant. PlatformAdminGuard verifies the caller's username is in
// PLATFORM_ADMIN_USERNAMES; the TenantTxInterceptor then honours the server-set req.__platformBypass flag.
export const PlatformAdmin = () => SetMetadata(PLATFORM_ADMIN_KEY, true);

// The configured platform owners — usernames allowed to create/manage companies across tenants. Empty =
// no platform admin (every @PlatformAdmin route 403s) — secure by default. Case-insensitive, trimmed.
export function platformAdminUsernames(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.PLATFORM_ADMIN_USERNAMES ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
export function isPlatformAdmin(username: string | undefined | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!username) return false;
  return platformAdminUsernames(env).includes(username.trim().toLowerCase());
}

export interface JwtUser {
  username: string;
  role: string;
  customerName: string | null;
  tenantId: number | null;
  // Hybrid tenancy (0196) — the HQ org an Admin belongs to. Only consulted when TENANCY_MODE=multi-company,
  // where it scopes the Admin's RLS bypass to sibling tenants in the same org. null/undefined elsewhere.
  orgId?: number | null;
  permissions: string[];
  // Raw API-key scopes (only set for `ierp_` machine principals; undefined for human JWTs).
  // Used by the public API (/api/v1) scope guard; the permission system is unaffected.
  scopes?: string[];
  // API-key prefix (only set for `ierp_` machine principals). The key's `username` is bound to the MINTING
  // HUMAN for maker-checker (H-2); this carries the machine identity separately — used for the public-API
  // `principal`, per-key rate limiting, and audit traceability. undefined for human JWTs.
  apiKeyPrefix?: string | null;
  // Loyalty MEMBER principal (set only for role==='Member' tokens from the phone-OTP member app). A member
  // token carries permissions:[] (no staff access) and is RLS-scoped to the member's tenant. See MemberGuard.
  memberId?: number | null;
  // SME single-user edition (docs/49) — the tenant's control profile, sourced LIVE from tenants in
  // JwtAuthGuard (never a token claim). Anything but 'sme' means full maker-checker ('enterprise' —
  // fail-closed default for API keys, members and HQ/global accounts). See common/control-profile.ts.
  controlProfile?: 'enterprise' | 'sme' | null;
}

// แนบ user จาก JWT (ตั้งโดย JwtAuthGuard) เข้า request
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): JwtUser => {
  const req = ctx.switchToHttp().getRequest();
  return req.user as JwtUser;
});
