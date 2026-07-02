import { Controller, Get, Post, Patch, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { WheelsService } from './wheels.service';

const Segment = z.object({
  label: z.string().min(1),
  prize_kind: z.enum(['points', 'coupon', 'none']).default('none'),
  prize_points: z.number().int().min(0).optional(),
  coupon_kind: z.enum(['percent', 'amount', 'free_item']).optional(),
  coupon_value: z.number().min(0).optional(),
  weight: z.number().int().min(0).default(1),
  stock: z.number().int().min(0).nullable().optional(),
});
const WheelBody = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1),
  cost_points: z.number().int().min(0).optional(),
  daily_free_spins: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
  segments: z.array(Segment).min(1),
});
const ActiveBody = z.object({ active: z.boolean() });
const SpinBody = z.object({ member_id: z.number().int().positive() });

// Back-office spin-the-wheel config + an operator-driven spin (e.g. at the till). Config is marketing/exec;
// spinning is a POS/loyalty action. Members spin themselves via /api/member/wheels/:id/spin.
@Controller('api/loyalty')
export class WheelsController {
  constructor(private readonly wheels: WheelsService) {}

  @Get('wheels') @Permissions('loyalty', 'marketing', 'exec')
  list(@CurrentUser() u: JwtUser, @Query('active') active?: string) {
    return this.wheels.listWheels(u, active === undefined ? {} : { active: active === 'true' });
  }
  @Post('wheels') @Permissions('crm_campaign', 'marketing', 'exec')
  upsert(@Body(new ZodValidationPipe(WheelBody)) b: any, @CurrentUser() u: JwtUser) { return this.wheels.upsertWheel(u, b); }
  @Patch('wheels/:id') @Permissions('crm_campaign', 'marketing', 'exec')
  setActive(@Param('id') id: string, @Body(new ZodValidationPipe(ActiveBody)) b: any, @CurrentUser() u: JwtUser) { return this.wheels.setWheelActive(u, +id, b.active); }
  @Post('wheels/:id/spin') @Permissions('pos_sell', 'pos', 'loyalty')
  spin(@Param('id') id: string, @Body(new ZodValidationPipe(SpinBody)) b: any, @CurrentUser() u: JwtUser) { return this.wheels.spin(u, +id, b); }
  @Get('members/:id/spins') @Permissions('loyalty', 'marketing', 'crm', 'pos')
  memberSpins(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.wheels.memberSpins(u, +id); }
}
