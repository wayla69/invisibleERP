import { Controller, Get, Put, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { LoyaltyService, type LoyaltyConfigDto, type RedeemDto } from './loyalty.service';

const ConfigBody = z.object({
  enabled: z.boolean().optional(),
  points_per_baht: z.number().nonnegative().optional(),
  baht_per_point: z.number().nonnegative().optional(),
  min_redeem: z.number().nonnegative().optional(),
  expiry_days: z.number().int().nonnegative().optional(),
});

const RedeemBody = z.object({ points: z.number().positive() });

@Controller('api/loyalty')
export class LoyaltyController {
  constructor(private readonly svc: LoyaltyService) {}

  @Get('config') @Permissions('loyalty', 'marketing')
  getConfig() { return this.svc.getConfig(); }

  @Put('config') @Permissions('loyalty', 'marketing')
  updateConfig(@Body(new ZodValidationPipe(ConfigBody)) b: LoyaltyConfigDto) { return this.svc.updateConfig(b); }

  @Get('me') @Permissions('loyalty')
  me(@CurrentUser() u: JwtUser) { return this.svc.me(u); }

  @Post('redeem') @Permissions('loyalty')
  redeem(@Body(new ZodValidationPipe(RedeemBody)) b: RedeemDto, @CurrentUser() u: JwtUser) { return this.svc.redeem(b, u); }
}
