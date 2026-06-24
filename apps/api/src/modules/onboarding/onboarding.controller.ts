import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { OnboardingService } from './onboarding.service';

const ApplyBody = z.object({ pack: z.string().min(1) });

// E1 (Phase 26) — onboarding checklist + industry packs. Applying a pack seeds custom objects (reuses A1);
// never posts to the GL.
@Controller('api/onboarding')
export class OnboardingController {
  constructor(private readonly svc: OnboardingService) {}

  @Get() @Permissions('users', 'exec', 'dashboard')
  status(@CurrentUser() u: JwtUser) { return this.svc.status(u); }

  @Get('packs') @Permissions('users', 'exec', 'dashboard')
  packs() { return this.svc.packs(); }

  @Post('apply-pack') @Permissions('users', 'exec', 'masterdata')
  apply(@Body(new ZodValidationPipe(ApplyBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.applyPack(u, b.pack); }

  @Post('steps/:key/complete') @Permissions('users', 'exec', 'dashboard')
  complete(@Param('key') key: string, @CurrentUser() u: JwtUser) { return this.svc.completeStep(u, key); }

  @Post('steps/:key/reset') @Permissions('users', 'exec')
  reset(@Param('key') key: string, @CurrentUser() u: JwtUser) { return this.svc.resetStep(u, key); }
}
