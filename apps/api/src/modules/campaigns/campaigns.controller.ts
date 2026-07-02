import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, NoTx, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CampaignsService } from './campaigns.service';

const CampaignBody = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1),
  channel: z.enum(['sms', 'email', 'line']).default('sms'),
  audience: z.enum(['all', 'segment', 'tier', 'birthdays_today', 'saved_segment']).default('all'),
  segment: z.string().optional(),
  tier: z.string().optional(),
  saved_segment_id: z.number().int().positive().optional(),
  body: z.string().min(1),
  schedule_at: z.string().datetime().optional(),
});

// Campaign orchestration — segmented + scheduled broadcasts. Config + send are marketing/exec actions
// (segregated from POS/finance). Scheduled campaigns also fire from the daily maintenance sweep.
@Controller('api/loyalty')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get('campaigns') @Permissions('loyalty', 'marketing', 'exec')
  list(@CurrentUser() u: JwtUser, @Query('status') status?: string) { return this.campaigns.listCampaigns(u, status ? { status } : {}); }
  @Post('campaigns') @Permissions('crm_campaign', 'marketing', 'exec')
  upsert(@Body(new ZodValidationPipe(CampaignBody)) b: any, @CurrentUser() u: JwtUser) { return this.campaigns.upsertCampaign(u, b); }
  // @NoTx — gateway delivery is irreversible, so the send must NOT sit inside a request tx that could roll
  // back and re-fire it. The service claims (commits) the campaign 'sent' before delivering. See the service.
  @Post('campaigns/run-due') @NoTx() @Permissions('marketing', 'exec')
  runDue(@CurrentUser() u: JwtUser) { return this.campaigns.runDueAll(u); }
  @Post('campaigns/:id/send') @NoTx() @Permissions('crm_campaign', 'marketing', 'exec')
  send(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.campaigns.sendCampaign(u, +id); }
  @Post('campaigns/:id/cancel') @Permissions('marketing', 'exec')
  cancel(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.campaigns.cancelCampaign(u, +id); }
}
