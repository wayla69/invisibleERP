import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { WorkflowService } from './workflow.service';

const StepBody = z.object({ step_no: z.number().int().positive(), approver_role: z.string().optional(), approver_user: z.string().optional(), min_amount: z.number().nonnegative().optional(), all_of_n: z.number().int().positive().optional(), name: z.string().optional() });
const DefinitionBody = z.object({ doc_type: z.string().min(1), name: z.string().min(1), steps: z.array(StepBody).min(1) });
const ActiveBody = z.object({ active: z.boolean() });
const ActBody = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().optional() });
const DelegationBody = z.object({ to_user: z.string().min(1), from_date: z.string().min(1), to_date: z.string().min(1) });

@Controller('api/workflow')
export class WorkflowController {
  constructor(private readonly svc: WorkflowService) {}

  @Post('definitions') @Permissions('masterdata')
  createDefinition(@Body(new ZodValidationPipe(DefinitionBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createDefinition(b, u); }
  @Get('definitions') @Permissions('masterdata', 'approvals')
  listDefinitions(@CurrentUser() u: JwtUser) { return this.svc.listDefinitions(u); }
  @Patch('definitions/:id') @Permissions('masterdata')
  setDefinitionActive(@Param('id') id: string, @Body(new ZodValidationPipe(ActiveBody)) b: { active: boolean }, @CurrentUser() u: JwtUser) { return this.svc.setDefinitionActive(+id, b.active, u); }

  @Get('my-approvals') @Permissions('approvals')
  myApprovals(@CurrentUser() u: JwtUser) { return this.svc.myApprovals(u); }
  @Post('instances/:id/act') @Permissions('approvals')
  act(@Param('id') id: string, @Body(new ZodValidationPipe(ActBody)) b: { decision: 'approve' | 'reject'; comment?: string }, @CurrentUser() u: JwtUser) { return this.svc.act(+id, b, u); }
  @Get('instances/:id') @Permissions('approvals', 'exec')
  instance(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.getInstance(+id, u); }

  @Post('delegations') @Permissions('approvals')
  createDelegation(@Body(new ZodValidationPipe(DelegationBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createDelegation(b, u); }
  @Get('delegations') @Permissions('approvals')
  listDelegations(@CurrentUser() u: JwtUser) { return this.svc.listDelegations(u); }
  @Delete('delegations/:id') @Permissions('approvals')
  revokeDelegation(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.revokeDelegation(+id, u); }
}
