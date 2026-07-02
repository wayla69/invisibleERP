import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import type { JwtUser } from '../../../common/decorators';

// Gate for /api/member/* self-service routes — only a loyalty MEMBER token (role 'Member' + memberId) passes.
// The global JwtAuthGuard already verified the JWT and set req.user (RLS-scoped to the member's tenant); this
// guard just rejects staff/API-key principals so a member route can never be driven by a non-member token.
@Injectable()
export class MemberGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const user = ctx.switchToHttp().getRequest().user as JwtUser | undefined;
    if (!user || user.role !== 'Member' || user.memberId == null) {
      throw new ForbiddenException({ code: 'MEMBER_ONLY', message: 'Member login required', messageTh: 'ต้องเข้าสู่ระบบสมาชิก' });
    }
    return true;
  }
}
