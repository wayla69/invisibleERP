import { Controller, Get, Post, Patch, Put, Param, Query, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Public, Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { CrmPipelineService } from './crm-pipeline.service';

const LeadBody = z.object({ name: z.string().min(1), company: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), source: z.string().optional(), owner: z.string().optional(), notes: z.string().optional() });
const ConvertBody = z.object({ opportunity_name: z.string().optional(), amount: z.number().nonnegative().optional(), expected_close_date: z.string().optional(), customer_no: z.string().optional() });
const ReasonBody = z.object({ reason: z.string().optional() });
const OppBody = z.object({ name: z.string().min(1), customer_no: z.string().optional(), amount: z.number().nonnegative().optional(), probability: z.number().int().min(0).max(100).optional(), expected_close_date: z.string().optional(), owner: z.string().optional(), account_no: z.string().optional(), primary_contact_id: z.number().int().optional() });
const StageBody = z.object({ stage: z.string().min(1), lost_reason: z.string().optional(), win_reason: z.string().optional(), probability: z.number().int().min(0).max(100).optional() });
const ActivityBody = z.object({ entity_type: z.enum(['lead', 'opportunity']), entity_no: z.string().min(1), type: z.enum(['call', 'email', 'meeting', 'note', 'task']), subject: z.string().optional(), notes: z.string().optional(), due_date: z.string().optional(), done: z.boolean().optional() });
// CRM-7 kanban depth (control CRM-13): a stage playbook (WIP limit + required-field exit criteria + guidance)
// and a bulk stage move. wip_limit null clears the cap; required_fields is whitelist-validated service-side.
const PlaybookBody = z.object({ wip_limit: z.number().int().min(0).max(100000).nullable().optional(), required_fields: z.array(z.string().max(60)).max(20).optional(), guidance: z.string().max(2000).nullable().optional() });
const BulkStageBody = z.object({ opp_nos: z.array(z.string().min(1)).min(1).max(100), stage: z.string().min(1), lost_reason: z.string().optional(), win_reason: z.string().optional(), probability: z.number().int().min(0).max(100).optional() });
const ActivityDoneBody = z.object({ done: z.boolean() });
const LeadImportBody = z.object({
  format: z.enum(['rows', 'csv', 'xlsx']).optional(),
  rows: z.array(z.record(z.any())).max(5000).optional(),
  csv: z.string().max(2_000_000).optional(),
  xlsx: z.string().max(13_000_000).optional(),
  dry_run: z.boolean().optional(),
});
// CRM-4 automation bodies.
const AssignBody = z.object({ owner: z.string().max(60).optional() });
const FollowupSettingsBody = z.object({
  sla_hours: z.number().int().min(1).max(720).optional(),
  rotting_days: z.number().int().min(1).max(365).optional(),
  round_robin_owners: z.array(z.string().max(60)).max(50).optional(),
});
const CommsBody = z.object({
  channel: z.enum(['email', 'line', 'sms']),
  to: z.string().max(200).optional(),
  subject: z.string().max(300).optional(),
  body: z.string().min(1).max(5000),
  contact_id: z.number().int().optional(),
});

// Public website form (CRM-2). `website` is the HONEYPOT field — humans never see it (hidden input); a
// filled value means a bot, which the controller drops silently with the same { ok: true } response shape.
const WebToLeadBody = z.object({
  name: z.string().min(1).max(200), company: z.string().max(200).optional(), email: z.string().max(200).optional(),
  phone: z.string().max(60).optional(), message: z.string().max(2000).optional(), source: z.string().max(60).optional(),
  tenant_code: z.string().max(30).optional(), website: z.string().max(300).optional(),
});

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

  // CRM-4 lead scoring (explainable, versioned grade A–D). GET reads (scores on first read); POST re-scores.
  @Get('leads/:leadNo/score') leadScore(@Param('leadNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.getLeadScore(no, u); }
  @Post('leads/:leadNo/score') @HttpCode(200) rescoreLead(@Param('leadNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.scoreLead(no, u); }
  // CRM-4 round-robin (re)assignment — explicit owner wins, else rotate the configured owners.
  @Post('leads/:leadNo/assign') @HttpCode(200) assignLead(@Param('leadNo') no: string, @Body(new ZodValidationPipe(AssignBody)) b: { owner?: string }, @CurrentUser() u: JwtUser) { return this.svc.assignLead(no, b, u); }

  // Bulk lead import (CRM-2 wizard) — csv / base64 xlsx / rows; dry_run validates without writing.
  @Post('leads/import') @HttpCode(200) importLeads(@Body(new ZodValidationPipe(LeadImportBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.importLeads(b, u); }
  @Get('leads/import/template') importTemplate() {
    const headers = [...CrmPipelineService.LEAD_IMPORT_HEADERS];
    return { headers, required: ['Name'], csv: headers.join(',') + '\r\n' };
  }

  // Opportunities
  @Post('opportunities') createOpp(@Body(new ZodValidationPipe(OppBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createOpportunity(b, u); }
  @Get('opportunities') listOpps(@Query('stage') stage: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listOpportunities(stage, u); }
  @Patch('opportunities/:oppNo/stage') @HttpCode(200) setStage(@Param('oppNo') no: string, @Body(new ZodValidationPipe(StageBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setStage(no, b.stage, b, u); }
  // CRM-7 bulk stage move — move a board multi-select through the SAME governed setStage path; per-item result.
  @Post('opportunities/bulk-stage') @HttpCode(200) bulkStage(@Body(new ZodValidationPipe(BulkStageBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.bulkSetStage(b, u); }
  // CRM-7 stage playbooks — the board reads the WIP limits / required-field exit criteria / guidance + live
  // open counts; a supervisor (crm/exec) configures one stage's playbook.
  @Get('playbooks') playbooks(@CurrentUser() u: JwtUser) { return this.svc.listPlaybooks(u); }
  @Put('playbooks/:stageId') @Permissions('crm', 'exec') putPlaybook(@Param('stageId') id: string, @Body(new ZodValidationPipe(PlaybookBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.putPlaybook(Number(id), b, u); }
  // Stage-transition audit trail (crm_stage_history, CRM-1) — REV-17 evidence for one deal.
  @Get('opportunities/:oppNo/history') stageHistory(@Param('oppNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.stageHistory(no, u); }
  // Deal detail (CRM-2 workspace): opp + account/contact + stage history + activities + linked CPQ quotes.
  @Get('opportunities/:oppNo') getOpp(@Param('oppNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.getOpportunity(no, u); }

  // Pipeline forecast
  @Get('summary') summary(@CurrentUser() u: JwtUser) { return this.svc.pipelineSummary(u); }

  // Win/loss analytics (loss reasons, by owner, monthly trend) for the pipeline dashboard.
  @Get('win-loss') winLoss(@Query('months') months: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.winLoss(u, { months: months ? Number(months) : undefined }); }

  // CRM-5 "why" analytics — read-only aggregators, all date-bounded server-side (months, default 6, 1..24).
  // Funnel conversion (lead→qualified→won) + stage-to-stage progression + time-in-stage velocity.
  @Get('analytics/funnel') funnel(@Query('months') months: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.funnel(u, { months: months ? Number(months) : undefined }); }
  // Lead source → won revenue (win rate + average deal size per channel).
  @Get('analytics/source-roi') sourceRoi(@Query('months') months: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.sourceRoi(u, { months: months ? Number(months) : undefined }); }
  // Forecast categories (commit/best-case/pipeline) + quota attainment per owner + activity leaderboard.
  @Get('analytics/forecast') forecast(@Query('months') months: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.forecast(u, { months: months ? Number(months) : undefined }); }

  // Activities
  @Post('activities') logActivity(@Body(new ZodValidationPipe(ActivityBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.logActivity(b, u); }
  @Get('activities') listActivities(@Query('entity_type') et: string | undefined, @Query('entity_no') en: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listActivities(et, en, u); }
  @Patch('activities/:id/done') @HttpCode(200) setActivityDone(@Param('id') id: string, @Body(new ZodValidationPipe(ActivityDoneBody)) b: { done: boolean }, @CurrentUser() u: JwtUser) { return this.svc.setActivityDone(+id, b.done, u); }

  // CRM-4 follow-up discipline — the detective-control worklist (REV-22) + config + digest sweep.
  @Get('follow-up') followUp(@Query('sla_hours') sla: string | undefined, @Query('rotting_days') rot: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.followUpCenter(u, { sla_hours: sla != null ? Number(sla) : undefined, rotting_days: rot != null ? Number(rot) : undefined });
  }
  @Post('follow-up/run') @HttpCode(200) runFollowUp(@CurrentUser() u: JwtUser) { return this.svc.runFollowUpSweep(u); }
  @Get('follow-up/settings') followUpSettings(@CurrentUser() u: JwtUser) { return this.svc.getFollowupSettings(u); }
  // Changing SLA / rotting thresholds / round-robin owners is a supervisor duty (crm/exec only).
  @Put('follow-up/settings') @Permissions('crm', 'exec') putFollowUpSettings(@Body(new ZodValidationPipe(FollowupSettingsBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.putFollowupSettings(b, u); }

  // CRM-4 sales comms from the deal timeline (email / LINE / SMS via messaging, merge fields).
  @Get('comms/merge-fields') mergeFields() { return this.svc.mergeFields(); }
  @Post('opportunities/:oppNo/comms') @HttpCode(200) sendComms(@Param('oppNo') no: string, @Body(new ZodValidationPipe(CommsBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.sendComms(no, b, u); }
}

// Public website lead capture (CRM-2). No JWT — the anonymous visitor posts the embedded contact form.
// Abuse controls: a dedicated strict per-IP edge rate-limit bucket (common/edge.ts), body size caps, and a
// honeypot field (`website`) dropped SILENTLY with the identical { ok: true } shape so a bot cannot tell.
@Controller('api/crm/web-to-lead')
export class CrmWebToLeadController {
  constructor(private readonly svc: CrmPipelineService) {}

  @Public() @Post() @HttpCode(200)
  capture(@Body(new ZodValidationPipe(WebToLeadBody)) b: any) {
    if (typeof b.website === 'string' && b.website.trim() !== '') return { ok: true }; // honeypot — drop, don't tell
    return this.svc.webToLead(b);
  }
}
