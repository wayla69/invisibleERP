import { Controller, Get, Put, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { DeveloperService } from './developer.service';

const TierBody = z.object({ tier: z.string().min(1) });

// D1 (Phase 23) — developer portal over the shipped public API v1. Key management is `users`-gated (mirrors
// /api/platform/api-keys). Read-only except the tier setter.
// 0451 — the developer portal is the 'Dedicated Sandbox/Staging' add-on suite (franchise/enterprise
// include it; others buy it à la carte). Inert unless ENTITLEMENTS_ENFORCE is on.
@RequiresSuite('sandbox')
@Controller('api/developer')
export class DeveloperController {
  constructor(private readonly svc: DeveloperService) {}

  @Get('portal') @Permissions('users')
  portal(@CurrentUser() u: JwtUser) { return this.svc.portal(u); }

  @Put('keys/:id/tier') @Permissions('users')
  setTier(@Param('id') id: string, @Body(new ZodValidationPipe(TierBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setTier(u, +id, b.tier); }
}
