import { Controller, Get, Put, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { I18nService } from './i18n.service';

const LocaleBody = z.object({ locale: z.string().min(2).max(8) });

// C1 (Phase 20) — locale framework. Reading + setting one's own locale is universal (self-prefs, no perm
// gate, like the notification inbox); setting the tenant default needs an admin permission.
@Controller('api/i18n')
export class I18nController {
  constructor(private readonly svc: I18nService) {}

  @Get('locales') locales() { return this.svc.locales(); }
  @Get('me') me(@CurrentUser() u: JwtUser) { return this.svc.resolveMe(u); }
  @Put('me') setMe(@Body(new ZodValidationPipe(LocaleBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setMe(u, b.locale); }

  @Put('tenant-default') @Permissions('users', 'exec')
  setDefault(@Body(new ZodValidationPipe(LocaleBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setTenantDefault(u, b.locale); }
}
