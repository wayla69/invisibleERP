import { Controller, Get, Post, Patch, Put, Delete, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { WorkflowService } from './workflow.service';

const StepBody = z.object({ step_no: z.number().int().positive(), approver_role: z.string().optional(), approver_user: z.string().optional(), min_amount: z.number().nonnegative().optional(), all_of_n: z.number().int().positive().optional(), name: z.string().optional(), sla_hours: z.number().int().positive().optional(), escalate_to_role: z.string().optional(), escalate_to_user: z.string().optional(), match_key: z.string().optional(), match_value: z.string().optional() });
const DefinitionBody = z.object({ doc_type: z.string().min(1), name: z.string().min(1), sla_hours: z.number().int().positive().optional(), steps: z.array(StepBody).min(1) });
const UpdateDefinitionBody = z.object({ name: z.string().optional(), sla_hours: z.number().int().positive().optional(), steps: z.array(StepBody).min(1).optional() });
const ActiveBody = z.object({ active: z.boolean() });
const ActBody = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().optional(), self_approval_reason: z.string().max(500).optional() });
const DelegationBody = z.object({ to_user: z.string().min(1), from_date: z.string().min(1), to_date: z.string().min(1) });

@Controller('api/workflow')
export class WorkflowController {
  constructor(private readonly svc: WorkflowService) {}

  @Post('definitions') @Permissions('masterdata')
  createDefinition(@Body(new ZodValidationPipe(DefinitionBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createDefinition(b, u); }
  @Get('definitions') @Permissions('masterdata', 'approvals')
  listDefinitions(@CurrentUser() u: JwtUser) { return this.svc.listDefinitions(u); }
  // Control-integrity readiness (maker-checker audit, cross-cutting): reports which engine-wired docTypes
  // (PR/PO/BUDGET/PMR/BQR) lack an active approval workflow and therefore currently auto-approve.
  @Get('readiness') @Permissions('masterdata', 'approvals', 'exec')
  readiness(@CurrentUser() u: JwtUser) { return this.svc.readiness(u); }
  @Patch('definitions/:id') @Permissions('masterdata')
  setDefinitionActive(@Param('id') id: string, @Body(new ZodValidationPipe(ActiveBody)) b: { active: boolean }, @CurrentUser() u: JwtUser) { return this.svc.setDefinitionActive(+id, b.active, u); }
  @Put('definitions/:id') @Permissions('masterdata')
  updateDefinition(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateDefinitionBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.updateDefinition(+id, b, u); }

  // SLA / escalation sweep — cron-callable (flags overdue instances + reminds the escalation approver)
  @Post('run-escalations') @Permissions('masterdata', 'exec', 'approvals')
  runEscalations(@CurrentUser() u: JwtUser) { return this.svc.runEscalations(u); }

  @Get('my-approvals') @Permissions('approvals')
  myApprovals(@CurrentUser() u: JwtUser) { return this.svc.myApprovals(u); }
  @Post('instances/:id/act') @Permissions('approvals')
  act(@Param('id') id: string, @Body(new ZodValidationPipe(ActBody)) b: { decision: 'approve' | 'reject'; comment?: string; self_approval_reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.act(+id, b, u); }
  @Get('instances/:id') @Permissions('approvals', 'exec')
  instance(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.getInstance(+id, u); }

  @Post('delegations') @Permissions('approvals')
  createDelegation(@Body(new ZodValidationPipe(DelegationBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createDelegation(b, u); }
  @Get('delegations') @Permissions('approvals')
  listDelegations(@CurrentUser() u: JwtUser) { return this.svc.listDelegations(u); }
  @Delete('delegations/:id') @Permissions('approvals')
  revokeDelegation(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.revokeDelegation(+id, u); }
}
