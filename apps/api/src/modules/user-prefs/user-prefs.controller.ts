import { Controller, Get, Put, Body } from '@nestjs/common';
import { z } from 'zod';
import { UserPrefsService } from './user-prefs.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

// Personal UI preferences — no @Permissions: every authenticated user may read/write their OWN prefs
// (the service scopes by username, RLS by tenant). The customer portal does not call this.
const UpdateBody = z.object({
  favorites: z.array(z.string().min(1).max(200)).max(100).optional(),
  navFold: z.record(z.boolean()).optional(),
});

@Controller('api/user-prefs')
export class UserPrefsController {
  constructor(private readonly svc: UserPrefsService) {}

  @Get()
  get(@CurrentUser() user: JwtUser) {
    return this.svc.get(user);
  }

  @Put()
  update(@Body(new ZodValidationPipe(UpdateBody)) dto: z.infer<typeof UpdateBody>, @CurrentUser() user: JwtUser) {
    return this.svc.update(dto, user);
  }
}
