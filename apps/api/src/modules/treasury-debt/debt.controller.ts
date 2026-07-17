import { Controller, Get, Post, Body, Param, Query, HttpCode, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { DebtService } from './debt.service';

const FacilityBody = z.object({
  name: z.string().min(1),
  lender: z.string().optional(),
  currency: z.string().length(3).optional(),
  facility_type: z.enum(['short_term', 'long_term']).optional(),
  limit_amount: z.number().positive(),
  eir_pct: z.number().min(0).max(100).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  maturity_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tenant_id: z.number().int().positive().optional(),
});
const DrawdownBody = z.object({
  principal: z.number().positive(),
  rate_pct: z.number().min(0).max(100).optional(),
  drawdown_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const RepayBody = z.object({
  principal: z.number().min(0).optional(),
  interest: z.number().min(0).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  drawdown_id: z.number().int().positive().optional(),
});
const AccrueBody = z.object({ as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const CovenantBody = z.object({
  name: z.string().min(1),
  metric: z.string().min(1),
  operator: z.enum(['gte', 'lte', 'gt', 'lt']).optional(),
  threshold: z.number(),
  cadence: z.enum(['monthly', 'quarterly', 'annual']).optional(),
});
const CovenantTestBody = z.object({
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tests: z.array(z.object({ covenant_id: z.number().int().positive(), value: z.number(), note: z.string().optional() })).min(1),
});
type FacilityBodyT = z.infer<typeof FacilityBody>;
type DrawdownBodyT = z.infer<typeof DrawdownBody>;
type RepayBodyT = z.infer<typeof RepayBody>;
type AccrueBodyT = z.infer<typeof AccrueBody>;
type CovenantBodyT = z.infer<typeof CovenantBody>;
type CovenantTestBodyT = z.infer<typeof CovenantTestBody>;

// Debt & Borrowings register (Track C Wave 1) — TRE-01 facility/drawdown maker-checker + idempotent EIR
// amortized-cost accrual; TRE-02 covenant-breach monitor. Maker endpoints gate `treasury OR exec`; checker
// endpoints (approve / accrue / covenant test) gate `treasury_approve OR exec`; reads open to either +
// fin_report. The in-app creator ≠ approver block is the real SoD control (403 SOD_SELF_APPROVAL).
@Controller('api/treasury')
export class DebtController {
  constructor(private readonly svc: DebtService) {}

  // ── Reads ──
  @Get('facilities')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  listFacilities() { return this.svc.listFacilities(); }

  @Get('facilities/maturity-ladder')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  maturityLadder(@Query('as_of') asOf?: string) { return this.svc.maturityLadder(undefined, asOf); }

  @Get('facilities/:id')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  getFacility(@Param('id', ParseIntPipe) id: number) { return this.svc.getFacility(id); }

  @Get('covenants')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  listCovenants() { return this.svc.listCovenants(); }

  @Get('covenants/breaches')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  breaches() { return this.svc.covenantBreaches(); }

  // ── Maker (treasury) ──
  @Post('facilities')
  @HttpCode(200)
  @Permissions('treasury', 'exec')
  createFacility(@Body(new ZodValidationPipe(FacilityBody)) b: FacilityBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.createFacility({
      name: b.name, lender: b.lender, currency: b.currency, facilityType: b.facility_type,
      limitAmount: b.limit_amount, eirPct: b.eir_pct, startDate: b.start_date, maturityDate: b.maturity_date, tenantId: u.role === 'Admin' ? (b.tenant_id ?? null) : null,
    }, u);
  }

  @Post('facilities/:id/drawdown')
  @HttpCode(200)
  @Permissions('treasury', 'exec')
  drawdown(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(DrawdownBody)) b: DrawdownBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.drawdown(id, { principal: b.principal, ratePct: b.rate_pct, drawdownDate: b.drawdown_date }, u);
  }

  @Post('facilities/:id/repay')
  @HttpCode(200)
  @Permissions('treasury', 'exec')
  repay(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RepayBody)) b: RepayBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.repay(id, { principal: b.principal, interest: b.interest, date: b.date, drawdownId: b.drawdown_id }, u);
  }

  @Post('facilities/:id/covenants')
  @HttpCode(200)
  @Permissions('treasury', 'exec')
  createCovenant(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(CovenantBody)) b: CovenantBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.createCovenant(id, { name: b.name, metric: b.metric, operator: b.operator, threshold: b.threshold, cadence: b.cadence }, u);
  }

  // ── Checker (treasury_approve) ──
  @Post('facilities/:id/approve')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  approveFacility(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) { return this.svc.approveFacility(id, u, b?.self_approval_reason); }

  @Post('facilities/:id/reject')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  rejectFacility(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) { return this.svc.rejectFacility(id, u); }

  @Post('facilities/:id/accrue')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  accrue(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(AccrueBody)) b: AccrueBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.accrue(id, u, b.as_of);
  }

  @Post('covenants/test')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  testCovenants(@Body(new ZodValidationPipe(CovenantTestBody)) b: CovenantTestBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.testCovenants({ asOf: b.as_of, tests: b.tests.map((t) => ({ covenantId: t.covenant_id, value: t.value, note: t.note })) }, u);
  }
}
