import { Controller, Get, Put, Post, Patch, Param, Query, Body } from '@nestjs/common';
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
const bday = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const EnrollBody = z.object({ name: z.string().optional(), phone: z.string().optional(), card_no: z.string().optional(), email: z.string().optional(), birthday: bday.optional(), marketing_opt_in: z.boolean().optional() })
  .refine((d) => d.phone || d.card_no, { message: 'phone or card_no required' });
const UpdateMemberBody = z.object({ name: z.string().optional(), phone: z.string().optional(), email: z.string().optional(), birthday: bday.nullable().optional(), marketing_opt_in: z.boolean().optional(), tier: z.string().optional(), active: z.boolean().optional() });
const EnrollLineBody = z.object({ id_token: z.string().min(1), name: z.string().optional(), phone: z.string().optional(), marketing_opt_in: z.boolean().optional() });
const LinkLineBody = z.object({ id_token: z.string().min(1) });

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
  // Enrol or return a member from a verified LINE identity (LIFF / LINE Login id token). Idempotent.
  @Post('members/enroll-line') @Permissions('loyalty', 'pos')
  enrollLine(@Body(new ZodValidationPipe(EnrollLineBody)) b: any, @CurrentUser() u: JwtUser) { return this.member.enrollViaLine(b, u); }
  // Link a verified LINE identity to an existing member.
  @Post('members/:id/link-line') @Permissions('loyalty', 'pos')
  linkLine(@Param('id') id: string, @Body(new ZodValidationPipe(LinkLineBody)) b: { id_token: string }, @CurrentUser() u: JwtUser) { return this.member.linkLine(+id, b.id_token, u); }
  @Get('members/lookup') @Permissions('loyalty', 'pos')
  lookup(@Query('phone') phone: string | undefined, @Query('card') card: string | undefined, @Query('code') code: string | undefined, @Query('line_user_id') lineUserId: string | undefined, @CurrentUser() u: JwtUser) { return this.member.lookup({ phone, card, code, line_user_id: lineUserId }, u); }
  @Get('members/birthdays') @Permissions('loyalty', 'marketing', 'crm')
  birthdays(@Query('window') window: string | undefined, @CurrentUser() u: JwtUser) { return this.member.birthdays(window === 'today' ? 'today' : 'month', u); }
  @Patch('members/:id') @Permissions('loyalty', 'pos')
  update(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateMemberBody)) b: any, @CurrentUser() u: JwtUser) { return this.member.update(+id, b, u); }
  @Get('members/:id') @Permissions('loyalty', 'pos')
  getMember(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.member.balance(+id, u); }
  @Get('members/:id/history') @Permissions('loyalty', 'pos')
  history(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.member.history(+id, u); }
}
