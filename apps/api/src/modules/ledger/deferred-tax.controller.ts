import { Controller, Get, Post, Body, Param, HttpCode, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { DeferredTaxService } from './deferred-tax.service';

const RunBody = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM'),
  as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tax_rate: z.number().positive().max(1).optional(),
  tax_dep_factor: z.number().positive().optional(),
  tenant_id: z.number().int().positive().optional(),
});
type RunBodyT = z.infer<typeof RunBody>;

// WS3.2 — Deferred tax (TAS 12, TAX-06). run computes DTA/DTL from book-vs-tax temporary differences
// (staged Open); /:id/post is maker-checker (poster ≠ runner) and posts the period delta to 1700/5950.
@Controller('api/ledger/deferred-tax')
export class DeferredTaxController {
  constructor(private readonly svc: DeferredTaxService) {}

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
    return this.svc.runDeferredTax({ period: b.period, asOfDate: b.as_of_date, taxRate: b.tax_rate, taxDepFactor: b.tax_dep_factor, tenantId: b.tenant_id ?? null, runBy: u.username });
  }

  @Post(':id/post')
  @HttpCode(200)
  @Permissions('gl_close', 'gl_post')
  post(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.postDeferredTax({ id, postedBy: u.username }, u, b?.self_approval_reason);
  }
}
