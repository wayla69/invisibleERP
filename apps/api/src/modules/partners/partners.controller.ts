import { Controller, Get, Post, Patch, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PartnersService } from './partners.service';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PartnerBody = z.object({ id: z.number().int().positive().optional(), name: z.string().min(1), category: z.string().optional(), contact: z.string().optional(), active: z.boolean().optional() });
const PrivilegeBody = z.object({
  id: z.number().int().positive().optional(),
  partner_id: z.number().int().positive(),
  name: z.string().min(1), description: z.string().optional(),
  kind: z.enum(['discount_percent', 'discount_amount', 'freebie', 'access']).default('discount_percent'),
  value: z.number().nonnegative().optional(),
  tier_min: z.number().int().nonnegative().nullable().optional(),
  stock: z.number().int().nonnegative().nullable().optional(),
  per_member_limit: z.number().int().positive().nullable().optional(),
  valid_from: ymd.optional(), valid_to: ymd.optional(), active: z.boolean().optional(),
});
const ActiveBody = z.object({ active: z.boolean() });
const ClaimBody = z.object({ member_id: z.number().int().positive() });
const UseBody = z.preprocess((v) => v ?? {}, z.object({ partner: z.string().optional() }));

// Partner privileges — member perks at partner merchants. Catalog config is a crm_reward action; claiming is
// a loyalty/POS action; the partner redeems the single-use code (pos_sell). Members self-claim via /api/member.
@Controller('api/loyalty')
export class PartnersController {
  constructor(private readonly svc: PartnersService) {}

  @Get('partners') @Permissions('crm_reward', 'loyalty', 'marketing', 'exec')
  list(@CurrentUser() u: JwtUser, @Query('active') active?: string) { return this.svc.listPartners(u, active === undefined ? {} : { active: active === 'true' }); }
  @Post('partners') @Permissions('crm_reward', 'marketing', 'exec')
  upsertPartner(@Body(new ZodValidationPipe(PartnerBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.upsertPartner(u, b); }
  @Post('privileges') @Permissions('crm_reward', 'marketing', 'exec')
  upsertPrivilege(@Body(new ZodValidationPipe(PrivilegeBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.upsertPrivilege(u, b); }
  @Patch('privileges/:id') @Permissions('crm_reward', 'marketing', 'exec')
  setActive(@Param('id') id: string, @Body(new ZodValidationPipe(ActiveBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setPrivilegeActive(u, +id, b.active); }

  @Post('privileges/:id/claim') @Permissions('loyalty', 'pos', 'crm_member')
  claim(@Param('id') id: string, @Body(new ZodValidationPipe(ClaimBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.claim(u, +id, b); }
  @Post('privilege-claims/:code/use') @Permissions('pos_sell', 'pos', 'order_mgt')
  use(@Param('code') code: string, @Body(new ZodValidationPipe(UseBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.use(u, code, b); }

  @Get('members/:id/privileges') @Permissions('loyalty', 'marketing', 'crm', 'pos')
  available(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.available(u, +id); }
  @Get('members/:id/privilege-claims') @Permissions('loyalty', 'marketing', 'crm', 'pos')
  memberClaims(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.memberClaims(u, +id); }
}
