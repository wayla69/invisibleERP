import { Controller, Get, Post, Body, Param, HttpCode, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { TaxProvisionService } from './tax-provision.service';

const RunBody = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fiscal_year: z.number().int().min(2000).max(2100).optional(),
  statutory_rate: z.number().positive().max(1).optional(),
  permanent_diffs: z.array(z.object({ name: z.string().min(1), amount: z.number() })).optional(),
  valuation_allowance: z.number().optional(),
  rate_change_effect: z.number().optional(),
  other_adjustments: z.number().optional(),
  link_deferred: z.boolean().optional(),
  tenant_id: z.number().int().positive().optional(),
});
type RunBodyT = z.infer<typeof RunBody>;

// TAX-11 — Current income-tax provision + ETR reconciliation (ASC 740 / IAS 12, current side). run computes
// pretax → taxable → current CIT (staged Open); /:id/post is maker-checker (poster ≠ runner) and posts
// Dr 5960 / Cr 2110. /:id/etr returns the statutory→effective reconciliation schedule. Gated on the finance
// close/post duties (reuses gl_close/gl_post/exec — no new permission).
@Controller('api/tax/provision')
export class TaxProvisionController {
  constructor(private readonly svc: TaxProvisionService) {}

  @Get()
  @Permissions('gl_close', 'gl_post', 'exec')
  list() { return this.svc.list(); }

  @Get(':id')
  @Permissions('gl_close', 'gl_post', 'exec')
  get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Get(':id/etr')
  @Permissions('gl_close', 'gl_post', 'exec')
  etr(@Param('id', ParseIntPipe) id: number) { return this.svc.etr(id); }

  @Post('run')
  @HttpCode(200)
  @Permissions('gl_close', 'gl_post')
  run(@Body(new ZodValidationPipe(RunBody)) b: RunBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.runProvision({
      period: b.period, from: b.from, to: b.to, fiscalYear: b.fiscal_year, statutoryRate: b.statutory_rate,
      permanentDiffs: b.permanent_diffs, valuationAllowance: b.valuation_allowance, rateChangeEffect: b.rate_change_effect,
      otherAdjustments: b.other_adjustments, linkDeferred: b.link_deferred, tenantId: b.tenant_id ?? null, runBy: u.username,
    });
  }

  @Post(':id/post')
  @HttpCode(200)
  @Permissions('gl_close', 'gl_post')
  post(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.postProvision({ id, postedBy: u.username }, u, b?.self_approval_reason);
  }
}
