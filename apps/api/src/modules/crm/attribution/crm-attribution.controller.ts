import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { CrmAttributionService, type InfluenceDto } from './crm-attribution.service';

// CRM-15 multi-touch campaign attribution — reads gate crm/exec/ar (same as the other CRM analytics).
const InfluenceBody = z.object({
  campaign_name: z.string().min(1),
  touch_type: z.enum(['lead_source', 'meeting', 'email', 'event', 'webinar', 'content', 'other']).optional(),
  touched_at: z.string().optional(),
  note: z.string().optional(),
});

@Controller('api/crm/attribution')
@Permissions('crm', 'exec', 'ar')
export class CrmAttributionController {
  constructor(private readonly svc: CrmAttributionService) {}

  @Get()
  report(@Query('model') model: string | undefined, @Query('months') months: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.attribution(u, { model, months: months != null ? Number(months) : undefined });
  }

  @Get('opportunity/:oppNo')
  opportunity(@Param('oppNo') oppNo: string) {
    return this.svc.opportunityInfluence(oppNo);
  }

  @Post('opportunity/:oppNo/touch')
  addTouch(@Param('oppNo') oppNo: string, @Body(new ZodValidationPipe(InfluenceBody)) b: InfluenceDto, @CurrentUser() u: JwtUser) {
    return this.svc.addTouch(oppNo, b, u);
  }
}
