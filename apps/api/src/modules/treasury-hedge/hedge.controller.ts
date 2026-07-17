import { Controller, Get, Post, Body, Param, HttpCode, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { HedgeService } from './hedge.service';

const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
const acctRe = /^\d{3,10}$/;

const HedgeBody = z.object({
  hedged_item: z.string().min(1),
  hedging_instrument: z.string().min(1),
  hedge_type: z.enum(['CASH_FLOW', 'FAIR_VALUE']).optional(),
  hedge_ratio: z.number().positive().optional(),
  notional: z.number().min(0).optional(),
  documentation: z.string().min(1),
  hedged_item_account: z.string().regex(acctRe).optional(),
  reclass_account: z.string().regex(acctRe).optional(),
  currency: z.string().length(3).optional(),
  derivative_fv: z.number().optional(),
  tenant_id: z.number().int().positive().optional(),
});
const EffectivenessBody = z.object({
  test_type: z.enum(['prospective', 'retrospective']).optional(),
  method: z.enum(['dollar_offset', 'regression', 'critical_terms']).optional(),
  ratio_pct: z.number(),
  effective: z.boolean(),
  as_of: z.string().regex(ymdRe).optional(),
  notes: z.string().optional(),
});
const MeasureBody = z.object({
  fair_value: z.number(),
  as_of: z.string().regex(ymdRe).optional(),
  effective_portion: z.number().optional(),
  hedged_item_delta: z.number().optional(),
  to_pl: z.boolean().optional(),
});
const RebalanceBody = z.object({
  hedge_ratio: z.number().positive().optional(),
  notional: z.number().min(0).optional(),
  documentation: z.string().min(1).optional(),
});
const ReclassifyBody = z.object({
  amount: z.number().positive(),
  as_of: z.string().regex(ymdRe).optional(),
  reclass_account: z.string().regex(acctRe).optional(),
});

type HedgeBodyT = z.infer<typeof HedgeBody>;
type EffectivenessBodyT = z.infer<typeof EffectivenessBody>;
type MeasureBodyT = z.infer<typeof MeasureBody>;
type RebalanceBodyT = z.infer<typeof RebalanceBody>;
type ReclassifyBodyT = z.infer<typeof ReclassifyBody>;

// Hedge accounting register (Track C Wave 3) — TRE-04 designation + effectiveness + valuation maker-checker.
// Maker endpoints (designate a relationship, rebalance) gate `treasury OR exec`; checker + valuation endpoints
// (approve, record an effectiveness test, remeasure the derivative, reclassify OCI) gate `treasury_approve OR
// exec`; reads open to either + `fin_report`. The creator ≠ approver block is the SoD control (403
// SOD_SELF_APPROVAL); no OCI accounting until Approved AND effective is the valuation control (HEDGE_NOT_EFFECTIVE
// / HEDGE_NOT_DESIGNATED). Routes sit under /api/treasury/hedges alongside the Wave-1 debt + Wave-2 investment
// registers (no path clash).
@Controller('api/treasury')
export class HedgeController {
  constructor(private readonly svc: HedgeService) {}

  // ── Reads ──
  @Get('hedges')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  listHedges() { return this.svc.listHedges(); }

  @Get('hedges/:id')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  getHedge(@Param('id', ParseIntPipe) id: number) { return this.svc.getHedge(id); }

  // ── Maker (treasury) ──
  @Post('hedges')
  @HttpCode(200)
  @Permissions('treasury', 'exec')
  designate(@Body(new ZodValidationPipe(HedgeBody)) b: HedgeBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.designate({
      hedgedItem: b.hedged_item, hedgingInstrument: b.hedging_instrument, hedgeType: b.hedge_type,
      hedgeRatio: b.hedge_ratio, notional: b.notional, documentation: b.documentation,
      hedgedItemAccount: b.hedged_item_account, reclassAccount: b.reclass_account, currency: b.currency,
      derivativeFv: b.derivative_fv, tenantId: u.role === 'Admin' ? (b.tenant_id ?? null) : null,
    }, u);
  }

  @Post('hedges/:id/rebalance')
  @HttpCode(200)
  @Permissions('treasury', 'exec')
  rebalance(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RebalanceBody)) b: RebalanceBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.rebalance(id, { hedgeRatio: b.hedge_ratio, notional: b.notional, documentation: b.documentation }, u);
  }

  // ── Checker (treasury_approve) ──
  @Post('hedges/:id/approve')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) { return this.svc.approve(id, u, b?.self_approval_reason); }

  @Post('hedges/:id/reject')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  reject(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) { return this.svc.reject(id, u); }

  @Post('hedges/:id/effectiveness')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  effectiveness(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(EffectivenessBody)) b: EffectivenessBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.recordEffectiveness(id, { testType: b.test_type, method: b.method, ratioPct: b.ratio_pct, effective: b.effective, asOf: b.as_of, notes: b.notes }, u);
  }

  @Post('hedges/:id/measure')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  measure(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(MeasureBody)) b: MeasureBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.measure(id, { fairValue: b.fair_value, asOf: b.as_of, effectivePortion: b.effective_portion, hedgedItemDelta: b.hedged_item_delta, toPl: b.to_pl }, u);
  }

  @Post('hedges/:id/reclassify')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  reclassify(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ReclassifyBody)) b: ReclassifyBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.reclassify(id, { amount: b.amount, asOf: b.as_of, reclassAccount: b.reclass_account }, u);
  }
}
