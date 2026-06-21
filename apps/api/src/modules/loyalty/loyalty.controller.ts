import { Controller, Get, Put, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { LoyaltyService, type LoyaltyConfigDto, type RedeemDto } from './loyalty.service';
import { MemberService } from './member.service';

const ConfigBody = z.object({
  enabled: z.boolean().optional(),
  points_per_baht: z.number().nonnegative().optional(),
  baht_per_point: z.number().nonnegative().optional(),
  min_redeem: z.number().nonnegative().optional(),
  expiry_days: z.number().int().nonnegative().optional(),
});

const RedeemBody = z.object({ points: z.number().positive() });
const EnrollBody = z.object({ name: z.string().optional(), phone: z.string().optional(), card_no: z.string().optional(), email: z.string().optional() })
  .refine((d) => d.phone || d.card_no, { message: 'phone or card_no required' });

@Controller('api/loyalty')
export class LoyaltyController {
  constructor(private readonly svc: LoyaltyService, private readonly member: MemberService) {}

  @Get('config') @Permissions('loyalty', 'marketing')
  getConfig() { return this.svc.getConfig(); }

  @Put('config') @Permissions('loyalty', 'marketing')
  updateConfig(@Body(new ZodValidationPipe(ConfigBody)) b: LoyaltyConfigDto) { return this.svc.updateConfig(b); }

  @Get('me') @Permissions('loyalty')
  me(@CurrentUser() u: JwtUser) { return this.svc.me(u); }

  @Post('redeem') @Permissions('loyalty')
  redeem(@Body(new ZodValidationPipe(RedeemBody)) b: RedeemDto, @CurrentUser() u: JwtUser) { return this.svc.redeem(b, u); }

  // ── POS members (สมาชิก/แต้มที่จุดขาย) ──
  @Post('members') @Permissions('loyalty', 'pos')
  enroll(@Body(new ZodValidationPipe(EnrollBody)) b: any, @CurrentUser() u: JwtUser) { return this.member.enroll(b, u); }
  @Get('members/lookup') @Permissions('loyalty', 'pos')
  lookup(@Query('phone') phone: string | undefined, @Query('card') card: string | undefined, @Query('code') code: string | undefined, @CurrentUser() u: JwtUser) { return this.member.lookup({ phone, card, code }, u); }
  @Get('members/:id') @Permissions('loyalty', 'pos')
  getMember(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.member.balance(+id, u); }
  @Get('members/:id/history') @Permissions('loyalty', 'pos')
  history(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.member.history(+id, u); }
}
