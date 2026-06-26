import { Controller, Get, Post, Body, Param, HttpCode, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { FxRevalService } from './fx-reval.service';

const RunBody = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM'),
  as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  rates: z.record(z.string(), z.number().positive()).optional(),
  tenant_id: z.number().int().positive().optional(),
});
type RunBodyT = z.infer<typeof RunBody>;

// WS3.2 — Period-end FX revaluation governance (GL-18). run computes the unrealized FX on open
// foreign-currency AR/AP at the closing rate (staged Open); /:id/post is maker-checker (poster ≠ runner).
@Controller('api/ledger/fx-reval')
export class FxRevalController {
  constructor(private readonly svc: FxRevalService) {}

  @Get()
  @Permissions('gl_close', 'gl_post', 'exec')
  list() { return this.svc.list(); }

  @Get(':id')
  @Permissions('gl_close', 'gl_post', 'exec')
  get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Post('run')
  @HttpCode(200)
  @Permissions('gl_close', 'gl_post')
  run(@Body(new ZodValidationPipe(RunBody)) b: RunBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.runReval({ period: b.period, asOfDate: b.as_of_date, rates: b.rates, tenantId: b.tenant_id ?? null, runBy: u.username });
  }

  @Post(':id/post')
  @HttpCode(200)
  @Permissions('gl_close', 'gl_post')
  post(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.svc.postReval({ id, postedBy: u.username });
  }
}
