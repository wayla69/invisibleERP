import { Controller, Get, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ModuleConfigService } from './module-config.service';

const SetModuleBody = z.object({ key: z.string().min(1), enabled: z.boolean() });
type SetModuleBodyT = z.infer<typeof SetModuleBody>;

// Menu visibility: show/hide one or more sidebar entries by href (an array so a category/sub-section master
// toggle updates all its items in one call). Navigation chrome only — never touches permissions/modules.
const SetNavBody = z.object({ hrefs: z.array(z.string().min(1).max(200)).min(1).max(400), enabled: z.boolean() });
type SetNavBodyT = z.infer<typeof SetNavBody>;

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

  // Show/hide sidebar menu entries (does not disable the module/permission — visibility only).
  @Post('nav')
  setNav(@Body(new ZodValidationPipe(SetNavBody)) b: SetNavBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.setNavFlags(b.hrefs, b.enabled, u);
  }
}
