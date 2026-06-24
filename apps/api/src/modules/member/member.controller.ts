import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Public, NoTx, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MemberGuard } from './member.guard';
import { MemberAuthService } from './member-auth.service';
import { MemberService } from '../loyalty/member.service';
import { RewardsService } from '../rewards/rewards.service';
import { GamificationService } from '../gamification/gamification.service';
import { ReferralsService } from '../referrals/referrals.service';
import { WheelsService } from '../wheels/wheels.service';

const RequestOtpBody = z.object({ phone: z.string().min(4), tenant_code: z.string().min(1) });
const VerifyOtpBody = z.object({ phone: z.string().min(4), tenant_code: z.string().min(1), code: z.string().min(4) });
const EmptyBody = z.preprocess((v) => v ?? {}, z.object({}).passthrough());
const ReferBody = z.object({ referred_member_id: z.number().int().positive().optional(), referred_phone: z.string().optional() })
  .refine((d) => d.referred_member_id != null || d.referred_phone, { message: 'referred_member_id or referred_phone required' });

// Member self-service app (phone-OTP). Auth routes are @Public; everything else needs a member token. The
// member can only ever act on THEMSELVES — every call passes req.user.memberId (the authenticated member),
// delegating to the existing (adversarially-reviewed, tenant-scoped) services. There is no member_id param.
@Controller('api/member')
export class MemberController {
  constructor(
    private readonly auth: MemberAuthService,
    private readonly member: MemberService,
    private readonly rewards: RewardsService,
    private readonly missions: GamificationService,
    private readonly referrals: ReferralsService,
    private readonly wheels: WheelsService,
  ) {}

  // ── Auth (public) ──
  @Public() @Post('auth/request-otp')
  requestOtp(@Body(new ZodValidationPipe(RequestOtpBody)) b: any) { return this.auth.requestOtp(b); }
  // @NoTx — runs on the auto-commit base pool so a failed-attempt increment PERSISTS even though the wrong-code
  // path throws 401 (a per-request tx would roll the increment back). Concurrency safety comes from atomic
  // guarded UPDATEs in the service, not a row lock. Tenant isolation is by explicit filter (resolved from code).
  @Public() @NoTx() @Post('auth/verify-otp')
  verifyOtp(@Body(new ZodValidationPipe(VerifyOtpBody)) b: any) { return this.auth.verifyOtp(b); }

  // ── Self-service (member token only; self-scoped) ──
  @Get('me') @UseGuards(MemberGuard)
  me(@CurrentUser() u: JwtUser) { return this.member.balance(u.memberId!, u); }
  @Get('tier') @UseGuards(MemberGuard)
  tier(@CurrentUser() u: JwtUser) { return this.member.tierJourney(u, u.memberId!); }
  @Get('history') @UseGuards(MemberGuard)
  history(@CurrentUser() u: JwtUser) { return this.member.history(u.memberId!, u); }

  @Get('rewards') @UseGuards(MemberGuard)
  rewardsList(@CurrentUser() u: JwtUser) { return this.rewards.listRewards(u, { active: true }); }
  @Post('rewards/:id/redeem') @UseGuards(MemberGuard)
  redeem(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.rewards.redeemReward(u, +id, { member_id: u.memberId! }); }
  @Get('wallet') @UseGuards(MemberGuard)
  wallet(@CurrentUser() u: JwtUser) { return this.rewards.wallet(u, u.memberId!); }

  @Get('missions') @UseGuards(MemberGuard)
  missionsList(@CurrentUser() u: JwtUser) { return this.missions.memberMissions(u, u.memberId!); }
  @Post('missions/:id/claim') @UseGuards(MemberGuard)
  claim(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.missions.claimMission(u, +id, { member_id: u.memberId! }); }

  @Get('wheels') @UseGuards(MemberGuard)
  wheelsList(@CurrentUser() u: JwtUser) { return this.wheels.listWheels(u, { active: true }); }
  @Post('wheels/:id/spin') @UseGuards(MemberGuard)
  spin(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.wheels.spin(u, +id, { member_id: u.memberId! }); }
  @Get('spins') @UseGuards(MemberGuard)
  spinHistory(@CurrentUser() u: JwtUser) { return this.wheels.memberSpins(u, u.memberId!); }

  @Get('referrals') @UseGuards(MemberGuard)
  referralsList(@CurrentUser() u: JwtUser) { return this.referrals.memberReferrals(u, u.memberId!); }
  @Post('refer') @UseGuards(MemberGuard)
  refer(@Body(new ZodValidationPipe(ReferBody)) b: any, @CurrentUser() u: JwtUser) { return this.referrals.createReferral(u, { ...b, referrer_member_id: u.memberId! }); }
}
