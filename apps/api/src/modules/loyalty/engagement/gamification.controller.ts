import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { GamificationService } from './gamification.service';

const MissionBody = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1),
  type: z.enum(['stamp', 'quest']).default('stamp'),
  goal: z.number().int().positive().default(1),
  reward_kind: z.enum(['points', 'coupon']).default('points'),
  reward_points: z.number().int().nonnegative().optional(),
  reward_coupon_kind: z.enum(['percent', 'amount', 'free_item']).optional(),
  reward_coupon_value: z.number().nonnegative().optional(),
  period: z.string().optional(),
  active: z.boolean().optional(),
});
const MissionActiveBody = z.object({ active: z.boolean() });
const ProgressBody = z.object({ member_id: z.number().int().positive(), amount: z.number().int().positive().optional() });
const ClaimBody = z.object({ member_id: z.number().int().positive() });
const ListQuery = z.object({ active: z.coerce.boolean().optional() });

@Controller('api/loyalty')
export class GamificationController {
  constructor(private readonly svc: GamificationService) {}

  // ── Mission config ──
  @Get('missions') @Permissions('loyalty', 'marketing', 'exec')
  list(@Query(new ZodValidationPipe(ListQuery)) q: any, @CurrentUser() u: JwtUser) { return this.svc.listMissions(u, q); }
  @Post('missions') @Permissions('crm_campaign', 'marketing', 'exec')
  upsert(@Body(new ZodValidationPipe(MissionBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.upsertMission(u, b); }
  @Patch('missions/:id') @Permissions('crm_campaign', 'marketing', 'exec')
  setActive(@Param('id') id: string, @Body(new ZodValidationPipe(MissionActiveBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setMissionActive(u, +id, b.active); }

  // ── Progress (a stamp at the till) + claim (member/staff) ──
  @Post('missions/:id/progress') @Permissions('pos', 'pos_sell', 'order_mgt', 'loyalty')
  progress(@Param('id') id: string, @Body(new ZodValidationPipe(ProgressBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.addProgress(u, +id, b); }
  @Post('missions/:id/claim') @Permissions('loyalty', 'pos')
  claim(@Param('id') id: string, @Body(new ZodValidationPipe(ClaimBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.claimMission(u, +id, b); }

  // ── A member's missions + progress ──
  @Get('members/:id/missions') @Permissions('loyalty', 'marketing', 'crm', 'pos')
  memberMissions(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.memberMissions(u, +id); }
}
