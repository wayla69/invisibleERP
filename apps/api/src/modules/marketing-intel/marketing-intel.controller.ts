import { Controller, Get, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MarketingIntelService } from './marketing-intel.service';

const ActivateBody = z.object({
  segment: z.string().min(1).max(80),
  channel: z.enum(['sms', 'email', 'line']).optional(),
  body: z.string().min(1).max(1000).optional(),
});

// Internal read + action surface for the /marketing-intel web page. Gated to the marketing/exec duties
// (the CRM / campaigns audience). The WRITE side (the platform push) is the public API — see
// PublicApiController POST /api/v1/analytics/snapshots (scope analytics:write).
@Controller('api/marketing-intel')
export class MarketingIntelController {
  constructor(private readonly svc: MarketingIntelService) {}

  @Get('summary')
  @Permissions('marketing', 'exec')
  summary(@CurrentUser() u: JwtUser) {
    return this.svc.getSummary(u);
  }

  @Get('mmm-history')
  @Permissions('marketing', 'exec')
  mmmHistory(@CurrentUser() u: JwtUser) {
    return this.svc.getMmmHistory(u);
  }

  @Get('segments')
  @Permissions('marketing', 'exec')
  segments(@CurrentUser() u: JwtUser) {
    return this.svc.segmentCounts(u);
  }

  // Turn a pushed RFM segment into a DRAFT campaign (audience=mi_segment) — the action loop. Gated to the
  // campaign-creating duties (mirrors POST /api/campaigns).
  @Post('segments/activate')
  @Permissions('crm_campaign', 'marketing', 'exec')
  activate(@Body(new ZodValidationPipe(ActivateBody)) b: z.infer<typeof ActivateBody>, @CurrentUser() u: JwtUser) {
    return this.svc.activateSegment(b, u);
  }
}
