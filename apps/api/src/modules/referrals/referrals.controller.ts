import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ReferralsService } from './referrals.service';

const ReferBody = z.object({
  referrer_member_id: z.number().int().positive(),
  referred_member_id: z.number().int().positive().optional(),
  referred_phone: z.string().optional(),
  referrer_points: z.number().int().nonnegative().optional(),
  referred_points: z.number().int().nonnegative().optional(),
}).refine((d) => d.referred_member_id != null || d.referred_phone, { message: 'referred_member_id or referred_phone required' });
const EmptyBody = z.preprocess((v) => v ?? {}, z.object({}).passthrough());

@Controller('api/loyalty')
export class ReferralsController {
  constructor(private readonly svc: ReferralsService) {}

  // Create a referral (a member refers another, by member id or phone).
  @Post('referrals') @Permissions('loyalty', 'marketing', 'pos')
  refer(@Body(new ZodValidationPipe(ReferBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createReferral(u, b); }
  // Reward both sides — once (a marketing/loyalty action; like the mission-claim grant).
  @Post('referrals/:id/reward') @Permissions('loyalty', 'marketing')
  reward(@Param('id') id: string, @Body(new ZodValidationPipe(EmptyBody)) _b: any, @CurrentUser() u: JwtUser) { return this.svc.rewardReferral(u, +id); }
  // A member's referrals (as referrer).
  @Get('members/:id/referrals') @Permissions('loyalty', 'marketing', 'crm', 'pos')
  memberReferrals(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.memberReferrals(u, +id); }
}
