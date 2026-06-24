import { Controller, Get, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { LocalizationService } from './localization.service';

const ApplyBody = z.object({ country: z.string().min(2).max(2) });

// C2 (Phase 21) — country localization packs. Applying sets tax country + default locale; no GL.
@Controller('api/localization')
export class LocalizationController {
  constructor(private readonly svc: LocalizationService) {}

  @Get('packs') @Permissions('exec', 'users', 'masterdata') packs() { return this.svc.packs(); }
  @Get() @Permissions('exec', 'users', 'masterdata') get(@CurrentUser() u: JwtUser) { return this.svc.get(u); }

  @Post('apply') @Permissions('exec', 'users', 'masterdata')
  apply(@Body(new ZodValidationPipe(ApplyBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.apply(u, b.country); }
}
