import { Controller, Get, Put, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { FeatureFlagsService } from './feature-flags.service';

const SetFlagBody = z.object({ enabled: z.boolean() });

// Step 10 — feature flags / Labs. Read is open to any authenticated workspace user (the web shell needs it
// to decide whether to render the Labs nav section); toggling is a config duty (md_config / admin).
@Controller('api/feature-flags')
export class FeatureFlagsController {
  constructor(private readonly svc: FeatureFlagsService) {}

  @Get() @Permissions('dashboard', 'exec', 'md_config', 'pos', 'order_mgt')
  list(@CurrentUser() u: JwtUser) { return this.svc.list(u); }

  @Put(':key') @Permissions('md_config', 'exec')
  setFlag(@Param('key') key: string, @Body(new ZodValidationPipe(SetFlagBody)) b: { enabled: boolean }, @CurrentUser() u: JwtUser) {
    return this.svc.setFlag(key, b.enabled, u);
  }
}
