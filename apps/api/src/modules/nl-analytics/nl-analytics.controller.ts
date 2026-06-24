import { Controller, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { NlAnalyticsService } from './nl-analytics.service';

const AskBody = z.object({ question: z.string().min(1) });

// NL analytics (Phase 17 — B3). Ask in plain language → governed query over the semantic layer. Read-only.
@Controller('api/nl-analytics')
export class NlAnalyticsController {
  constructor(private readonly svc: NlAnalyticsService) {}

  @Post('ask') @Permissions('exec', 'dashboard', 'masterdata')
  ask(@Body(new ZodValidationPipe(AskBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.ask(b.question, u); }
}
