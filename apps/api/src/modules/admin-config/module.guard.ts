import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY, type JwtUser } from '../../common/decorators';
import { ModuleConfigService } from './module-config.service';

// Enforces PER-TENANT module enable/disable. A route gated by @Permissions(p…) is blocked (403
// MODULE_DISABLED) when ALL of its modules are disabled FOR THE CALLER'S TENANT — mirroring the nav-hiding
// (a nav item shows if ANY of its perms passes). Faithful to "hides for all" within the tenant: even Admin
// is blocked, but ALWAYS_ON modules (e.g. users) can never be disabled, so admins always retain access to
// re-enable. Runs AFTER JwtAuthGuard so req.user (hence tenantId) is set; reads the disabled set via the
// service's explicit-tenant-filter path (guards run before the RLS tx). Fail-open on infra error.
@Injectable()
export class ModuleEnabledGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly svc: ModuleConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required || required.length === 0) return true; // public / ungated
    try {
      const tenantId = (ctx.switchToHttp().getRequest().user as JwtUser | undefined)?.tenantId ?? null;
      const disabled = await this.svc.disabledSet(tenantId);
      if (disabled.size === 0) return true;
      const anyEnabled = required.some((p) => !disabled.has(p));
      if (!anyEnabled) {
        throw new ForbiddenException({ code: 'MODULE_DISABLED', message: `Module disabled: ${required.join(',')}`, messageTh: 'โมดูลนี้ถูกปิดใช้งานโดยผู้ดูแลระบบ' });
      }
      return true;
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
      return true; // never fail-closed on a config-read error
    }
  }
}
