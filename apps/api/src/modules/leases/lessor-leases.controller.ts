import { Controller, Get, Post, Query, Body, Param, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { LessorLeasesService, type LessorLeaseDto } from './lessor-leases.service';

const LessorLeaseBody = z.object({
  name: z.string().min(1),
  lessee: z.string().optional(),
  term_months: z.number().int().positive(),
  monthly_payment: z.number().positive(),
  annual_rate_pct: z.number().nonnegative().optional(),
  asset_cost: z.number().positive(),
  fair_value: z.number().positive().optional(),
  economic_life_months: z.number().int().positive().optional(),
  transfer_ownership: z.boolean().optional(),
  bargain_purchase: z.boolean().optional(),
  tenant_id: z.number().optional(),
  start_date: z.string().optional(),
});

// Lessor-side lease accounting (IFRS 16 / TFRS 16 lessor) — control LSE-02 (FIN-10). gl_post books the GL
// effect (finance-lease commencement + periodic income); classification + commencement is maker-checker.
@Controller('api/lessor-leases')
@Permissions('gl_post', 'exec')
export class LessorLeasesController {
  constructor(private readonly svc: LessorLeasesService) {}

  private toDto(b: z.infer<typeof LessorLeaseBody>, u: JwtUser): LessorLeaseDto {
    return {
      name: b.name, lessee: b.lessee, termMonths: b.term_months, monthlyPayment: b.monthly_payment,
      annualRatePct: b.annual_rate_pct, assetCost: b.asset_cost, fairValue: b.fair_value,
      economicLifeMonths: b.economic_life_months, transferOwnership: b.transfer_ownership, bargainPurchase: b.bargain_purchase,
      tenantId: u.role === 'Admin' ? (b.tenant_id ?? null) : null, startDate: b.start_date,
    };
  }

  // Preview the finance-vs-operating classification without persisting.
  @Post('classify')
  @HttpCode(200)
  classify(@Body(new ZodValidationPipe(LessorLeaseBody)) b: z.infer<typeof LessorLeaseBody>, @CurrentUser() u: JwtUser) {
    return this.svc.previewClassification(this.toDto(b, u));
  }

  // Create the lessor lease as PENDING (classification proposed, no GL). A different user must approve it.
  @Post()
  create(@Body(new ZodValidationPipe(LessorLeaseBody)) b: z.infer<typeof LessorLeaseBody>, @CurrentUser() u: JwtUser) {
    return this.svc.createLease(this.toDto(b, u), u);
  }

  @Get()
  @Permissions('gl_post', 'gl_close', 'exec')
  list(@Query('tenant_id') tenantId?: string) { return this.svc.listLeases(tenantId ? Number(tenantId) : undefined); }

  // LSE-02 — net-investment reconciliation: GL 1610 vs the remaining finance-lease receivable on the schedule.
  @Get('receivable-reconciliation')
  @Permissions('gl_post', 'gl_close', 'exec')
  reconcile(@Query('tenant_id') tenantId?: string) { return this.svc.reconcileReceivable(tenantId ? Number(tenantId) : undefined); }

  // Maker-checker: a DIFFERENT user approves the classification → books commencement (LSE-02).
  @Post(':leaseNo/approve')
  @HttpCode(200)
  approve(@Param('leaseNo') leaseNo: string, @CurrentUser() u: JwtUser) { return this.svc.approveLease(leaseNo, u); }

  // Post every due lessor-lease period now (cron-callable).
  @Post('run')
  @HttpCode(200)
  run(@CurrentUser() u: JwtUser) { return this.svc.runDueLeases(u); }
}
