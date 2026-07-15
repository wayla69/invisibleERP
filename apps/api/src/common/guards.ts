import { CanActivate, ExecutionContext, Injectable, Inject, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'node:crypto';
import { eq, and, gt, sql } from 'drizzle-orm';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, PLATFORM_ADMIN_KEY, isPlatformAdmin, type JwtUser } from './decorators';
import { ApiKeyService } from '../modules/platform/api-key.service';
import { DRIZZLE, type DrizzleDb } from '../database/database.module';
import { users, revokedTokens, posMembers, tenants } from '../database/schema';
import { resolvePermissions, type Role } from '@ierp/shared';
import { requiresMfaEnrollment, enforcePrivilegedMfa } from './mfa-gate';
import { AUTH_COOKIE, CSRF_COOKIE, readCookie } from './cookies';

// State-changing methods that require a CSRF double-submit check when authenticated via cookie.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Constant-time CSRF token comparison — never compare a secret with `===`/`!==` (timing oracle, CWE-208).
function csrfMatches(header: unknown, cookie: string | undefined): boolean {
  if (typeof header !== 'string' || typeof cookie !== 'string' || !cookie) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(cookie);
  return a.length === b.length && timingSafeEqual(a, b);
}

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
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
  ) {}

  // Auth-infra identity reads run BEFORE the per-request tenant transaction (guards precede
  // interceptors), so they hit the base connection with NO app.* GUCs set. `users`/`pos_members` carry a
  // tenant_id and are therefore under FORCE row-level security — and once the base connection role became
  // the non-superuser table OWNER (H-3 hardening), FORCE applies to it too, so this pre-tenant lookup
  // returned ZERO rows and every valid session looked like a deleted account (USER_NOT_FOUND → 401 →
  // login bounce; root cause of the 2026-07-10 incident). Run these reads in a short transaction that
  // sets app.bypass_rls: identity resolution legitimately predates tenant context. Normal per-request
  // queries are unaffected — they still SET ROLE app_user and enforce tenant RLS.
  private async authRead<T>(run: (tx: DrizzleDb) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
      return run(tx);
    });
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    // Token source: Authorization: Bearer header (harnesses, API keys, mobile) OR the httpOnly cookie
    // (browser web app). Header wins when both are present.
    const auth: string | undefined = req.headers?.authorization;
    const fromCookie = !auth?.startsWith('Bearer ');
    const token = fromCookie ? readCookie(req, AUTH_COOKIE) : auth!.slice(7);
    if (!token) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Missing token', messageTh: 'ไม่พบ token' });
    }

    // CSRF: a cookie-authenticated mutating request must carry X-CSRF-Token matching the readable CSRF
    // cookie (double-submit). Header/Bearer-authenticated requests (harnesses, API keys, mobile) are exempt
    // because they don't ride an ambient cookie and so aren't forgeable cross-site.
    if (fromCookie && MUTATING.has((req.method ?? '').toUpperCase())) {
      if (!csrfMatches(req.headers?.['x-csrf-token'], readCookie(req, CSRF_COOKIE))) {
        throw new ForbiddenException({ code: 'CSRF', message: 'Missing or invalid CSRF token', messageTh: 'CSRF token ไม่ถูกต้อง' });
      }
    }

    // ── API-key path: Bearer ierp_... (header only; cookies only ever carry a JWT) ──
    if (!fromCookie && token.startsWith('ierp_')) {
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
        permissions = resolvePermissions(role as Parameters<typeof resolvePermissions>[0]);
      } else {
        const expanded = scopes.flatMap((s) => SCOPE_ALIASES[s] ?? [s]);
        permissions = expanded.length ? expanded : resolvePermissions(role as Parameters<typeof resolvePermissions>[0]);
      }
      // SoD (security review H-2): the key acts AS its minting human for maker-checker/SoD identity, so a
      // person can't launder a self-approval through their own key(s). Legacy keys (no created_by) keep the
      // `apikey:<prefix>` machine identity. The prefix is carried separately (apiKeyPrefix) for the machine
      // surface — the public-API `principal`, per-key rate limiting — and for audit traceability.
      const principal: string = row.createdBy ?? `apikey:${row.prefix}`;
      // Carry the raw granted scopes alongside the expanded permissions — the public API
      // (/api/v1) gates on these scopes directly (a stable contract independent of internal perms).
      req.user = { username: principal, role, customerName: null, tenantId, permissions, scopes, apiKeyPrefix: row.prefix } satisfies JwtUser;
      return true;
    }

    // ── JWT path ──────────────────────────────────────────────────
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Invalid or expired token', messageTh: 'token ไม่ถูกต้องหรือหมดอายุ' });
    }
    // ITGC-AC-15 — session revocation: a logged-out token (jti denylist), a deactivated account, or a token
    // issued before a "revoke all sessions" watermark is rejected even though the signature is still valid.
    let dbRole: string | undefined; // live role from the users table (staff); overrides the token's role claim
    let dbOrgId: number | null = null; // live org_id (staff) for hybrid multi-company bypass scoping
    let dbTenantId: number | null | undefined; // live tenant_id (staff); overrides the token's tenantId claim (L-3)
    let dbControlProfile: 'enterprise' | 'sme' | null = null; // live tenants.control_profile (docs/49) — never a token claim
    const revoked = new UnauthorizedException({ code: 'TOKEN_REVOKED', message: 'Session has been revoked — please sign in again', messageTh: 'เซสชันถูกยกเลิก กรุณาเข้าสู่ระบบใหม่' });
    if (payload.jti) {
      const [rev] = await this.authRead((tx) => tx.select({ j: revokedTokens.jti }).from(revokedTokens).where(and(eq(revokedTokens.jti, payload.jti), gt(revokedTokens.expiresAt, new Date()))).limit(1));
      if (rev) throw revoked;
    }
    if (payload.sub && typeof payload.sub === 'string' && payload.sub.startsWith('member:')) {
      // Member principal (loyalty self-service). Re-check pos_members.active each request so a
      // deactivated/deprovisioned member's token stops working at once — not after its 7-day expiry.
      const memberId = payload.memberId ?? Number(payload.sub.slice('member:'.length));
      if (Number.isFinite(memberId)) {
        const [m] = await this.authRead((tx) => tx.select({ active: posMembers.active }).from(posMembers).where(eq(posMembers.id, memberId)).limit(1));
        if (m && m.active === false) throw new UnauthorizedException({ code: 'MEMBER_DEACTIVATED', message: 'This membership is no longer active', messageTh: 'สมาชิกนี้ถูกปิดใช้งาน' });
      }
    } else if (payload.sub) {
      const [u] = await this.authRead((tx) => tx.select({ active: users.isActive, tvf: users.tokensValidFrom, role: users.role, orgId: users.orgId, tenantId: users.tenantId, mcp: users.mustChangePassword, mfaEnabled: users.mfaEnabled, tenantSuspended: tenants.suspendedAt, tenantDeleted: tenants.deletedAt, controlProfile: tenants.controlProfile })
        .from(users).leftJoin(tenants, eq(users.tenantId, tenants.id)).where(eq(users.username, payload.sub)).limit(1));
      if (u) { // staff principal — members aren't in `users`, so they skip this check
        if (u.active === false) throw new UnauthorizedException({ code: 'USER_DEACTIVATED', message: 'This account has been deactivated', messageTh: 'บัญชีนี้ถูกปิดใช้งาน' });
        // Soft-delete (migration 0393) — a deleted company's users are blocked PERMANENTLY, independent of
        // suspended_at (so a stray reactivate on a deleted tenant can never silently re-open logins; only
        // restoreTenant clears this). Platform owners are exempt so they can always restore.
        if (u.tenantDeleted && !isPlatformAdmin(payload.sub)) throw new ForbiddenException({ code: 'TENANT_DELETED', message: 'This company no longer exists — contact the administrator', messageTh: 'บริษัทนี้ถูกลบแล้ว — โปรดติดต่อผู้ดูแลระบบ' });
        // #5 tenant lifecycle — a suspended company's users are blocked. Platform owners are exempt so they
        // can always reactivate (and never lock themselves out). Rides the same per-request read (join, no
        // extra round-trip).
        if (u.tenantSuspended && !isPlatformAdmin(payload.sub)) throw new ForbiddenException({ code: 'TENANT_SUSPENDED', message: 'This company is suspended — contact the administrator', messageTh: 'บริษัทนี้ถูกระงับการใช้งาน — โปรดติดต่อผู้ดูแลระบบ' });
        if (u.tvf && payload.iat && payload.iat * 1000 < new Date(u.tvf).getTime()) throw revoked;
        // ITGC-AC-02/03 — trust the LIVE DB role, not the role baked into the (possibly stale or forged)
        // token. The RLS bypass decision (TenantTxInterceptor) and PermissionsGuard both read req.user.role;
        // sourcing it from the DB here means a role downgraded after the token was issued (e.g. Admin→Sales)
        // immediately loses HQ bypass, and a forged role claim for a non-privileged username can't grant it.
        // This rides the existing AC-15 per-request user read — no extra round-trip.
        dbRole = u.role as string;
        // Hybrid tenancy (0196) — the org an Admin is scoped to under TENANCY_MODE=multi-company. Sourced
        // live from the DB (same row) so a forged org claim can't widen an Admin's bypass.
        dbOrgId = u.orgId != null ? Number(u.orgId) : null;
        // ITGC-AC-18 / security review L-3 — trust the LIVE DB tenant_id, not the token claim (which was the
        // only identity field still sourced from the JWT, asymmetric with role/orgId). A stale or forged
        // tenantId claim can no longer point a staff session at another tenant. Rides this same per-request
        // read (no extra round-trip). NULL = a global/HQ staff account (kept as null).
        dbTenantId = u.tenantId != null ? Number(u.tenantId) : null;
        // SME single-user edition (docs/49) — the tenant's control profile, sourced LIVE from the same
        // tenants join (no extra round-trip). assertMakerChecker treats anything but 'sme' as
        // 'enterprise' (fail-closed), so members / API keys / HQ accounts never relax maker-checker.
        dbControlProfile = u.controlProfile === 'sme' ? 'sme' : u.controlProfile === 'enterprise' ? 'enterprise' : null;
        // ITGC-AC-07 / docs/27 R0-3 — must_change_password is a HARD gate, not a UI hint: a seeded or
        // admin-reset credential can reach nothing but the change-password/logout/me endpoints until the
        // password is rotated. Rides the same per-request row read (no extra round-trip).
        if (u.mcp) {
          const path = String(req.url ?? '').split('?')[0];
          const allowed = ['/api/auth/change-password', '/api/auth/logout', '/api/auth/me', '/api/auth/refresh'];
          if (!allowed.includes(path!)) {
            throw new ForbiddenException({ code: 'PASSWORD_CHANGE_REQUIRED', message: 'Password change required before using the system', messageTh: 'ต้องเปลี่ยนรหัสผ่านก่อนใช้งานระบบ' });
          }
        }
        // 4.4 — hard privileged-MFA enrolment gate (ENFORCE_PRIVILEGED_MFA, default off). A privileged role
        // that has not enrolled TOTP can reach nothing but the MFA-setup/logout/me/change-password endpoints
        // until it enrols. Mirrors the must_change_password gate; rides this same per-request row read.
        if (requiresMfaEnrollment({ enforce: enforcePrivilegedMfa(), mfaEnabled: !!u.mfaEnabled, role: (dbRole as Role), path: String(req.url ?? '').split('?')[0]! })) {
          throw new ForbiddenException({ code: 'MFA_ENROLLMENT_REQUIRED', message: 'Two-factor authentication must be set up before using the system', messageTh: 'ต้องตั้งค่ายืนยันตัวตนสองชั้น (MFA) ก่อนใช้งานระบบ' });
        }
      } else {
        // Round-2 AUD-SEC NEW-3: a STAFF token whose users row no longer exists (hard delete) must not
        // be honored on its stale claims until expiry — the deactivation/tokensValidFrom checks above
        // can't run without a row. Member principals never reach here (caught by the member branch).
        throw new UnauthorizedException({ code: 'USER_NOT_FOUND', message: 'Account no longer exists', messageTh: 'บัญชีนี้ถูกลบแล้ว' });
      }
    }
    req.user = {
      username: payload.sub,
      role: (dbRole ?? payload.role) as JwtUser['role'],
      customerName: payload.customerName ?? null,
      // Staff: the live DB tenant_id (dbTenantId is set whenever the users row was read, incl. null for a
      // global account). Members (no users row) keep their token's tenantId claim. (security review L-3)
      tenantId: dbTenantId !== undefined ? dbTenantId : (payload.tenantId ?? null),
      orgId: dbOrgId,
      permissions: payload.permissions ?? [],
      memberId: payload.memberId ?? null, // loyalty member principal (role==='Member'); null for staff
      controlProfile: dbControlProfile,
    } satisfies JwtUser;
    return true;
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

// Restricts @PlatformAdmin() routes to a configured PLATFORM owner (PLATFORM_ADMIN_USERNAMES) — a
// cross-tenant operator distinct from a per-tenant 'Admin'. Runs AFTER JwtAuthGuard (so req.user is set)
// and BEFORE the TenantTxInterceptor, so on success it sets the server-only req.__platformBypass flag the
// interceptor honours to grant an RLS bypass (needed to provision a brand-new tenant). Empty config ⇒ every
// such route 403s (secure by default). The flag is set server-side here, never read from client input.
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const needs = this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!needs) return true;
    const req = ctx.switchToHttp().getRequest();
    const user: JwtUser | undefined = req.user;
    if (!isPlatformAdmin(user?.username)) {
      throw new ForbiddenException({ code: 'PLATFORM_ADMIN_REQUIRED', message: 'Platform-admin access required', messageTh: 'ต้องเป็นผู้ดูแลแพลตฟอร์มเท่านั้น' });
    }
    req.__platformBypass = true; // honoured by TenantTxInterceptor to bypass RLS for tenant provisioning
    return true;
  }
}
