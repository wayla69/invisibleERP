import { Controller, Get, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ModuleConfigService } from './module-config.service';

const SetModuleBody = z.object({ key: z.string().min(1), enabled: z.boolean() });
type SetModuleBodyT = z.infer<typeof SetModuleBody>;

// Admin-only. 'users' is ALWAYS_ON, so this page is always reachable.
@Controller('api/admin/modules')
@Permissions('users')
export class ModuleConfigController {
  constructor(private readonly svc: ModuleConfigService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  set(@Body(new ZodValidationPipe(SetModuleBody)) b: SetModuleBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.setFlag(b.key, b.enabled, u);
  }
}
