import { Controller, Get } from '@nestjs/common';
import { ModuleConfigService } from './module-config.service';

// Authenticated-only (no @Permissions) so EVERY role can learn which modules are
// disabled and hide them from their nav — faithful to "hides for all". Read-only;
// the admin write endpoint stays gated under @Permissions('users').
@Controller('api/modules')
export class PublicModulesController {
  constructor(private readonly svc: ModuleConfigService) {}

  @Get('effective')
  effective() {
    return this.svc.list();
  }
}
