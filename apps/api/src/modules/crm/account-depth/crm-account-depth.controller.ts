import { Controller, Get, Post, Patch, Delete, Param, Query, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { CrmAccountDepthService, ParentBody, CommitteeBody, PlanBody, PlanUpdateBody } from './crm-account-depth.service';

// docs/46 Phase 5 — split VERBATIM out of the single-file crm-account-depth.module.ts (service/controller/
// module convention; no DI or behaviour change).
// Same gate as the rest of the B2B CRM surface (crm | exec | ar). Account-plan create/edit/lifecycle and
// committee edits are ordinary CRM sales work — no separate control duty.
@Controller('api/crm')
@Permissions('crm', 'exec', 'ar')
export class CrmAccountDepthController {
  constructor(private readonly svc: CrmAccountDepthService) {}

  // Hierarchy
  @Patch('accounts/:accountNo/parent')
  setParent(@Param('accountNo') no: string, @Body(new ZodValidationPipe(ParentBody)) b: z.infer<typeof ParentBody>, @CurrentUser() u: JwtUser) { return this.svc.setParent(no, b.parent_account_no ?? null, u); }
  @Get('accounts/:accountNo/hierarchy')
  hierarchy(@Param('accountNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.hierarchy(no, u); }
  @Get('accounts/:accountNo/whitespace')
  whitespace(@Param('accountNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.whitespace(no, u); }

  // Buying committee
  @Post('opportunities/:oppNo/committee')
  addCommittee(@Param('oppNo') no: string, @Body(new ZodValidationPipe(CommitteeBody)) b: z.infer<typeof CommitteeBody>, @CurrentUser() u: JwtUser) { return this.svc.addCommitteeMember(no, b, u); }
  @Get('opportunities/:oppNo/committee')
  listCommittee(@Param('oppNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.listCommittee(no, u); }
  @Delete('opportunities/:oppNo/committee/:contactId')
  removeCommittee(@Param('oppNo') no: string, @Param('contactId') contactId: string, @CurrentUser() u: JwtUser) { return this.svc.removeCommitteeMember(no, +contactId, u); }

  // Account plans
  @Post('account-plans') createPlan(@Body(new ZodValidationPipe(PlanBody)) b: z.infer<typeof PlanBody>, @CurrentUser() u: JwtUser) { return this.svc.createPlan(b, u); }
  @Get('account-plans') listPlans(@Query('account_no') accountNo: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listPlans({ account_no: accountNo }, u); }
  @Get('account-plans/:planNo') getPlan(@Param('planNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.getPlan(no, u); }
  @Patch('account-plans/:planNo') updatePlan(@Param('planNo') no: string, @Body(new ZodValidationPipe(PlanUpdateBody)) b: z.infer<typeof PlanUpdateBody>, @CurrentUser() u: JwtUser) { return this.svc.updatePlan(no, b, u); }
  @Post('account-plans/:planNo/activate') @HttpCode(200) activatePlan(@Param('planNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.activatePlan(no, u); }
  @Post('account-plans/:planNo/close') @HttpCode(200) closePlan(@Param('planNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.closePlan(no, u); }
}
