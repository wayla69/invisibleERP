import { Controller, Get, Post, Put, Param, Body, UseGuards, HttpCode, Res, Req } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Public, NoTx, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { setAuthCookies, clearAuthCookies, readCookie, AUTH_COOKIE } from '../../common/cookies';
import { MemberGuard } from './member.guard';
import { MemberAuthService } from './member-auth.service';
import { MemberService } from '../loyalty/member.service';
import { RewardsService } from '../rewards/rewards.service';
import { GamificationService } from '../gamification/gamification.service';
import { ReferralsService } from '../referrals/referrals.service';
import { WheelsService } from '../wheels/wheels.service';
import { PartnersService } from '../partners/partners.service';

const RequestOtpBody = z.object({ phone: z.string().min(4), tenant_code: z.string().min(1) });
const VerifyOtpBody = z.object({ phone: z.string().min(4), tenant_code: z.string().min(1), code: z.string().min(4) });
const EmptyBody = z.preprocess((v) => v ?? {}, z.object({}).passthrough());
const ReferBody = z.object({ referred_member_id: z.number().int().positive().optional(), referred_phone: z.string().optional() })
  .refine((d) => d.referred_member_id != null || d.referred_phone, { message: 'referred_member_id or referred_phone required' });
const LineLoginBody = z.object({ tenant_code: z.string().min(1), id_token: z.string().min(1) });
const LinkLineBody = z.object({ id_token: z.string().min(1) });
// PDPA: a member managing their OWN consent. `purpose` e.g. 'marketing' | 'analytics' | 'transactional'.
const MemberConsentBody = z.object({ purpose: z.string().min(1), granted: z.boolean(), channel: z.string().optional() });

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
    private readonly partners: PartnersService,
  ) {}

  // ── Auth (public) ──
  @Public() @Post('auth/request-otp')
  requestOtp(@Body(new ZodValidationPipe(RequestOtpBody)) b: any) { return this.auth.requestOtp(b); }
  // @NoTx — runs on the auto-commit base pool so a failed-attempt increment PERSISTS even though the wrong-code
  // path throws 401 (a per-request tx would roll the increment back). Concurrency safety comes from atomic
  // guarded UPDATEs in the service, not a row lock. Tenant isolation is by explicit filter (resolved from code).
  @Public() @NoTx() @Post('auth/verify-otp')
  async verifyOtp(@Body(new ZodValidationPipe(VerifyOtpBody)) b: any, @Res({ passthrough: true }) reply: FastifyReply) {
    const res = await this.auth.verifyOtp(b);
    // Deliver the member JWT as an httpOnly cookie (+ readable CSRF) so it is unreachable from JS — XSS on the
    // consumer /m surface can't exfiltrate it. The token is ALSO returned in the body for non-browser clients
    // (LINE LIFF native / scripts) — backward compatible.
    setAuthCookies(reply, res.token);
    return res;
  }
  // LINE LIFF login — verify the LIFF idToken (prod) → mint a member token for the linked member.
  @Public() @NoTx() @Post('auth/line')
  async loginLine(@Body(new ZodValidationPipe(LineLoginBody)) b: any, @Res({ passthrough: true }) reply: FastifyReply) {
    const res = await this.auth.loginWithLine(b);
    setAuthCookies(reply, res.token);
    return res;
  }
  // Clear the member session cookie. @Public so it always succeeds (even with an expired/absent token); it
  // only ever clears the caller's own cookies. Revokes the presented token (jti denylist) so it can't be
  // replayed before its 7-day expiry. @NoTx → the denylist insert auto-commits outside any tenant tx.
  @Public() @NoTx() @Post('auth/logout') @HttpCode(200)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ ok: true }> {
    const authz = req.headers['authorization'];
    const bearer = typeof authz === 'string' && authz.startsWith('Bearer ') ? authz.slice(7) : undefined;
    await this.auth.revokeToken(bearer ?? readCookie(req, AUTH_COOKIE));
    clearAuthCookies(reply);
    return { ok: true };
  }

  // ── Self-service (member token only; self-scoped) ──
  @Get('me') @UseGuards(MemberGuard)
  me(@CurrentUser() u: JwtUser) { return this.member.balance(u.memberId!, u); }
  // Link the member's LINE account (one LINE ↔ one member per tenant) so they can later log in via LINE.
  @Post('link-line') @UseGuards(MemberGuard)
  linkLine(@Body(new ZodValidationPipe(LinkLineBody)) b: any, @CurrentUser() u: JwtUser) { return this.auth.linkLine(u, b.id_token); }
  @Get('tier') @UseGuards(MemberGuard)
  tier(@CurrentUser() u: JwtUser) { return this.member.tierJourney(u, u.memberId!); }
  @Get('history') @UseGuards(MemberGuard)
  history(@CurrentUser() u: JwtUser) { return this.member.history(u.memberId!, u); }

  // PDPA data-subject self-service: a member views and updates their OWN consents (scoped to u.memberId — a
  // member can never read/alter another member's). Delegates to the same getConsents/setConsent the staff
  // CRM uses; source='self' distinguishes a self-managed change from a staff/admin one in the audit trail.
  @Get('consents') @UseGuards(MemberGuard)
  myConsents(@CurrentUser() u: JwtUser) { return this.member.getConsents(u.memberId!, u); }
  @Put('consents') @UseGuards(MemberGuard)
  setMyConsent(@Body(new ZodValidationPipe(MemberConsentBody)) b: z.infer<typeof MemberConsentBody>, @CurrentUser() u: JwtUser) {
    return this.member.setConsent(u.memberId!, { purpose: b.purpose, granted: b.granted, channel: b.channel, source: 'self' }, u);
  }

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

  @Get('privileges') @UseGuards(MemberGuard)
  privileges(@CurrentUser() u: JwtUser) { return this.partners.available(u, u.memberId!); }
  @Post('privileges/:id/claim') @UseGuards(MemberGuard)
  claimPrivilege(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.partners.claim(u, +id, { member_id: u.memberId! }); }
  @Get('privilege-claims') @UseGuards(MemberGuard)
  privilegeClaims(@CurrentUser() u: JwtUser) { return this.partners.memberClaims(u, u.memberId!); }

  @Get('referrals') @UseGuards(MemberGuard)
  referralsList(@CurrentUser() u: JwtUser) { return this.referrals.memberReferrals(u, u.memberId!); }
  @Post('refer') @UseGuards(MemberGuard)
  refer(@Body(new ZodValidationPipe(ReferBody)) b: any, @CurrentUser() u: JwtUser) { return this.referrals.createReferral(u, { ...b, referrer_member_id: u.memberId! }); }
}
