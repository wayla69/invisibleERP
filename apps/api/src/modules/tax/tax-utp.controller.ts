import { Controller, Get, Post, Body, Param, HttpCode, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { TaxUtpService } from './tax-utp.service';

// TAX-12 — DTA valuation allowance (MLTN recoverability, maker-checker run→post) + Uncertain Tax Positions
// (FIN 48) register (memo, maker-checker create/settle). Reuses the finance/tax duties (gl_close/gl_post/exec).

const RunVaBody = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM'),
  as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dta_gross: z.number().min(0).optional(),
  mltn_recoverable: z.number().min(0),
  basis: z.string().max(2000).optional(),
  tenant_id: z.number().int().positive().optional(),
});
type RunVaBodyT = z.infer<typeof RunVaBody>;

const CreateUtpBody = z.object({
  tax_year: z.number().int().min(2000).max(2100),
  description: z.string().min(1).max(1000),
  gross_exposure: z.number().min(0),
  recognized_benefit: z.number().min(0).optional(),
  interest_penalty: z.number().min(0).optional(),
  tenant_id: z.number().int().positive().optional(),
});
type CreateUtpBodyT = z.infer<typeof CreateUtpBody>;

const SettleUtpBody = z.object({
  status: z.enum(['Settled', 'Lapsed']).optional(),
  settlement_amount: z.number().min(0).optional(),
  settlement_note: z.string().max(2000).optional(),
  self_approval_reason: z.string().max(500).optional(),
});
type SettleUtpBodyT = z.infer<typeof SettleUtpBody>;

@Controller('api/tax')
export class TaxUtpController {
  constructor(private readonly svc: TaxUtpService) {}

  // ── DTA valuation allowance ──
  @Get('valuation-allowance')
  @Permissions('gl_close', 'gl_post', 'exec')
  listVa() { return this.svc.listValuationAllowances(); }

  @Post('valuation-allowance/run')
  @HttpCode(200)
  @Permissions('gl_close', 'gl_post')
  runVa(@Body(new ZodValidationPipe(RunVaBody)) b: RunVaBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.runValuationAllowance({ period: b.period, asOfDate: b.as_of_date, dtaGross: b.dta_gross, mltnRecoverable: b.mltn_recoverable, basis: b.basis, tenantId: u.role === 'Admin' ? (b.tenant_id ?? null) : null, runBy: u.username });
  }

  @Post('valuation-allowance/:id/post')
  @HttpCode(200)
  @Permissions('gl_close', 'gl_post')
  postVa(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.postValuationAllowance({ id, postedBy: u.username }, u, b?.self_approval_reason);
  }

  // ── Uncertain Tax Positions (FIN 48) ──
  @Get('utp')
  @Permissions('gl_close', 'gl_post', 'exec')
  listUtp() { return this.svc.listUtp(); }

  @Post('utp')
  @Permissions('gl_close', 'gl_post')
  createUtp(@Body(new ZodValidationPipe(CreateUtpBody)) b: CreateUtpBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.createUtp({ taxYear: b.tax_year, description: b.description, grossExposure: b.gross_exposure, recognizedBenefit: b.recognized_benefit, interestPenalty: b.interest_penalty, tenantId: u.role === 'Admin' ? (b.tenant_id ?? null) : null, createdBy: u.username });
  }

  @Post('utp/:id/settle')
  @HttpCode(200)
  @Permissions('gl_close', 'gl_post')
  settleUtp(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(SettleUtpBody)) b: SettleUtpBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.settleUtp({ id, status: b.status, settlementAmount: b.settlement_amount, settlementNote: b.settlement_note, settledBy: u.username }, u, b.self_approval_reason);
  }
}
