import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RewardsService } from './rewards.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RewardBody = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1),
  type: z.enum(['evoucher', 'discount', 'product', 'privilege']).default('evoucher'),
  point_cost: z.number().positive(),
  cash_value: z.number().nonnegative().optional(),
  coupon_kind: z.enum(['percent', 'amount', 'free_item']).optional(),
  coupon_value: z.number().nonnegative().optional(),
  stock: z.number().int().nonnegative().optional(),
  per_member_limit: z.number().int().positive().optional(),
  tier_min: z.number().nonnegative().optional(),
  valid_from: ymd.optional(),
  valid_to: ymd.optional(),
  image_key: z.string().optional(),
  active: z.boolean().optional(),
});
const RewardActiveBody = z.object({ active: z.boolean() });
const RedeemBody = z.object({ member_id: z.number().int().positive() });
const UseBody = z.preprocess((v) => v ?? {}, z.object({ sale_no: z.string().optional() }));
const CouponIssueBody = z.object({
  member_id: z.number().int().positive(),
  kind: z.enum(['percent', 'amount', 'free_item']),
  value: z.number().nonnegative(),
  source: z.string().optional(),
  expires_at: z.string().optional(),
});
const ListQuery = z.object({ active: z.coerce.boolean().optional() });

@Controller('api/loyalty')
export class RewardsController {
  constructor(private readonly svc: RewardsService) {}

  // ── Catalog ──
  @Get('rewards') @Permissions('loyalty', 'marketing', 'pos')
  list(@Query(new ZodValidationPipe(ListQuery)) q: any, @CurrentUser() u: JwtUser) { return this.svc.listRewards(u, q); }
  @Post('rewards') @Permissions('crm_reward', 'marketing', 'exec')
  upsert(@Body(new ZodValidationPipe(RewardBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.upsertReward(u, b); }
  @Patch('rewards/:id') @Permissions('crm_reward', 'marketing', 'exec')
  setActive(@Param('id') id: string, @Body(new ZodValidationPipe(RewardActiveBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setRewardActive(u, +id, b.active); }

  // ── Redeem (burn points → single-use code) ──
  @Post('rewards/:id/redeem') @Permissions('loyalty', 'pos')
  redeem(@Param('id') id: string, @Body(new ZodValidationPipe(RedeemBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.redeemReward(u, +id, b); }
  // ── Use a redemption code at POS (single-use; segregated from catalog config) ──
  @Post('redemptions/:code/use') @Permissions('pos', 'pos_sell', 'order_mgt')
  use(@Param('code') code: string, @Body(new ZodValidationPipe(UseBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.useRedemption(u, code, b); }

  // ── Member wallet ──
  @Get('members/:id/wallet') @Permissions('loyalty', 'marketing', 'crm', 'pos')
  wallet(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.wallet(u, +id); }

  // ── Coupons ──
  @Post('coupons/issue') @Permissions('crm_reward', 'marketing', 'exec')
  issueCoupon(@Body(new ZodValidationPipe(CouponIssueBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.issueCoupon(u, b); }
  @Post('coupons/:code/redeem') @Permissions('pos', 'pos_sell', 'order_mgt')
  redeemCoupon(@Param('code') code: string, @Body(new ZodValidationPipe(UseBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.redeemCoupon(u, code, b); }
}
