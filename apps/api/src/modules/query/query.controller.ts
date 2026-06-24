import { Controller, Get, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { QueryService } from './query.service';

const RunBody = z.object({
  dimension: z.string().min(1),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  limit: z.number().int().optional(),
});

// Self-service report/pivot builder (Phase 14 — A5) over the governed semantic layer. Read-only, RLS-scoped,
// never posts to the GL. Saved queries reuse the existing /api/saved-views (module='analytics-query').
@Controller('api/query')
export class QueryController {
  constructor(private readonly svc: QueryService) {}

  @Get('model') @Permissions('exec', 'dashboard', 'masterdata')
  model() { return this.svc.model(); }

  @Post('run') @Permissions('exec', 'dashboard', 'masterdata')
  run(@Body(new ZodValidationPipe(RunBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.run(b, u); }
}
