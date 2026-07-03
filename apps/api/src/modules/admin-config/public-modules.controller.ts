import { Controller, Get } from '@nestjs/common';
import { CurrentUser, type JwtUser } from '../../common/decorators';
import { ModuleConfigService } from './module-config.service';

// Authenticated-only (no @Permissions) so EVERY role can learn which of THEIR tenant's modules/menus are
// disabled/ordered and reflect it in their nav — faithful to "hides for all" within the tenant. Read-only;
// the admin write endpoints stay gated under @Permissions('users').
@Controller('api/modules')
export class PublicModulesController {
  constructor(private readonly svc: ModuleConfigService) {}

  @Get('effective')
  effective(@CurrentUser() u: JwtUser) {
    return this.svc.list(u.tenantId);
  }
}
