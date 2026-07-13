import { Controller, Get, Post, Patch, Param, Query, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { CrmAccountHealthService, DealTypeBody } from './crm-account-health.service';

// docs/46 Phase 5 — split VERBATIM out of the single-file crm-account-health.module.ts (service/controller/
// module convention; no DI or behaviour change).
@Controller('api/crm')
@Permissions('crm', 'exec', 'ar')
export class CrmAccountHealthController {
  constructor(private readonly svc: CrmAccountHealthService) {}

  @Get('account-health') portfolio(@Query('band') band: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.portfolio({ band }, u); }
  @Get('account-health/renewals') renewals(@CurrentUser() u: JwtUser) { return this.svc.renewalPipeline(u); }
  @Post('account-health/snapshot') @HttpCode(200) @Permissions('crm', 'exec') snapshot(@CurrentUser() u: JwtUser) { return this.svc.captureAllHealth(u); }
  @Get('accounts/:accountNo/health') health(@Param('accountNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.accountHealth(no, u); }
  @Get('accounts/:accountNo/health/history') history(@Param('accountNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.healthHistory(no, u); }
  @Patch('opportunities/:oppNo/deal-type') dealType(@Param('oppNo') no: string, @Body(new ZodValidationPipe(DealTypeBody)) b: z.infer<typeof DealTypeBody>, @CurrentUser() u: JwtUser) { return this.svc.setDealType(no, b.deal_type, u); }
}
