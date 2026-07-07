import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Inject, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq, desc } from 'drizzle-orm';
import { permissionsForSuites, resolveEntitledSuites, isPermissionEntitled, type Permission, type SuiteKey } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { subscriptions, plans } from '../../database/schema';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, isPlatformAdmin, type JwtUser } from '../../common/decorators';
import { PLAN_FEATURE_KEY } from './plan-feature.decorator';
import { REQUIRES_SUITE_KEY } from './requires-suite.decorator';

// ── Rollout modes (Wave 1 · 1.2) ────────────────────────────────────────────────────────────────
// Suite-based plan gating is DEFAULT-OFF so it never breaks an existing tenant. Three states:
//   • ENTITLEMENTS_ENFORCE=true → gate @Permissions tokens by the tenant's entitled suites (block).
//   • else ENTITLEMENTS_SHADOW=true → evaluate + log what WOULD be blocked, but never block (rollout dry-run).
//   • else (both off, the default) → LEGACY behaviour, byte-for-byte identical to before 1.2.
// Both flags default false. Backfill plan rows (1.3) BEFORE enabling ENTITLEMENTS_ENFORCE.
const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
export function entitlementsEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has(String(env.ENTITLEMENTS_ENFORCE ?? '').trim().toLowerCase());
}
export function entitlementsShadow(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has(String(env.ENTITLEMENTS_SHADOW ?? '').trim().toLowerCase());
}

// Enforces subscription plan gates. Runs after JwtAuthGuard + PlatformAdminGuard + PermissionsGuard +
// ModuleEnabledGuard. When ENTITLEMENTS_ENFORCE is on it gates the route's @Permissions token(s) against
// the tenant's entitled SUITES (403 SUITE_NOT_ENTITLED) and, additionally, any @RequiresPlanFeature flag
// (403 PLAN_FEATURE_REQUIRED). The per-tenant `Admin` bypass is REMOVED — only the platform owner (god)
// bypasses. Consistent with ModuleEnabledGuard: an infra error fails OPEN (a DB blip must never lock out a
// paying tenant), but successfully-read missing data fails CLOSED to ALWAYS_ON suites.
@Injectable()
export class PlanGuard implements CanActivate {
  private readonly logger = new Logger('PlanGuard');

  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const user: JwtUser | undefined = req.user;
    const feature = this.reflector.getAllAndOverride<string>(PLAN_FEATURE_KEY, [ctx.getHandler(), ctx.getClass()]);
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]) ?? [];
    const reqSuite = this.reflector.getAllAndOverride<SuiteKey>(REQUIRES_SUITE_KEY, [ctx.getHandler(), ctx.getClass()]);

    const enforce = entitlementsEnforced();
    const shadow = entitlementsShadow();

    // ── LEGACY path (default): identical behaviour to pre-1.2. Suite gating is not evaluated at all unless
    //    shadow/enforce is enabled, so there is zero added DB cost and zero behaviour change by default. ──
    if (!enforce && !shadow) {
      if (!feature) return true; // route not gated by a plan feature
      if (!user || user.role === 'Admin' || !user.tenantId) return true;
      return this.legacyFeatureCheck(user.tenantId, feature);
    }

    // ── SHADOW / ENFORCE path ──
    // God (platform owner) always bypasses. A per-tenant Admin does NOT (this is the 1.2 fix).
    const isGod = isPlatformAdmin(user?.username) || req.__platformBypass === true;
    if (!user || isGod || !user.tenantId) return true;

    // Nothing to gate on this route.
    if (!feature && required.length === 0 && !reqSuite) return true;

    let row: { features: unknown; status: string | null; trialEndsAt: Date | null; planCode: string | null } | undefined;
    try {
      [row] = await this.db
        .select({
          features: plans.features,
          status: subscriptions.status,
          trialEndsAt: subscriptions.trialEndsAt,
          planCode: subscriptions.planCode,
        })
        .from(subscriptions)
        .leftJoin(plans, eq(subscriptions.planCode, plans.code))
        .where(eq(subscriptions.tenantId, user.tenantId))
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);
    } catch (e) {
      // Infra error → fail OPEN (never lock out a paying tenant over a DB blip).
      this.logger.warn(`plan check DB error (fail-open) tenant=${user.tenantId}: ${(e as Error)?.message ?? e}`);
      return true;
    }

    // Trialing within window → grant everything (all suites). Expired → block.
    if (row?.status === 'Trialing') {
      const expired = row.trialEndsAt && Date.now() > new Date(row.trialEndsAt).getTime();
      if (!expired) return true;
      return this.decide(shadow, enforce, () => new ForbiddenException({
        code: 'TRIAL_EXPIRED',
        message: 'Your free trial has ended. Please upgrade your plan to continue.',
        messageTh: 'ช่วงทดลองใช้งานสิ้นสุดแล้ว กรุณาอัปเกรดแพ็กเกจเพื่อใช้งานต่อ',
      }), user.tenantId, 'TRIAL_EXPIRED', required);
    }
    if (row?.status === 'PastDue' || row?.status === 'Canceled') {
      return this.decide(shadow, enforce, () => new ForbiddenException({
        code: 'SUBSCRIPTION_INACTIVE',
        message: `Subscription is ${row!.status}. Please update your billing to restore access.`,
        messageTh: 'การสมัครสมาชิกไม่ได้ใช้งาน กรุณาตรวจสอบการชำระเงิน',
      }), user.tenantId, 'SUBSCRIPTION_INACTIVE', required);
    }

    // Active (or no row → fail CLOSED to ALWAYS_ON via resolveEntitledSuites's fallback).
    const features = (row?.features as Record<string, unknown>) ?? {};
    const entitledSuites = resolveEntitledSuites(row?.planCode ?? null, features.suites);
    const entitledPerms = new Set<Permission>(permissionsForSuites(entitledSuites));

    // Premium/add-on suite gate (@RequiresSuite) — a token-less suite is entitled only if the plan lists it.
    if (reqSuite && !entitledSuites.includes(reqSuite)) {
      return this.decide(shadow, enforce, () => new ForbiddenException({
        code: 'SUITE_NOT_ENTITLED',
        message: `Your current plan does not include this module (${reqSuite}). Please upgrade your plan.`,
        messageTh: 'แพ็กเกจปัจจุบันของคุณไม่รวมโมดูลนี้ กรุณาอัปเกรดแพ็กเกจ',
      }), user.tenantId, 'SUITE_NOT_ENTITLED', [reqSuite as unknown as Permission]);
    }

    // Suite gate: block only when NONE of the route's required tokens is entitled (mirrors ModuleEnabledGuard
    // "shows if ANY passes"). Tokens not in the packaging model (sub-permissions) are treated as entitled.
    if (required.length > 0) {
      const anyEntitled = required.some((p) => isPermissionEntitled(entitledSuites, p) || entitledPerms.has(p));
      if (!anyEntitled) {
        return this.decide(shadow, enforce, () => new ForbiddenException({
          code: 'SUITE_NOT_ENTITLED',
          message: `Your current plan does not include this module (${required.join(', ')}). Please upgrade your plan.`,
          messageTh: 'แพ็กเกจปัจจุบันของคุณไม่รวมโมดูลนี้ กรุณาอัปเกรดแพ็กเกจ',
        }), user.tenantId, 'SUITE_NOT_ENTITLED', required);
      }
    }

    // Legacy explicit feature flag (fail-closed under enforce).
    if (feature && !features[feature]) {
      return this.decide(shadow, enforce, () => new ForbiddenException({
        code: 'PLAN_FEATURE_REQUIRED',
        message: `Your current plan does not include '${feature}'. Please upgrade to access this feature.`,
        messageTh: `แพ็กเกจปัจจุบันของคุณไม่รองรับฟีเจอร์ '${feature}' กรุณาอัปเกรดแพ็กเกจ`,
      }), user.tenantId, 'PLAN_FEATURE_REQUIRED', required);
    }

    return true;
  }

  // Legacy feature check (used only in default off-mode) — verbatim pre-1.2 semantics, incl. fail-open.
  private async legacyFeatureCheck(tenantId: number, feature: string): Promise<boolean> {
    try {
      const [row] = await this.db
        .select({ features: plans.features, status: subscriptions.status, trialEndsAt: subscriptions.trialEndsAt })
        .from(subscriptions)
        .leftJoin(plans, eq(subscriptions.planCode, plans.code))
        .where(eq(subscriptions.tenantId, tenantId))
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);
      if (!row) return true;
      if (row.status === 'Trialing') {
        if (row.trialEndsAt && Date.now() > new Date(row.trialEndsAt).getTime()) {
          throw new ForbiddenException({ code: 'TRIAL_EXPIRED', message: 'Your free trial has ended. Please upgrade your plan to continue.', messageTh: 'ช่วงทดลองใช้งานสิ้นสุดแล้ว กรุณาอัปเกรดแพ็กเกจเพื่อใช้งานต่อ' });
        }
        return true;
      }
      if (row.status === 'PastDue' || row.status === 'Canceled') {
        throw new ForbiddenException({ code: 'SUBSCRIPTION_INACTIVE', message: `Subscription is ${row.status}. Please update your billing to restore access.`, messageTh: 'การสมัครสมาชิกไม่ได้ใช้งาน กรุณาตรวจสอบการชำระเงิน' });
      }
      const features: Record<string, unknown> = (row.features as any) ?? {};
      if (!features[feature]) {
        throw new ForbiddenException({ code: 'PLAN_FEATURE_REQUIRED', message: `Your current plan does not include '${feature}'. Please upgrade to access this feature.`, messageTh: `แพ็กเกจปัจจุบันของคุณไม่รองรับฟีเจอร์ '${feature}' กรุณาอัปเกรดแพ็กเกจ` });
      }
      return true;
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
      return true; // fail-open on infra error
    }
  }

  // In ENFORCE mode: throw the block. In SHADOW mode: log the would-block and allow. Always observable.
  private decide(shadow: boolean, enforce: boolean, mkErr: () => ForbiddenException, tenantId: number, code: string, required: Permission[]): boolean {
    if (enforce) {
      this.logger.warn(`entitlement block ${code} tenant=${tenantId} route-perms=[${required.join(',')}]`);
      throw mkErr();
    }
    // shadow
    this.logger.log(`[shadow] WOULD block ${code} tenant=${tenantId} route-perms=[${required.join(',')}]`);
    return true;
  }
}
