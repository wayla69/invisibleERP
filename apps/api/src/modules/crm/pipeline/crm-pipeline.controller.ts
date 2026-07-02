import { Controller, Get, Post, Patch, Param, Query, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { CrmPipelineService } from './crm-pipeline.service';

const LeadBody = z.object({ name: z.string().min(1), company: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), source: z.string().optional(), owner: z.string().optional(), notes: z.string().optional() });
const ConvertBody = z.object({ opportunity_name: z.string().optional(), amount: z.number().nonnegative().optional(), expected_close_date: z.string().optional(), customer_no: z.string().optional() });
const ReasonBody = z.object({ reason: z.string().optional() });
const OppBody = z.object({ name: z.string().min(1), customer_no: z.string().optional(), amount: z.number().nonnegative().optional(), probability: z.number().int().min(0).max(100).optional(), expected_close_date: z.string().optional(), owner: z.string().optional() });
const StageBody = z.object({ stage: z.string().min(1), lost_reason: z.string().optional(), probability: z.number().int().min(0).max(100).optional() });
const ActivityBody = z.object({ entity_type: z.enum(['lead', 'opportunity']), entity_no: z.string().min(1), type: z.enum(['call', 'email', 'meeting', 'note', 'task']), subject: z.string().optional(), notes: z.string().optional(), due_date: z.string().optional(), done: z.boolean().optional() });

// CRM sales pipeline (REV-17) — leads → opportunities (stage machine) → activities, on the customer-of-record.
@Controller('api/crm/pipeline')
@Permissions('crm', 'exec', 'ar')
export class CrmPipelineController {
  constructor(private readonly svc: CrmPipelineService) {}

  // Leads
  @Post('leads') createLead(@Body(new ZodValidationPipe(LeadBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createLead(b, u); }
  @Get('leads') listLeads(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listLeads(status, u); }
  @Post('leads/:leadNo/qualify') @HttpCode(200) qualify(@Param('leadNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.qualifyLead(no, u); }
  @Post('leads/:leadNo/convert') convert(@Param('leadNo') no: string, @Body(new ZodValidationPipe(ConvertBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.convertLead(no, b, u); }
  @Post('leads/:leadNo/lose') @HttpCode(200) lose(@Param('leadNo') no: string, @Body(new ZodValidationPipe(ReasonBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.loseLead(no, b?.reason, u); }

  // Opportunities
  @Post('opportunities') createOpp(@Body(new ZodValidationPipe(OppBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createOpportunity(b, u); }
  @Get('opportunities') listOpps(@Query('stage') stage: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listOpportunities(stage, u); }
  @Patch('opportunities/:oppNo/stage') @HttpCode(200) setStage(@Param('oppNo') no: string, @Body(new ZodValidationPipe(StageBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setStage(no, b.stage, b, u); }

  // Pipeline forecast
  @Get('summary') summary(@CurrentUser() u: JwtUser) { return this.svc.pipelineSummary(u); }

  // Win/loss analytics (loss reasons, by owner, monthly trend) for the pipeline dashboard.
  @Get('win-loss') winLoss(@Query('months') months: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.winLoss(u, { months: months ? Number(months) : undefined }); }

  // Activities
  @Post('activities') logActivity(@Body(new ZodValidationPipe(ActivityBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.logActivity(b, u); }
  @Get('activities') listActivities(@Query('entity_type') et: string | undefined, @Query('entity_no') en: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listActivities(et, en, u); }
}
