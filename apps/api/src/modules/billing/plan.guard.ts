import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { subscriptions, plans } from '../../database/schema';
import { IS_PUBLIC_KEY, type JwtUser } from '../../common/decorators';
import { PLAN_FEATURE_KEY } from './plan-feature.decorator';

// Enforces subscription plan feature gates. Runs after JwtAuthGuard + PermissionsGuard +
// ModuleEnabledGuard. Any route decorated with @RequiresPlanFeature(feature) is checked
// against the tenant's active subscription; the request is blocked when the feature is not
// included in their plan. Consistent with ModuleEnabledGuard: fail-open on infra errors so
// a database blip never locks out a paying tenant.
@Injectable()
export class PlanGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;

    // Read the required plan feature from route/class metadata.
    const feature = this.reflector.getAllAndOverride<string>(PLAN_FEATURE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!feature) return true; // route not gated by a plan feature

    // @Public routes bypass all guards including this one.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const user: JwtUser | undefined = req.user;

    // HQ Admin principal (role=Admin) is the cross-tenant super-admin — keyed the same way as the
    // RLS "sees all" bypass. It has no subscription of its own (it may be stamped with the HQ tenant
    // id rather than null), so plan gating never applies. Also allow a principal with no tenant at all.
    if (!user || user.role === 'Admin' || !user.tenantId) return true;

    try {
      const db = this.db;
      const [row] = await db
        .select({
          features: plans.features,
          status: subscriptions.status,
          trialEndsAt: subscriptions.trialEndsAt,
        })
        .from(subscriptions)
        .leftJoin(plans, eq(subscriptions.planCode, plans.code))
        .where(eq(subscriptions.tenantId, user.tenantId))
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);

      // No subscription row at all → provisioning-in-progress / legacy data. Fail-open, consistent
      // with BillingService.checkUserLimit and this guard's own "never lock out a tenant over a
      // billing-data gap" philosophy. A real Free-tier tenant HAS a row (features.ai_chat=false) and
      // is still correctly blocked below via PLAN_FEATURE_REQUIRED.
      if (!row) return true;

      // Trialing: grant full access while still in the trial window.
      if (row.status === 'Trialing') {
        if (row.trialEndsAt && Date.now() > new Date(row.trialEndsAt).getTime()) {
          throw new ForbiddenException({
            code: 'TRIAL_EXPIRED',
            message: 'Your free trial has ended. Please upgrade your plan to continue.',
            messageTh: 'ช่วงทดลองใช้งานสิ้นสุดแล้ว กรุณาอัปเกรดแพ็กเกจเพื่อใช้งานต่อ',
          });
        }
        return true; // within trial window — grant all features
      }

      if (row.status === 'PastDue' || row.status === 'Canceled') {
        throw new ForbiddenException({
          code: 'SUBSCRIPTION_INACTIVE',
          message: `Subscription is ${row.status}. Please update your billing to restore access.`,
          messageTh: 'การสมัครสมาชิกไม่ได้ใช้งาน กรุณาตรวจสอบการชำระเงิน',
        });
      }

      // Active subscription: check whether the plan's features JSONB includes the required key.
      const features: Record<string, unknown> = (row.features as any) ?? {};
      const allowed = features[feature];

      if (!allowed) {
        throw new ForbiddenException({
          code: 'PLAN_FEATURE_REQUIRED',
          message: `Your current plan does not include '${feature}'. Please upgrade to access this feature.`,
          messageTh: `แพ็กเกจปัจจุบันของคุณไม่รองรับฟีเจอร์ '${feature}' กรุณาอัปเกรดแพ็กเกจ`,
        });
      }

      return true;
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
      // Fail-open: a DB error on the plan check must never lock out a paying tenant.
      return true;
    }
  }
}
