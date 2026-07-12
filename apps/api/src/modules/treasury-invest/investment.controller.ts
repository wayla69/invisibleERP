import { Controller, Get, Post, Body, Param, Query, HttpCode, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { InvestmentService } from './investment.service';

const ymdRe = /^\d{4}-\d{2}-\d{2}$/;

const InvestmentBody = z.object({
  instrument: z.string().min(1),
  instrument_type: z.enum(['bond', 'equity', 'fund']).optional(),
  symbol: z.string().min(1).optional(),
  classification: z.enum(['AMORTIZED_COST', 'FVOCI', 'FVTPL']).optional(),
  currency: z.string().length(3).optional(),
  quantity: z.number().positive().optional(),
  cost: z.number().positive(),
  eir_pct: z.number().min(0).max(100).optional(),
  trade_date: z.string().regex(ymdRe).optional(),
  maturity_date: z.string().regex(ymdRe).optional(),
  tenant_id: z.number().int().positive().optional(),
});
const PriceBody = z.object({
  symbol: z.string().min(1),
  price_date: z.string().regex(ymdRe),
  price: z.number().positive(),
  source: z.string().min(1).optional(),
  tenant_id: z.number().int().positive().optional(),
});
const PriceApproveBody = z.object({
  symbol: z.string().min(1),
  price_date: z.string().regex(ymdRe),
  tenant_id: z.number().int().positive().optional(),
});
const RevalueBody = z.object({ as_of: z.string().regex(ymdRe).optional() });
const ImpairBody = z.object({ ecl: z.number().positive(), as_of: z.string().regex(ymdRe).optional() });
const AccrueBody = z.object({ as_of: z.string().regex(ymdRe).optional(), amount: z.number().positive().optional() });

type InvestmentBodyT = z.infer<typeof InvestmentBody>;
type PriceBodyT = z.infer<typeof PriceBody>;
type PriceApproveBodyT = z.infer<typeof PriceApproveBody>;
type RevalueBodyT = z.infer<typeof RevalueBody>;
type ImpairBodyT = z.infer<typeof ImpairBody>;
type AccrueBodyT = z.infer<typeof AccrueBody>;

// Investment & Securities register (Track C Wave 2) — TRE-03 classification + valuation maker-checker. Maker
// endpoints (create investment, post price) gate `treasury OR exec`; checker + valuation endpoints (approve
// investment/price, revalue/MTM, impair/ECL, accrue) gate `treasury_approve OR exec`; reads open to either +
// `fin_report`. The in-app creator ≠ approver block is the real SoD control (403 SOD_SELF_APPROVAL); MTM only
// from an APPROVED price is the valuation control (NO_APPROVED_PRICE). Routes sit under /api/treasury/* alongside
// the Wave-1 debt register (no path clash: investments/prices/portfolio vs facilities/covenants).
@Controller('api/treasury')
export class InvestmentController {
  constructor(private readonly svc: InvestmentService) {}

  // ── Reads ──
  @Get('investments')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  listInvestments() { return this.svc.listInvestments(); }

  @Get('portfolio')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  portfolio() { return this.svc.portfolio(); }

  @Get('prices')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  listPrices(@CurrentUser() u: JwtUser, @Query('symbol') symbol?: string, @Query('status') status?: string) { return this.svc.listPrices({ symbol, status }, u); }

  @Get('investments/:id')
  @Permissions('treasury', 'treasury_approve', 'fin_report', 'exec')
  getInvestment(@Param('id', ParseIntPipe) id: number) { return this.svc.getInvestment(id); }

  // ── Maker (treasury) ──
  @Post('investments')
  @HttpCode(200)
  @Permissions('treasury', 'exec')
  createInvestment(@Body(new ZodValidationPipe(InvestmentBody)) b: InvestmentBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.createInvestment({
      instrument: b.instrument, instrumentType: b.instrument_type, symbol: b.symbol, classification: b.classification,
      currency: b.currency, quantity: b.quantity, cost: b.cost, eirPct: b.eir_pct, tradeDate: b.trade_date,
      maturityDate: b.maturity_date, tenantId: b.tenant_id ?? null,
    }, u);
  }

  @Post('prices')
  @HttpCode(200)
  @Permissions('treasury', 'exec')
  postPrice(@Body(new ZodValidationPipe(PriceBody)) b: PriceBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.postPrice({ symbol: b.symbol, priceDate: b.price_date, price: b.price, source: b.source, tenantId: b.tenant_id ?? null }, u);
  }

  // ── Checker (treasury_approve) ──
  @Post('investments/:id/approve')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  approveInvestment(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) { return this.svc.approveInvestment(id, u); }

  @Post('investments/:id/reject')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  rejectInvestment(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) { return this.svc.rejectInvestment(id, u); }

  @Post('prices/approve')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  approvePrice(@Body(new ZodValidationPipe(PriceApproveBody)) b: PriceApproveBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.approvePrice(b.symbol, b.price_date, b.tenant_id ?? null, u);
  }

  @Post('prices/reject')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  rejectPrice(@Body(new ZodValidationPipe(PriceApproveBody)) b: PriceApproveBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.rejectPrice(b.symbol, b.price_date, b.tenant_id ?? null, u);
  }

  @Post('investments/:id/revalue')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  revalue(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RevalueBody)) b: RevalueBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.revalue(id, { asOf: b.as_of }, u);
  }

  @Post('investments/:id/impair')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  impair(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ImpairBody)) b: ImpairBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.impair(id, { ecl: b.ecl, asOf: b.as_of }, u);
  }

  @Post('investments/:id/accrue')
  @HttpCode(200)
  @Permissions('treasury_approve', 'exec')
  accrue(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(AccrueBody)) b: AccrueBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.accrue(id, { asOf: b.as_of, amount: b.amount }, u);
  }
}
