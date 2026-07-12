import { Controller, Get, Post, Param, Body, Query, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RevFinancingService } from './rev-financing.service';
import { RevDisclosureService } from './rev-disclosure.service';

const FinancingBody = z.object({
  discount_rate_pct: z.number().positive(),
  periods: z.number().int().positive(),
  direction: z.enum(['advance', 'arrears']).optional(),
  material: z.boolean().optional(),
  nominal: z.number().positive().optional(),
  start_period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  note: z.string().optional(),
});
type FinancingBodyT = z.infer<typeof FinancingBody>;
const RunBody = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional(), date: z.string().optional() });
type RunBodyT = z.infer<typeof RunBody>;

// Track D — Wave 4 (REV-27, FINAL): significant financing component (TFRS 15 §60-65) + revenue disclosure pack
// (§120). Extends the REV-19 contract at /api/revenue/contracts/:id (financing) and adds the read-only
// disclosure aggregators at /api/revenue/disclosure/*. Gated with the same exec/ar/fin_report duties (no new
// duty). The discount-rate maker-checker (SoD) is enforced in RevFinancingService.
@Controller('api/revenue')
@Permissions('exec', 'ar', 'fin_report')
export class RevDisclosureController {
  constructor(
    private readonly financing: RevFinancingService,
    private readonly disclosure: RevDisclosureService,
  ) {}

  // ── (A) Significant financing component (§60-65) ──
  // Maker: flag a material financing component + set the discount rate → discount the price to PV + schedule
  // the interest unwind (Pending — drives nothing until approved).
  @Post('contracts/:id/financing-component')
  setFinancing(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(FinancingBody)) b: FinancingBodyT, @CurrentUser() u: JwtUser) {
    return this.financing.setFinancingComponent(id, b, u);
  }

  // Checker (≠ maker → 403 SOD_SELF_APPROVAL): approve the discount-rate judgement so it may post.
  @Post('contracts/:id/financing-component/approve')
  approveFinancing(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.financing.approveFinancingComponent(id, u);
  }

  @Get('contracts/:id/financing-component')
  getFinancing(@Param('id', ParseIntPipe) id: number) {
    return this.financing.getFinancingComponent(id);
  }

  // Post the periodic interest unwind for the Approved schedule due through the period (idempotent).
  @Post('contracts/:id/run-financing')
  runFinancing(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RunBody)) b: RunBodyT, @CurrentUser() u: JwtUser) {
    return this.financing.runFinancing(id, b, u);
  }

  // ── (B) Disclosure pack (§120) — read-only aggregators ──
  @Get('disclosure/contract-liability-rollforward')
  rollforward(@Query('period') period: string, @Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) {
    return this.disclosure.contractLiabilityRollforward(period, u, tenantId != null ? Number(tenantId) : null);
  }

  @Get('disclosure/rpo')
  rpo(@Query('as_of') asOf: string | undefined, @Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) {
    return this.disclosure.rpo(u, { asOf, explicitTenantId: tenantId != null ? Number(tenantId) : null });
  }
}
