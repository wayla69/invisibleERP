import { Controller, Get, Post, Body, Query, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { ProfitabilityService } from './profitability.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

const CreateSegmentBody = z.object({ segment_type: z.string().min(1), code: z.string().min(1), name: z.string().min(1) });
const CreateRuleBody = z.object({
  name: z.string().min(1), from_account_code: z.string().min(1), to_segment_type: z.string().min(1),
  driver: z.string().optional(),
  weights: z.array(z.object({ segment_code: z.string().min(1), weight: z.number() })).optional(),
});
const RunAllocationBody = z.object({ period: z.string().min(1) });

@Controller('api/profitability')
export class ProfitabilityController {
  constructor(private readonly svc: ProfitabilityService) {}

  @Get('segments')
  @Permissions('exec')
  listSegments(@Query('type') type: string | undefined, @CurrentUser() user: JwtUser) {
    return this.svc.listSegments(type, user);
  }

  @Post('segments')
  @Permissions('masterdata')
  createSegment(@Body(new ZodValidationPipe(CreateSegmentBody)) dto: z.infer<typeof CreateSegmentBody>, @CurrentUser() user: JwtUser) {
    return this.svc.createSegment(dto, user);
  }

  @Get('rules')
  @Permissions('exec')
  listRules(@CurrentUser() user: JwtUser) {
    return this.svc.listRules(user);
  }

  @Post('rules')
  @Permissions('masterdata')
  createRule(@Body(new ZodValidationPipe(CreateRuleBody)) dto: z.infer<typeof CreateRuleBody>, @CurrentUser() user: JwtUser) {
    return this.svc.createRule(dto, user);
  }

  @Post('run')
  @Permissions('exec')
  @HttpCode(200)
  runAllocation(@Body(new ZodValidationPipe(RunAllocationBody)) dto: z.infer<typeof RunAllocationBody>, @CurrentUser() user: JwtUser) {
    return this.svc.runAllocation(dto, user);
  }

  @Get('report')
  @Permissions('exec')
  report(@Query('period') period: string, @Query('segment_type') segmentType: string | undefined, @CurrentUser() user: JwtUser) {
    return this.svc.profitabilityReport({ period, segment_type: segmentType }, user);
  }
}
